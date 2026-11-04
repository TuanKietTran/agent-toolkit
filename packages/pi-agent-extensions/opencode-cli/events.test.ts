import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEvent,
  buildPermissions,
  dedupeCalls,
  extractTextToolCalls,
  newUsage,
  parseEventLine,
} from "./events.ts";

// Lines captured from `opencode run --format json` (opencode 2.2.5).
const STEP_START = '{"type":"step_start","timestamp":1,"sessionID":"ses_a","part":{"type":"step-start"}}';
const TEXT = '{"type":"text","timestamp":2,"sessionID":"ses_a","part":{"type":"text","text":"pong","time":{"start":1,"end":2}}}';
const STEP_FINISH = '{"type":"step_finish","timestamp":3,"sessionID":"ses_a","part":{"type":"step-finish","reason":"tool-calls","cost":0.5,"tokens":{"input":100,"output":3,"reasoning":7,"cache":{"read":20,"write":4}}}}';
const ERROR = '{"type":"error","timestamp":4,"error":{"type":"provider.free-limit","message":"Free usage limit reached.","status":429,"retryAfterMs":51594000}}';

test("text and unknown events", () => {
  const usage = newUsage();
  assert.deepEqual(applyEvent(parseEventLine(TEXT), usage), { kind: "text", text: "pong" });
  assert.deepEqual(applyEvent(parseEventLine(STEP_START), usage), { kind: "none" });
  assert.deepEqual(applyEvent({ type: "future_event" }, usage), { kind: "none" });
  assert.equal(parseEventLine("not json"), undefined);
  assert.equal(parseEventLine(""), undefined);
});

test("step_finish accumulates usage across steps", () => {
  const usage = newUsage();
  assert.deepEqual(applyEvent(parseEventLine(STEP_FINISH), usage), { kind: "stepFinish", reason: "tool-calls" });
  applyEvent(parseEventLine(STEP_FINISH), usage);
  assert.deepEqual(usage, { input: 200, output: 6, reasoning: 14, cacheRead: 40, cacheWrite: 8, cost: 1 });
});

test("error events surface the message and the retry window", () => {
  const action = applyEvent(parseEventLine(ERROR), newUsage());
  assert.equal(action.kind, "error");
  if (action.kind === "error") {
    assert.match(action.message, /Free usage limit reached\./);
    assert.match(action.message, /retry after 14\.3 h/);
    assert.equal(action.retryAfterMs, 51594000);
  }
});

test("text fallback accepts only active tools with object arguments", () => {
  const active = new Set(["read", "bash"]);
  const out = extractTextToolCalls(
    'Looking.\n<pi_tool_calls>[{"name":"read","arguments":{"path":"a"}},{"name":"nope","arguments":{}},{"name":"bash","arguments":[1]}]</pi_tool_calls>',
    active,
  );
  assert.equal(out.text, "Looking.");
  assert.deepEqual(out.calls, [{ name: "read", arguments: { path: "a" } }]);
  assert.deepEqual(extractTextToolCalls("<pi_tool_calls>{broken</pi_tool_calls>", active), { text: "", calls: [] });
  assert.deepEqual(extractTextToolCalls("plain answer", active), { text: "plain answer", calls: [] });
});

test("dedupeCalls drops identical retries but keeps distinct calls", () => {
  const a = { name: "read", arguments: { path: "x" } };
  assert.deepEqual(dedupeCalls([a, { ...a, arguments: { path: "x" } }, { name: "read", arguments: { path: "y" } }]).length, 2);
});

test("native tools are denied; only execute (the MCP route) is allowed", () => {
  const p = buildPermissions();
  for (const name of ["bash", "shell", "edit", "write", "glob", "grep", "webfetch", "websearch", "subagent", "task"]) {
    assert.equal(p[name], "deny", name);
  }
  assert.equal(p.execute, "allow");
  assert.equal(p.read, "ask");
  assert.equal(buildPermissions("deny").read, "deny");
  assert.ok(!("*" in p));
});
