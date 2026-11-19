// Single-agent execution runtime: turns pi's own lifecycle, model-stream and tool events into the
// typed contract in events.ts, owns the explicit state machine, and implements pause/resume/cancel
// at the two points where pi awaits extensions (before a tool executes, before a model request).
import { createWriteStream, type WriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EventLog, closeOrphanToolCalls, isToolRuntimeEvent, textOf, type AgentEvent, type AgentEventBody, type ExecutionState } from "./events.ts";
import { ExecutionStateMachine, MetricsRecorder, PauseGate, type ExecutionMetrics } from "./lifecycle.ts";
import { PI_EVENT } from "../core/events.ts";

const STATE_KEY = Symbol.for("pi.agent-runtime.v1");
const MAX_ARTIFACTS = 24;
const MAX_ARTIFACT_BYTES = 48 * 1024 * 1024;
const MAX_HISTORY = 20;
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|cookie/i;

type Delivery = "prompt" | "steer" | "followUp";

interface ActiveTool { toolCallId: string; toolName: string; startedAt: number; args: unknown }

interface Execution {
  id: string;
  parentId?: string;
  machine: ExecutionStateMachine;
  metrics: MetricsRecorder;
  tools: Map<string, ActiveTool>;
  /** Requested in the model stream but not started yet. */
  requested: Map<string, string>;
  pauseRequested: boolean;
  cancelRequested: boolean;
  holding: number;
  outcome?: { kind: "completed" | "failed" | "cancelled"; error?: string; summary?: string };
}

export interface Artifact { id: string; mimeType: string; data: string; bytes: number; createdAt: number; toolCallId?: string }

export interface ControlResult { ok: boolean; state: ExecutionState | "idle"; executionId?: string; error?: string; delivery?: Delivery }

export interface RuntimeStatus {
  sessionId?: string;
  state: ExecutionState | "idle";
  executionId?: string;
  pauseRequested: boolean;
  holding: boolean;
  activeTools: { toolCallId: string; toolName: string; runningMs: number }[];
  lastSeq: number;
  logId: string;
  metrics?: ExecutionMetrics;
  recent: ExecutionMetrics[];
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  return out;
}

export class AgentRuntime {
  readonly log: EventLog;
  readonly gate = new PauseGate();
  private api?: ExtensionAPI;
  private ctx?: ExtensionContext;
  private sessionId?: string;
  private execution?: Execution;
  private lastExecutionId?: string;
  private recent: ExecutionMetrics[] = [];
  private artifacts = new Map<string, Artifact>();
  private fileLog?: WriteStream;

  constructor(opts?: { capacity?: number; logFile?: string }) {
    this.log = new EventLog({ capacity: opts?.capacity ?? 4000 });
    const file = opts?.logFile ?? process.env.PI_RUNTIME_EVENT_LOG;
    if (file) {
      this.fileLog = createWriteStream(file, { flags: "a", mode: 0o600 });
      this.fileLog.on("error", () => { this.fileLog = undefined; });
      this.log.subscribe((e) => this.fileLog?.write(JSON.stringify(e) + "\n"));
    }
  }

  // ---------- event production ----------

  private emit(body: AgentEventBody): AgentEvent {
    const ex = this.execution;
    if (ex && body.type !== "agent.started" && body.type !== "agent.state") ex.metrics.firstEvent();
    return this.log.append(body, { sessionId: this.sessionId, executionId: ex?.id, parentExecutionId: ex?.parentId });
  }

  private setState(to: ExecutionState, reason?: string): void {
    const ex = this.execution;
    if (!ex) return;
    let previous: ExecutionState | undefined;
    try { previous = ex.machine.transition(to, reason); }
    catch (error) { this.emit({ type: "activity.updated", activity: `state machine rejected: ${(error as Error).message}` }); return; }
    if (previous) this.emit({ type: "agent.state", state: to, previous, ...(reason ? { reason } : {}) });
  }

  private settledState(ex: Execution): ExecutionState { return ex.tools.size > 0 ? "waiting_for_tool" : "running"; }

  private startExecution(): Execution {
    const ex: Execution = {
      id: `ex_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`,
      parentId: this.lastExecutionId,
      machine: new ExecutionStateMachine(),
      metrics: new MetricsRecorder(""),
      tools: new Map(),
      requested: new Map(),
      pauseRequested: false,
      cancelRequested: false,
      holding: 0,
    };
    ex.metrics.m.executionId = ex.id;
    this.execution = ex;
    return ex;
  }

