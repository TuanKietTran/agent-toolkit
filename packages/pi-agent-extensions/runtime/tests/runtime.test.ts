import assert from "node:assert/strict";
import { test } from "node:test";
import { EventLog, isToolRuntimeEvent, parseResumePoint, sanitizeContent, sseFrame } from "../events.ts";
import { ExecutionStateMachine, InvalidTransitionError, MetricsRecorder, PauseGate, canTransition } from "../lifecycle.ts";
import { createRuntime } from "../runtime.ts";

test("event log: strictly increasing seq, ids carry the log id, subscribers see append order", () => {
  const log = new EventLog({ logId: "L" });
  const seen: number[] = [];
  log.subscribe((e) => seen.push(e.seq));
  for (let i = 0; i < 5; i++) log.append({ type: "message.delta", content: String(i) }, { executionId: "x" });
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.equal(log.all()[2].id, "L:3");
  assert.equal(log.all()[2].executionId, "x");
});

test("event log: replay since a seq, and truncation is reported when the window was exceeded", () => {
  const log = new EventLog({ capacity: 16, logId: "L" });
  for (let i = 0; i < 40; i++) log.append({ type: "activity.updated", activity: String(i) });
  assert.equal(log.size, 16);
  const recent = log.since(35);
  assert.equal(recent.truncated, false);
  assert.deepEqual(recent.events.map((e) => e.seq), [36, 37, 38, 39, 40]);
  const old = log.since(3);
  assert.equal(old.truncated, true);
  assert.equal(old.events[0].seq, 25);
  assert.deepEqual(log.since(40), { events: [], truncated: false });
});

test("event log: a throwing subscriber does not stop delivery to others", () => {
  const log = new EventLog();
  let got = 0;
  log.subscribe(() => { throw new Error("boom"); });
  log.subscribe(() => { got++; });
  log.append({ type: "agent.resumed" });
  assert.equal(got, 1);
  assert.equal(log.subscriberErrors, 1);
});

test("resume points: Last-Event-ID of this log, bare seq, and a foreign log id (replay all)", () => {
  assert.equal(parseResumePoint("L:12", "L"), 12);
  assert.equal(parseResumePoint("7", "L"), 7);
  assert.equal(parseResumePoint("OTHER:99", "L"), 0);
  assert.equal(parseResumePoint("garbage", "L"), undefined);
  assert.equal(parseResumePoint(undefined, "L"), undefined);
});

test("sse frame carries id, event name and the full event", () => {
  const log = new EventLog({ logId: "L" });
  const e = log.append({ type: "tool.started", toolCallId: "c1", toolName: "click" });
  const frame = sseFrame(e);
  assert.match(frame, /^id: L:1\nevent: tool.started\ndata: \{.*"toolCallId":"c1".*\}\n\n$/);
});

test("sanitizeContent replaces base64 images with a size placeholder", () => {
  const out = sanitizeContent([{ type: "text", text: "hi" }, { type: "image", mimeType: "image/png", data: "A".repeat(4000) }]) as any[];
  assert.equal(out[0].text, "hi");
  assert.deepEqual(out[1], { type: "image", mimeType: "image/png", bytes: 3000, omitted: true });
});

test("tool runtime events are recognised structurally", () => {
  assert.equal(isToolRuntimeEvent({ kind: "computer.action", action: "click", status: "started" }), true);
  assert.equal(isToolRuntimeEvent({ kind: "other" }), false);
  assert.equal(isToolRuntimeEvent(null), false);
});

test("state machine: legal path, terminal states, illegal transitions throw", () => {
  const m = new ExecutionStateMachine();
  for (const s of ["running", "waiting_for_tool", "paused", "waiting_for_tool", "running", "completed"] as const) m.transition(s);
  assert.equal(m.terminal, true);
  assert.throws(() => m.transition("running"), InvalidTransitionError);
  assert.equal(canTransition("created", "paused"), false);
  assert.equal(canTransition("paused", "completed"), false, "a paused execution must resume or be cancelled first");
  assert.equal(canTransition("paused", "cancelled"), true);
  assert.equal(m.transition("completed"), undefined, "same-state transition is a no-op");
});

