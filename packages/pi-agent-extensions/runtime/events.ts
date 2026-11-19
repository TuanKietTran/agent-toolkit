// Typed execution-event contract and the in-memory event log behind every streaming client.
// Pure module: no pi imports, so the contract can be reused by a future remote transport.

export type ExecutionState = "created" | "running" | "waiting_for_tool" | "paused" | "completed" | "failed" | "cancelled";

export type ComputerActionStatus = "started" | "completed" | "failed";

/** Event payloads. Every event corresponds to real runtime activity; nothing here is synthesized for display. */
export type AgentEventBody =
  // Session and lifecycle
  | { type: "session.created"; reason: string; model?: string }
  | { type: "agent.started"; prompt?: string }
  | { type: "agent.state"; state: ExecutionState; previous: ExecutionState; reason?: string }
  | { type: "agent.waiting"; reason: string }
  | { type: "agent.pause_requested" }
  | { type: "agent.paused"; at: "tool_call" | "model_request"; toolCallId?: string; toolName?: string }
  | { type: "agent.resumed" }
  | { type: "agent.instruction"; delivery: "prompt" | "steer" | "followUp"; text: string }
  | { type: "agent.completed"; summary?: string }
  | { type: "agent.failed"; error: string }
  | { type: "agent.cancelled"; reason?: string }
  | { type: "activity.updated"; activity: string }
  // Model stream
  | { type: "message.started"; role: string }
  | { type: "message.delta"; content: string }
  | { type: "message.completed"; role: string; text?: string; stopReason?: string; usage?: { input: number; output: number } ; error?: string }
  // Tool stream
  | { type: "tool.requested"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool.started"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool.progress"; toolCallId: string; toolName: string; message?: string; progress?: number }
  | { type: "tool.completed"; toolCallId: string; toolName: string; durationMs: number; summary?: string; verified?: boolean }
  | { type: "tool.failed"; toolCallId: string; toolName: string; durationMs: number; error: string }
  /** Requested by the model but never started (the run was cancelled or ended first); the action was not performed. */
  | { type: "tool.skipped"; toolCallId: string; toolName: string; reason: string }
  // Computer-use stream (reported by browser/computer tools through tool updates)
  | { type: "computer.action"; toolCallId: string; action: string; status: ComputerActionStatus; target?: string; detail?: string }
  | { type: "computer.observation"; toolCallId: string; url?: string; title?: string; navigated?: boolean; verified?: boolean; evidence?: string }
  // Artifacts
  | { type: "artifact.created"; artifactId: string; kind: "screenshot" | "image" | "file"; mimeType: string; bytes: number; toolCallId?: string };

export type AgentEventType = AgentEventBody["type"];

export interface EventEnvelope {
  /** Globally unique event id: `<logId>:<seq>`. */
  id: string;
  /** Monotonic per-log sequence number; gaps mean events were dropped from the replay window. */
  seq: number;
  /** Milliseconds since epoch. */
  ts: number;
  sessionId?: string;
  executionId?: string;
  parentExecutionId?: string;
}

export type AgentEvent = EventEnvelope & AgentEventBody;

/** Shape that browser/computer tools put in `details.runtimeEvent` of a tool update. */
export type ToolRuntimeEvent =
  | { kind: "computer.action"; action: string; status: ComputerActionStatus; target?: string; detail?: string }
  | { kind: "computer.observation"; url?: string; title?: string; navigated?: boolean; verified?: boolean; evidence?: string }
  | { kind: "progress"; message: string; progress?: number };

export function isToolRuntimeEvent(value: unknown): value is ToolRuntimeEvent {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "computer.action" || kind === "computer.observation" || kind === "progress";
}

export type Subscriber = (event: AgentEvent) => void;

export interface ReplayResult {
  events: AgentEvent[];
  /** True when the requested position is older than the retained window, so the client must resync. */
  truncated: boolean;
}

/**
 * Bounded, ordered event log. Appends are synchronous and assign a strictly increasing `seq`,
 * so subscribers observe events in exactly the order they were produced. Subscribers that throw
 * are isolated (the error is counted, the event still reaches everyone else).
 */
