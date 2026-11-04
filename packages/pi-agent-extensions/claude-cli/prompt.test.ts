import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE_SYSTEM_PROMPT,
  baseSystemPrompt,
  trailingBatch,
  HISTORY_HEADER,
  HISTORY_RESULT_LIMIT,
  buildTranscriptBlocks,
  capText,
  createOutputSchema,
  createToolBridgePrompt,
  labelToolCalls,
  toolSignature,
} from "./prompt.ts";

const readTool: any = {
  name: "read",
  description: "Read the contents of a file. Long description that must not be repeated in the prompt.",
  parameters: { type: "object", required: ["path"], properties: { path: { type: "string" }, limit: { type: "number" } } },
};
const bashTool: any = { name: "bash", description: "Run a command", parameters: { type: "object", required: ["command"], properties: { command: { type: "string" } } } };

const user = (text: string): any => ({ role: "user", content: [{ type: "text", text }] });
const assistantCall = (id: string, name: string, args: object): any => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const result = (id: string, name: string, text: string, isError = false): any => ({ role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text }] });

test("transcript is one block per message after a fixed header", () => {
  const blocks = buildTranscriptBlocks([user("hi"), assistantCall("claude_cli_mcp_aaaa-1111", "read", { path: "a" }), result("claude_cli_mcp_aaaa-1111", "read", "hello")]);
  assert.equal(blocks[0], HISTORY_HEADER);
  assert.equal(blocks.length, 4);
  assert.equal(blocks[1], "Human: hi");
  assert.equal(blocks[2], 'Assistant: Tool call [t1]: read({"path":"a"})');
  assert.equal(blocks[3], "Tool result (success) for read [t1]:\nhello");
});

test("earlier blocks are byte-identical when a message is appended (cache prefix stability)", () => {
  const first = [user("hi"), assistantCall("id-1", "read", { path: "a" }), result("id-1", "read", "x".repeat(50))];
  const next = [...first, assistantCall("id-2", "bash", { command: "ls" }), result("id-2", "bash", "out")];
  const a = buildTranscriptBlocks(first);
  const b = buildTranscriptBlocks(next);
  assert.deepEqual(b.slice(0, a.length), a);
});

test("tool call ids become short labels in order of appearance", () => {
  const labels = labelToolCalls([assistantCall("long-id-1", "read", {}), assistantCall("long-id-2", "bash", {})]);
  assert.equal(labels.get("long-id-1"), "t1");
  assert.equal(labels.get("long-id-2"), "t2");
});

test("only older oversized tool results are cut, with a marker; the newest stays whole", () => {
  const big = "A".repeat(HISTORY_RESULT_LIMIT + 5000);
  const older = buildTranscriptBlocks([user("go"), assistantCall("i1", "read", {}), result("i1", "read", big), assistantCall("i2", "read", {}), result("i2", "read", "ok")]);
  assert.match(older[3], /characters omitted from this older tool result/);
  assert.ok(older[3].length < big.length);
  const newest = buildTranscriptBlocks([user("go"), assistantCall("i1", "read", {}), result("i1", "read", big)]);
  assert.ok(newest[3].includes(big));
  assert.equal(capText("short"), "short");
});

test("tool errors stay marked as errors", () => {
  const blocks = buildTranscriptBlocks([result("zzzzzz", "bash", "boom", true)]);
  assert.match(blocks[1], /^Tool result \(error\) for bash \[zzzzzz\]/);
});

test("bridge prompt lists compact signatures, not full schemas", () => {
  assert.equal(toolSignature(readTool), "read(path, limit?)");
  const prompt = createToolBridgePrompt([readTool, bashTool]);
  assert.match(prompt, /Host tools: read\(path, limit\?\); bash\(command\)/);
  assert.doesNotMatch(prompt, /Long description/);
  assert.doesNotMatch(prompt, /"type":"object"/);
  assert.match(prompt, /mcp__pi-host__/);
  assert.match(prompt, /continue the task from it/);
});

test("bridge prompt without tools tells the model to answer in text", () => {
  assert.match(createToolBridgePrompt([]), /No host tools are active/);
});

test("output schema enumerates tool names and forbids calls when there are no tools", () => {
  const withTools: any = createOutputSchema([readTool], { type: "string" });
  assert.deepEqual(withTools.properties.tool_calls.items.properties.name.enum, ["read"]);
  const none: any = createOutputSchema([], { type: "string" });
  assert.equal(none.properties.tool_calls.maxItems, 0);
});

test("base system prompt is short and names the host", () => {
  assert.ok(BASE_SYSTEM_PROMPT.length < 400);
  assert.match(BASE_SYSTEM_PROMPT, /Pi/);
});

test("a batch of parallel tool results is kept whole and travels together", () => {
  const big = "B".repeat(HISTORY_RESULT_LIMIT + 100);
  const messages: any[] = [user("go"), assistantCall("i1", "read", {}), result("i1", "read", big), result("i2", "read", big)];
  assert.equal(trailingBatch(messages).length, 2);
  const blocks = buildTranscriptBlocks(messages);
  assert.ok(blocks[3].includes(big) && blocks[4].includes(big), "no result of the current batch is cut");
  const later = buildTranscriptBlocks([...messages, assistantCall("i3", "bash", {}), result("i3", "bash", "ok")]);
  assert.match(later[3], /omitted from this older tool result/);
  assert.deepEqual(trailingBatch([user("a"), user("b")]).length, 1);
  assert.deepEqual(trailingBatch([]), []);
});

test("the system stub carries today's date", () => {
  assert.match(baseSystemPrompt(new Date(2026, 10, 3)), /Today's date: 2026-11-03\./);
  assert.ok(baseSystemPrompt().startsWith(BASE_SYSTEM_PROMPT));
});