test("pause gate: open passes, paused holds until resume, abort and cancel release", async () => {
  const g = new PauseGate();
  assert.equal(await g.wait(), "open");
  g.pause();
  let held = false;
  const p = g.wait(undefined, () => { held = true; });
  assert.equal(held, true);
  assert.equal(g.waiting, 1);
  g.resume();
  assert.equal(await p, "resumed");
  g.pause();
  const ac = new AbortController();
  const q = g.wait(ac.signal);
  ac.abort();
  assert.equal(await q, "aborted");
  const r = g.wait();
  g.cancel();
  assert.equal(await r, "aborted");
  assert.equal(g.isPaused, false);
});

test("metrics: latency stats, retries of identical calls, verification counts, paused time", () => {
  const m = new MetricsRecorder("ex", 1000);
  m.firstEvent(1010); m.firstToken(1050); m.firstToken(2000);
  m.toolStarted("click", { tab: "t", ref: "e1" }); m.toolEnded("click", 100, false, true);
  m.toolStarted("click", { ref: "e1", tab: "t" }); m.toolEnded("click", 300, false, false);
  m.toolStarted("snapshot", { tab: "t" }); m.toolEnded("snapshot", 50, true);
  m.paused(5000); m.resumed(5600);
  m.end("completed", 9000);
  assert.equal(m.m.timeToFirstEventMs, 10);
  assert.equal(m.m.timeToFirstTokenMs, 50);
  assert.equal(m.m.retries, 1, "argument order does not hide a repeated call");
  assert.equal(m.m.browserActions, 2);
  assert.equal(m.m.verifiedActions, 1);
  assert.equal(m.m.unverifiedActions, 1);
  assert.equal(m.m.toolFailures, 1);
  assert.equal(m.m.toolLatencyMs.max, 300);
  assert.equal(m.m.pausedMs, 600);
  assert.equal(m.m.outcome, "completed");
});

// ---- runtime against a scripted pi event sequence ----

type Handler = (event: any, ctx: any) => unknown;
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const sent: { text: unknown; opts?: unknown }[] = [];
  const pi: any = {
    on(name: string, fn: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    sendUserMessage(text: unknown, opts?: unknown) { sent.push({ text, opts }); },
  };
  const ctrl = new AbortController();
  let idle = true;
  const ctx: any = { sessionManager: { getSessionId: () => "S1" }, model: { provider: "faux", id: "m" }, signal: ctrl.signal, abort: () => ctrl.abort(), isIdle: () => idle };
  const emit = async (name: string, event: any = {}) => { let r: unknown; for (const h of handlers.get(name) ?? []) r = (await h({ type: name, ...event }, ctx)) ?? r; return r; };
  return { pi, ctx, emit, sent, setIdle: (v: boolean) => { idle = v; }, ctrl };
}

test("runtime: maps a pi run to typed events with lifecycle states, tool correlation and artifacts", async () => {
  const rt = createRuntime();
  const { pi, emit } = fakePi();
  rt.attach(pi);
  await emit("session_start", { reason: "startup" });
  await emit("agent_start");
  await emit("message_start", { message: { role: "assistant" } });
  await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
  await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "lo" } });
  await emit("message_update", { assistantMessageEvent: { type: "toolcall_end", toolCall: { id: "c1", name: "screenshot", arguments: { tab: "T", password: "x" } } } });
  await emit("tool_execution_start", { toolCallId: "c1", toolName: "screenshot", args: { tab: "T" } });
  assert.equal(await emit("tool_call", { toolCallId: "c1", toolName: "screenshot" }), undefined);
  await emit("tool_execution_update", { toolCallId: "c1", toolName: "screenshot", partialResult: { details: { runtimeEvent: { kind: "computer.observation", url: "http://x/", evidence: "screenshot captured" } } } });
  await emit("tool_execution_end", { toolCallId: "c1", toolName: "screenshot", isError: false, result: { content: [{ type: "text", text: "shot" }, { type: "image", mimeType: "image/png", data: "QUJD" }], details: { ok: true } } });
  await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }] });
  await emit("agent_settled");
  const events = rt.log.all();
  const types = events.map((e) => e.type);
  assert.deepEqual(types.filter((t) => !t.startsWith("agent.state")), ["session.created", "agent.started", "message.started", "message.delta", "message.delta", "tool.requested", "tool.started", "computer.observation", "artifact.created", "tool.completed", "agent.completed"]);
  const states = events.filter((e) => e.type === "agent.state").map((e) => (e as any).state);
  assert.deepEqual(states, ["running", "waiting_for_tool", "running", "completed"]);
  assert.equal((events.find((e) => e.type === "tool.requested") as any).args.password, "[redacted]");
  const exId = events.find((e) => e.type === "agent.started")!.executionId;
  assert.ok(events.slice(1).every((e) => e.executionId === exId), "every event of the run is correlated to its execution");
  const art = events.find((e) => e.type === "artifact.created") as any;
  assert.equal(art.kind, "screenshot");
  assert.equal(rt.artifact(art.artifactId)?.data, "QUJD");
  const s = rt.status();
  assert.equal(s.state, "idle");
  assert.equal(s.recent[0].outcome, "completed");
});