export class EventLog {
  readonly logId: string;
  private readonly capacity: number;
  private buffer: AgentEvent[] = [];
  private seq = 0;
  private subscribers = new Set<Subscriber>();
  subscriberErrors = 0;

  constructor(opts?: { capacity?: number; logId?: string }) {
    this.capacity = Math.max(16, opts?.capacity ?? 2000);
    this.logId = opts?.logId ?? Math.random().toString(36).slice(2, 10);
  }

  get lastSeq(): number { return this.seq; }
  get oldestSeq(): number { return this.buffer[0]?.seq ?? this.seq + 1; }
  get size(): number { return this.buffer.length; }

  append(body: AgentEventBody, envelope?: Partial<Omit<EventEnvelope, "id" | "seq">>): AgentEvent {
    const seq = ++this.seq;
    const event = { id: `${this.logId}:${seq}`, seq, ts: envelope?.ts ?? Date.now(), ...stripUndefined(envelope ?? {}), ...body } as AgentEvent;
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
    for (const subscriber of [...this.subscribers]) {
      try { subscriber(event); } catch { this.subscriberErrors++; }
    }
    return event;
  }

  /** Events with seq > `afterSeq`. */
  since(afterSeq: number): ReplayResult {
    if (afterSeq >= this.seq) return { events: [], truncated: false };
    const truncated = afterSeq + 1 < this.oldestSeq;
    return { events: this.buffer.filter((e) => e.seq > afterSeq), truncated };
  }

  all(): AgentEvent[] { return [...this.buffer]; }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Parses `Last-Event-ID` / `?since=` values: accepts `<logId>:<seq>` or a bare seq. A different logId means "replay everything". */
export function parseResumePoint(value: string | null | undefined, logId: string): number | undefined {
  if (!value) return undefined;
  const m = /^(?:([^:]+):)?(\d+)$/.exec(value.trim());
  if (!m) return undefined;
  if (m[1] && m[1] !== logId) return 0;
  return Number(m[2]);
}

/** One SSE frame. `id:` lets EventSource clients resume with Last-Event-ID. */
export function sseFrame(event: AgentEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Text the model receives for a tool call that never started. */
export const NOT_EXECUTED_TEXT = "Not executed: this tool call was never started because the run was interrupted before it. Its action was NOT performed.";

type ToolCallBlock = { type: string; id?: string; name?: string };
type ContextMessage = { role?: string; content?: unknown; toolCallId?: string };

/**
 * Inserts an explicit error result for every tool call that has no result (a batch cut short by a
 * cancel). Without it the model either sees nothing (custom providers) or a generic "No result provided"
 * that does not say whether the action happened. Returns undefined when nothing needs changing.
 */
export function closeOrphanToolCalls<T extends ContextMessage>(messages: T[]): T[] | undefined {
  const answered = new Set(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
  const out: T[] = [];
  let changed = false;
  for (let i = 0; i < messages.length; i++) {
    out.push(messages[i]);
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const orphans = (m.content as ToolCallBlock[]).filter((c) => c?.type === "toolCall" && c.id && !answered.has(c.id));
    if (!orphans.length) continue;
    // Keep existing results for this message first, then the synthetic ones, before the next turn.
    while (i + 1 < messages.length && messages[i + 1].role === "toolResult") out.push(messages[++i]);
    for (const c of orphans) out.push({ role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: NOT_EXECUTED_TEXT }], isError: true, timestamp: Date.now() } as unknown as T);
    changed = true;
  }
  return changed ? out : undefined;
}

/** Replaces inline base64 image data with a small placeholder so state snapshots stay bounded. */
export function sanitizeContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part && typeof part === "object" && (part as { type?: string }).type === "image") {
      const p = part as { data?: string; mimeType?: string };
      return { type: "image", mimeType: p.mimeType, bytes: typeof p.data === "string" ? Math.floor(p.data.length * 3 / 4) : 0, omitted: true };
    }
    return part;
  });
}

export function textOf(content: unknown, max = 4000): string {
  if (typeof content === "string") return content.slice(0, max);
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: string }).text ?? "") : "")).filter(Boolean).join("\n").slice(0, max);
}