  private finish(kind: "completed" | "failed" | "cancelled", detail?: { error?: string; summary?: string; reason?: string }): void {
    const ex = this.execution;
    if (!ex) return;
    this.setState(kind, detail?.reason);
    if (kind === "completed") this.emit({ type: "agent.completed", ...(detail?.summary ? { summary: detail.summary } : {}) });
    else if (kind === "failed") this.emit({ type: "agent.failed", error: detail?.error ?? "unknown error" });
    else this.emit({ type: "agent.cancelled", ...(detail?.reason ? { reason: detail.reason } : {}) });
    ex.metrics.end(kind);
    this.recent.unshift({ ...ex.metrics.m });
    this.recent = this.recent.slice(0, MAX_HISTORY);
    this.lastExecutionId = ex.id;
    this.execution = undefined;
    // A pause belongs to one execution; a finished run must not leave the next one silently held.
    if (this.gate.isPaused) this.gate.cancel();
  }

  private storeArtifact(data: string, mimeType: string, toolCallId?: string): Artifact {
    const bytes = Math.floor(data.length * 3 / 4);
    const artifact: Artifact = { id: `art_${randomBytes(6).toString("hex")}`, mimeType, data, bytes, createdAt: Date.now(), toolCallId };
    this.artifacts.set(artifact.id, artifact);
    let total = 0;
    for (const a of this.artifacts.values()) total += a.bytes;
    for (const [id, a] of this.artifacts) {
      if (this.artifacts.size <= MAX_ARTIFACTS && total <= MAX_ARTIFACT_BYTES) break;
      this.artifacts.delete(id); total -= a.bytes;
    }
    return artifact;
  }

  artifact(id: string): Artifact | undefined { return this.artifacts.get(id); }