test("runtime: pause holds the next tool call until resume; cancel while paused blocks the tool", async () => {
  const rt = createRuntime();
  const { pi, emit, ctx } = fakePi();
  rt.attach(pi);
  await emit("session_start", { reason: "startup" });
  await emit("agent_start");
  assert.equal(rt.pause().ok, true);
  await emit("tool_execution_start", { toolCallId: "c1", toolName: "click", args: {} });
  let released = false;
  const held = emit("tool_call", { toolCallId: "c1", toolName: "click" }).then((r) => { released = true; return r; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(released, false, "tool is held while paused");
  assert.equal(rt.status().state, "paused");
  assert.equal(rt.resume().ok, true);
  assert.equal(await held, undefined, "resumed tool runs");
  assert.equal(rt.status().state, "waiting_for_tool");
  await emit("tool_execution_end", { toolCallId: "c1", toolName: "click", isError: false, result: { content: [], details: { ok: true } } });
  // Pause again, then cancel: the held call is blocked and the run ends cancelled.
  rt.pause();
  await emit("tool_execution_start", { toolCallId: "c2", toolName: "click", args: {} });
  const held2 = emit("tool_call", { toolCallId: "c2", toolName: "click" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rt.cancel().ok, true);
  assert.equal(ctx.signal.aborted, true);
  assert.deepEqual(await held2, { block: true, reason: "Cancelled by the user while execution was paused; this tool was not run." });
  await emit("tool_execution_end", { toolCallId: "c2", toolName: "click", isError: true, result: { content: [{ type: "text", text: "blocked" }] } });
  await emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
  await emit("agent_settled");
  const types = rt.log.all().map((e) => e.type);
  assert.ok(types.includes("agent.paused") && types.includes("agent.resumed") && types.includes("agent.cancelled"));
  assert.equal(rt.status().recent[0].outcome, "cancelled");
  assert.ok(rt.status().recent[0].pausedMs >= 0);
});

test("runtime: instructions are routed by state (idle prompt, running steer or follow-up)", async () => {
  const rt = createRuntime();
  const { pi, emit, sent, setIdle } = fakePi();
  rt.attach(pi);
  await emit("session_start", { reason: "startup" });
  assert.equal(rt.instruct("first").delivery, "prompt");
  setIdle(false);
  await emit("agent_start");
  assert.equal(rt.instruct("also this").delivery, "steer");
  assert.equal(rt.instruct("later", "followUp").delivery, "followUp");
  assert.deepEqual(sent.map((s) => (s.opts as any)?.deliverAs ?? "prompt"), ["prompt", "steer", "followUp"]);
  assert.equal(rt.pause().ok, true);
  assert.equal(rt.resume().ok, true);
  assert.equal(rt.resume().ok, false, "resume when not paused is rejected");
});

test("runtime: a model error ends the execution as failed", async () => {
  const rt = createRuntime();
  const { pi, emit } = fakePi();
  rt.attach(pi);
  await emit("session_start", { reason: "startup" });
  await emit("agent_start");
  await emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 500 upstream" }] });
  await emit("agent_settled");
  const failed = rt.log.all().find((e) => e.type === "agent.failed") as any;
  assert.equal(failed.error, "HTTP 500 upstream");
});
