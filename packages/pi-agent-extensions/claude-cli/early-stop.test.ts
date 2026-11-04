import assert from "node:assert/strict";
import test from "node:test";
import { EarlyStop, HOST_TOOL_PREFIX } from "./early-stop.ts";

const active = new Set(["read", "bash"]);
const start = { type: "message_start" };
const stop = { type: "message_stop" };
const toolStart = (index: number, name: string) => ({ type: "content_block_start", index, content_block: { type: "tool_use", name } });
const delta = (index: number, partial_json: string) => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });

function run(events: unknown[], tools = active) {
  const s = new EarlyStop(tools);
  let last;
  for (const e of events) last = s.observe(e) ?? last;
  return last;
}

test("a message of host tool calls ends in a stop with the calls read from the stream", () => {
  const decision = run([
    start,
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    toolStart(1, `${HOST_TOOL_PREFIX}read`),
    delta(1, '{"path":'),
    delta(1, '"a.txt"}'),
    toolStart(2, `${HOST_TOOL_PREFIX}bash`),
    delta(2, '{"command":"ls"}'),
    stop,
  ]);
  assert.deepEqual(decision, {
    stop: true,
    calls: [
      { name: "read", arguments: { path: "a.txt" } },
      { name: "bash", arguments: { command: "ls" } },
    ],
  });
});

test("a call without arguments is an empty object", () => {
  assert.deepEqual(run([start, toolStart(0, `${HOST_TOOL_PREFIX}read`), stop]), { stop: true, calls: [{ name: "read", arguments: {} }] });
});

test("text-only messages decide nothing; a later tool message still can", () => {
  const s = new EarlyStop(active);
  assert.equal(s.observe(start), undefined);
  assert.equal(s.observe({ type: "content_block_start", index: 0, content_block: { type: "text" } }), undefined);
  assert.equal(s.observe(stop), undefined);
  s.observe(start);
  s.observe(toolStart(0, `${HOST_TOOL_PREFIX}read`));
  s.observe(delta(0, "{}"));
  assert.equal(s.observe(stop)?.stop, true);
});

test("structured output mixed with host calls, unknown tools and broken arguments fall back to the normal flow", () => {
  assert.deepEqual(run([start, toolStart(0, `${HOST_TOOL_PREFIX}read`), delta(0, "{}"), toolStart(1, "StructuredOutput"), delta(1, "{}"), stop]), { stop: false });
  assert.deepEqual(run([start, toolStart(0, `${HOST_TOOL_PREFIX}nope`), delta(0, "{}"), stop]), { stop: false });
  assert.deepEqual(run([start, toolStart(0, `${HOST_TOOL_PREFIX}read`), delta(0, '{"path":'), stop]), { stop: false });
  assert.deepEqual(run([start, toolStart(0, `${HOST_TOOL_PREFIX}read`), delta(0, "[1]"), stop]), { stop: false });
});

test("once disabled or finished, later messages are ignored", () => {
  const s = new EarlyStop(active);
  s.observe(start);
  s.observe(toolStart(0, "StructuredOutput"));
  assert.deepEqual(s.observe(stop), { stop: false });
  s.observe(start);
  s.observe(toolStart(0, `${HOST_TOOL_PREFIX}read`));
  assert.equal(s.observe(stop), undefined);
});

test("garbage events are ignored", () => {
  const s = new EarlyStop(active);
  assert.equal(s.observe(undefined), undefined);
  assert.equal(s.observe({}), undefined);
  assert.equal(s.observe({ type: "content_block_delta", index: 9, delta: { type: "input_json_delta", partial_json: "x" } }), undefined);
});