  attach(pi: ExtensionAPI): void {
    this.api = pi;

    pi.on(PI_EVENT.SESSION_START, async (event, ctx) => {
      this.ctx = ctx;
      this.sessionId = ctx.sessionManager.getSessionId();
      this.emit({ type: "session.created", reason: event.reason, ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}) });
    });

    pi.on(PI_EVENT.SESSION_SHUTDOWN, async () => {
      if (this.execution) { this.gate.cancel(); this.finish("cancelled", { reason: "session shutdown" }); }
      this.ctx = undefined;
    });

    pi.on(PI_EVENT.AGENT_START, async (_event, ctx) => {
      this.ctx = ctx;
      if (this.execution && !this.execution.machine.terminal) {
        // pi re-enters the loop for retries, steering and follow-ups before it settles: same execution.
        this.emit({ type: "activity.updated", activity: "continuing" });
        return;
      }
      this.startExecution();
      this.emit({ type: "agent.started" });
      this.setState("running");
    });

    pi.on(PI_EVENT.MESSAGE_START, async (event) => {
      const role = (event.message as { role?: string }).role ?? "unknown";
      if (role === "assistant") this.emit({ type: "message.started", role });
    });

    pi.on(PI_EVENT.MESSAGE_UPDATE, async (event) => {
      const u = event.assistantMessageEvent;
      if (u.type === "text_delta") { this.execution?.metrics.firstToken(); this.emit({ type: "message.delta", content: u.delta }); }
      else if (u.type === "thinking_start") this.emit({ type: "activity.updated", activity: "thinking" });
      else if (u.type === "toolcall_end") {
        this.execution?.requested.set(u.toolCall.id, u.toolCall.name);
        this.emit({ type: "tool.requested", toolCallId: u.toolCall.id, toolName: u.toolCall.name, args: redact(u.toolCall.arguments) });
      }
    });

    pi.on(PI_EVENT.MESSAGE_END, async (event) => {
      const m = event.message as { role?: string; content?: unknown; stopReason?: string; usage?: { input?: number; output?: number }; errorMessage?: string };
      if (m.role !== "assistant") return;
      const text = textOf(m.content);
      this.emit({ type: "message.completed", role: "assistant", ...(text ? { text } : {}), ...(m.stopReason ? { stopReason: m.stopReason } : {}), ...(m.usage ? { usage: { input: m.usage.input ?? 0, output: m.usage.output ?? 0 } } : {}), ...(m.errorMessage ? { error: m.errorMessage } : {}) });
    });

    pi.on(PI_EVENT.TOOL_EXECUTION_START, async (event) => {
      const ex = this.execution;
      ex?.requested.delete(event.toolCallId);
      if (ex) { ex.tools.set(event.toolCallId, { toolCallId: event.toolCallId, toolName: event.toolName, startedAt: Date.now(), args: event.args }); ex.metrics.toolStarted(event.toolName, event.args); }
      this.emit({ type: "tool.started", toolCallId: event.toolCallId, toolName: event.toolName, args: redact(event.args) });
      if (ex && !ex.holding && ex.machine.state !== "paused") this.setState("waiting_for_tool");
    });

    pi.on(PI_EVENT.TOOL_EXECUTION_UPDATE, async (event) => {
      const partial = event.partialResult as { content?: unknown; details?: { runtimeEvent?: unknown } } | undefined;
      const rt = partial?.details?.runtimeEvent;
      if (isToolRuntimeEvent(rt)) {
        if (rt.kind === "computer.action") this.emit({ type: "computer.action", toolCallId: event.toolCallId, action: rt.action, status: rt.status, ...(rt.target ? { target: rt.target } : {}), ...(rt.detail ? { detail: rt.detail } : {}) });
        else if (rt.kind === "computer.observation") this.emit({ type: "computer.observation", toolCallId: event.toolCallId, url: rt.url, title: rt.title, navigated: rt.navigated, verified: rt.verified, evidence: rt.evidence });
        else this.emit({ type: "tool.progress", toolCallId: event.toolCallId, toolName: event.toolName, message: rt.message, ...(rt.progress != null ? { progress: rt.progress } : {}) });
        return;
      }
      const message = textOf(partial?.content, 400);
      this.emit({ type: "tool.progress", toolCallId: event.toolCallId, toolName: event.toolName, ...(message ? { message } : {}) });
    });

    pi.on(PI_EVENT.TOOL_EXECUTION_END, async (event) => {
      const ex = this.execution;
      const active = ex?.tools.get(event.toolCallId);
      const durationMs = active ? Date.now() - active.startedAt : 0;
      const result = event.result as { content?: unknown; details?: { verification?: { verified?: boolean }; ok?: boolean } } | undefined;
      const verified = result?.details?.verification?.verified;
      const failed = event.isError || result?.details?.ok === false;
      if (Array.isArray(result?.content)) {
        for (const part of result.content as { type?: string; data?: string; mimeType?: string }[]) {
          if (part?.type === "image" && typeof part.data === "string") {
            const a = this.storeArtifact(part.data, part.mimeType ?? "image/png", event.toolCallId);
            this.emit({ type: "artifact.created", artifactId: a.id, kind: /screenshot|observe/.test(event.toolName) ? "screenshot" : "image", mimeType: a.mimeType, bytes: a.bytes, toolCallId: event.toolCallId });
          }
        }
      }
      const summary = textOf(result?.content, 300);
      if (failed) this.emit({ type: "tool.failed", toolCallId: event.toolCallId, toolName: event.toolName, durationMs, error: summary || "tool failed" });
      else this.emit({ type: "tool.completed", toolCallId: event.toolCallId, toolName: event.toolName, durationMs, ...(summary ? { summary } : {}), ...(verified != null ? { verified } : {}) });
      if (ex) {
        ex.tools.delete(event.toolCallId);
        ex.metrics.toolEnded(event.toolName, durationMs, failed, verified);
        if (!ex.holding && ex.machine.state === "waiting_for_tool" && ex.tools.size === 0) this.setState("running");
      }
    });

    // The model must learn that calls cut off by a cancel were not performed (see closeOrphanToolCalls).
    pi.on(PI_EVENT.CONTEXT, async (event) => {
      const messages = closeOrphanToolCalls(event.messages as never[]);
      return messages ? { messages } : undefined;
    });

    // Pause point 1: before any tool executes. pi awaits this hook, so holding here holds the tool.
    pi.on(PI_EVENT.TOOL_CALL, async (event, ctx) => {
      const outcome = await this.hold(ctx, "tool_call", event.toolCallId, event.toolName);
      if (outcome === "aborted") return { block: true, reason: "Cancelled by the user while execution was paused; this tool was not run." };
      return undefined;
    });

    // Pause point 2: before the next model request (after tool results, before the agent decides again).
    pi.on(PI_EVENT.BEFORE_PROVIDER_REQUEST, async (_event, ctx) => {
      await this.hold(ctx, "model_request");
      return undefined;
    });

    pi.on(PI_EVENT.AGENT_END, async (event, ctx) => {
      const ex = this.execution;
      if (!ex) return;
      const last = [...event.messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as { stopReason?: string; errorMessage?: string; content?: unknown } | undefined;
      // An abort that lands during tool execution leaves the last assistant message at stopReason "toolUse":
      // the cancel request and the run's abort signal are the authoritative evidence.
      const cancelled = ex.cancelRequested || last?.stopReason === "aborted" || !!ctx.signal?.aborted;
      // Calls the model asked for that never started: say so, so no UI shows them as pending or done.
      for (const [toolCallId, toolName] of ex.requested) this.emit({ type: "tool.skipped", toolCallId, toolName, reason: cancelled ? "the run was cancelled before this call started" : "the run ended before this call started" });
      ex.requested.clear();
      if (cancelled) ex.outcome = { kind: "cancelled" };
      else if (last?.stopReason === "error") ex.outcome = { kind: "failed", error: last.errorMessage ?? "model error" };
      else ex.outcome = { kind: "completed", summary: textOf(last?.content, 500) || undefined };
    });

    pi.on(PI_EVENT.AGENT_SETTLED, async () => {
      const ex = this.execution;
      if (!ex) return;
      const o = ex.outcome ?? { kind: "completed" as const };
      this.finish(o.kind, { error: o.error, summary: o.summary, reason: o.kind === "cancelled" ? "aborted" : undefined });
    });
  }

  private async hold(ctx: ExtensionContext, at: "tool_call" | "model_request", toolCallId?: string, toolName?: string): Promise<"open" | "resumed" | "aborted"> {
    const ex = this.execution;
    if (!this.gate.isPaused || !ex) return "open";
    const outcome = await this.gate.wait(ctx.signal, () => {
      ex.holding++;
      ex.metrics.paused();
      this.setState("paused", at);
      this.emit({ type: "agent.paused", at, ...(toolCallId ? { toolCallId } : {}), ...(toolName ? { toolName } : {}) });
    });
    if (outcome === "open") return outcome;
    ex.holding = Math.max(0, ex.holding - 1);
    if (outcome === "resumed" && ex.holding === 0 && this.execution === ex) {
      ex.metrics.resumed();
      this.setState(at === "tool_call" ? "waiting_for_tool" : this.settledState(ex));
    }
    return outcome;
  }

  // ---------- control surface ----------

  private stateName(): ExecutionState | "idle" { return this.execution?.machine.state ?? "idle"; }

  pause(): ControlResult {
    const ex = this.execution;
    if (!ex) return { ok: false, state: "idle", error: "nothing is running" };
    if (!this.gate.isPaused) {
      this.gate.pause();
      ex.pauseRequested = true;
      this.emit({ type: "agent.pause_requested" });
    }
    return { ok: true, state: this.stateName(), executionId: ex.id };
  }

  resume(): ControlResult {
    const ex = this.execution;
    if (!this.gate.isPaused) return { ok: false, state: this.stateName(), executionId: ex?.id, error: "not paused" };
    if (ex) ex.pauseRequested = false;
    this.emit({ type: "agent.resumed" });
    this.gate.resume();
    return { ok: true, state: this.stateName(), executionId: ex?.id };
  }

  cancel(reason = "cancelled by user"): ControlResult {
    const ex = this.execution;
    if (!ex) return { ok: false, state: "idle", error: "nothing is running" };
    ex.cancelRequested = true;
    this.emit({ type: "agent.waiting", reason: `cancelling: ${reason}` });
    this.gate.cancel();
    try { this.ctx?.abort(); }
    catch (error) { return { ok: false, state: this.stateName(), executionId: ex.id, error: `abort failed: ${(error as Error).message}` }; }
    return { ok: true, state: this.stateName(), executionId: ex.id };
  }

  /** Routes an instruction by state: idle -> new prompt; active -> steer (default) or follow-up. */
  instruct(text: string, mode?: "steer" | "followUp"): ControlResult {
    if (!this.api || !this.ctx) return { ok: false, state: this.stateName(), error: "pi session is unavailable" };
    const idle = !this.execution && this.ctx.isIdle();
    const delivery: Delivery = idle ? "prompt" : mode === "followUp" ? "followUp" : "steer";
    if (delivery === "prompt") this.api.sendUserMessage(text);
    else this.api.sendUserMessage(text, { deliverAs: delivery });
    this.emit({ type: "agent.instruction", delivery, text: text.slice(0, 2000) });
    return { ok: true, state: this.stateName(), executionId: this.execution?.id, delivery };
  }

  status(): RuntimeStatus {
    const ex = this.execution;
    return {
      sessionId: this.sessionId,
      state: this.stateName(),
      executionId: ex?.id,
      pauseRequested: !!ex?.pauseRequested,
      holding: (ex?.holding ?? 0) > 0,
      activeTools: ex ? [...ex.tools.values()].map((t) => ({ toolCallId: t.toolCallId, toolName: t.toolName, runningMs: Date.now() - t.startedAt })) : [],
      lastSeq: this.log.lastSeq,
      logId: this.log.logId,
      metrics: ex ? { ...ex.metrics.m } : this.recent[0],
      recent: this.recent,
    };
  }

  get context(): ExtensionContext | undefined { return this.ctx; }
  get extensionApi(): ExtensionAPI | undefined { return this.api; }
  get busy(): boolean { return !!this.execution; }
}

/** One runtime per pi process; survives `/reload` so streaming clients keep their sequence numbers. */
export function getRuntime(): AgentRuntime {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: AgentRuntime };
  g[STATE_KEY] ??= new AgentRuntime();
  return g[STATE_KEY];
}

/** Test hook: a fresh runtime (does not touch the process-wide singleton). */
export function createRuntime(opts?: { capacity?: number; logFile?: string }): AgentRuntime { return new AgentRuntime(opts); }
