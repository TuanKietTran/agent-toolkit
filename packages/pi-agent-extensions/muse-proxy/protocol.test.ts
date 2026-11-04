import assert from "node:assert/strict";
import test from "node:test";
import { correctionMessage, parseRuns, renderTools, signature, type ToolDef } from "./protocol.ts";
import { CONTINUE_NOTE, SessionTracker, toolPreamble, type MuseMessage } from "./session.ts";

const read: ToolDef = {
  name: "read",
  description: "Read a file from disk. Supports offsets.",
  parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" } }, required: ["path"] },
};
const bash: ToolDef = {
  name: "bash",
  description: "Run a shell command",
  parameters: { type: "object", properties: { command: { type: "string" }, mode: { enum: ["a", "b"] }, args: { type: "array", items: { type: "string" } } }, required: ["command"] },
};
const tools = [read, bash];

test("signature marks optional args and renders enums and arrays", () => {
  assert.equal(signature(read), "read(path: string, offset?: number)");
  assert.equal(signature(bash), 'bash(command: string, mode?: "a"|"b", args?: string[])');
  assert.equal(signature({ name: "noop" }), "noop()");
});

test("renderTools uses the first sentence of the description", () => {
  assert.equal(renderTools([read]), "- read(path: string, offset?: number) - Read a file from disk.");
});

test("parseRuns captures a single @@RUN line", () => {
  const out = parseRuns('@@RUN {"name":"read","arguments":{"path":"/etc/hosts"}}', tools);
  assert.deepEqual(out.calls, [{ name: "read", arguments: { path: "/etc/hosts" } }]);
  assert.equal(out.text, "");
  assert.deepEqual(out.errors, []);
});

test("parseRuns keeps reasoning text and several calls in order, deduping repeats", () => {
  const text = [
    "I should look at two things first.",
    '@@RUN {"name":"read","arguments":{"path":"a.txt"}}',
    '@@RUN {"name":"bash","arguments":{"command":"ls"}}',
    '@@RUN {"name":"read","arguments":{"path":"a.txt"}}',
  ].join("\n");
  const out = parseRuns(text, tools);
  assert.equal(out.text, "I should look at two things first.");
  assert.deepEqual(out.calls.map((c) => c.name), ["read", "bash"]);
});

test("parseRuns handles braces and quotes inside strings", () => {
  const cmd = 'echo "}" && printf \'{\\"a\\":1}\'';
  const out = parseRuns(`@@RUN ${JSON.stringify({ name: "bash", arguments: { command: cmd } })} trailing`, tools);
  assert.equal((out.calls[0].arguments as { command: string }).command, cmd);
  assert.equal(out.text, "trailing");
});

test("parseRuns accepts the <run> block form", () => {
  const out = parseRuns('Checking.\n<run>{"name":"bash","arguments":{"command":"ls"}}</run>', tools);
  assert.equal(out.calls.length, 1);
  assert.equal(out.text, "Checking.");
});

test("parseRuns reports unknown tools, bad JSON and missing required args", () => {
  assert.match(parseRuns('@@RUN {"name":"nope","arguments":{}}', tools).errors[0], /unknown tool "nope"/);
  assert.match(parseRuns('@@RUN {"name":"read","arguments":{}}', tools).errors[0], /missing required argument\(s\): path/);
  assert.match(parseRuns('@@RUN {"name":"read",', tools).errors[0], /unterminated/);
  assert.match(parseRuns('@@RUN {"name":read}', tools).errors[0], /not valid JSON/);
  assert.match(parseRuns("@@RUN read /etc/hosts", tools).errors[0], /must be followed by a JSON object/);
});

test("plain prose has no calls and no errors", () => {
  const out = parseRuns("The first line is ##", tools);
  assert.deepEqual(out, { text: "The first line is ##", calls: [], errors: [] });
});

test("correctionMessage names the problems and the format", () => {
  const msg = correctionMessage(["unknown tool \"x\""]);
  assert.ok(msg.includes('unknown tool "x"') && msg.includes("@@RUN"));
});

test("fresh plan with tools carries the hands preamble and signatures", () => {
  const t = new SessionTracker();
  const plan = t.plan([{ role: "user", content: "read my hosts" }], "Be terse.", "", undefined, tools);
  assert.ok(plan.content.startsWith("I'm working on my own laptop"));
  assert.ok(plan.content.includes("read(path: string, offset?: number)"));
  assert.ok(plan.content.includes("@@RUN"));
  assert.ok(plan.content.includes("Be terse."));
  assert.ok(plan.content.endsWith("read my hosts"));
  assert.equal(toolPreamble(tools).includes("bash(command: string"), true);
});

test("delta with tool results sends OUTPUT blocks and the continue note", () => {
  const t = new SessionTracker();
  const first = t.plan([{ role: "user", content: "go" }], undefined, "", undefined, tools);
  t.commit(first);
  const messages: MuseMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }] },
    { role: "toolResult", toolName: "read", content: "AAA" },
    { role: "toolResult", toolName: "bash", isError: true, content: "boom" },
  ];
  const next = t.plan(messages, undefined, "", undefined, tools);
  assert.equal(next.fresh, false);
  assert.equal(next.content, `OUTPUT (read, ok):\nAAA\n\nOUTPUT (bash, error):\nboom\n\n${CONTINUE_NOTE}`);
});

test("parallel tool results share the budget instead of dropping older ones", () => {
  const t = new SessionTracker({ maxChars: 3000, systemChars: 200 });
  t.commit(t.plan([{ role: "user", content: "go" }], undefined, "", undefined, tools));
  const big = "z".repeat(5000);
  const plan = t.plan(
    [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }] },
      { role: "toolResult", toolName: "read", content: "A" + big },
      { role: "toolResult", toolName: "read", content: "B" + big },
    ],
    undefined, "", undefined, tools,
  );
  assert.ok(plan.content.length <= 3000);
  assert.ok(plan.content.includes("OUTPUT (read, ok):\nA") && plan.content.includes("OUTPUT (read, ok):\nB"));
});

test("a fresh resend renders earlier tool calls as @@RUN lines", () => {
  const t = new SessionTracker();
  const plan = t.plan(
    [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "looking" }, { type: "toolCall", name: "read", arguments: { path: "a" } }] },
      { role: "toolResult", toolName: "read", content: "AAA" },
    ],
    undefined, "", undefined, tools,
  );
  assert.ok(plan.content.includes('Assistant: looking\n@@RUN {"name":"read","arguments":{"path":"a"}}'));
  assert.ok(plan.content.includes("OUTPUT (read, ok):\nAAA"));
  assert.ok(plan.content.endsWith(CONTINUE_NOTE));
});

import { SseParser, isRefusal } from "./stream.ts";

test("SseParser splits replies from progress and survives chunk boundaries", () => {
  const p = new SseParser();
  const line = (kind: string, content: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }], muse_proxy: { kind } })}\n\n`;
  const all = line("progress", "is working\n") + line("reply", "@@RUN {\"name\":\"read\"}") + "data: [DONE]\n\n";
  const mid = Math.floor(all.length / 2);
  const out = [...p.push(all.slice(0, mid)), ...p.push(all.slice(mid))];
  assert.deepEqual(out.map((c) => c.kind), ["progress", "reply"]);
  assert.equal(out[1].text, '@@RUN {"name":"read"}');
});

test("SseParser surfaces stream errors and ignores the role chunk", () => {
  const p = new SseParser();
  const out = p.push('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\ndata: {"error":{"message":"boom"}}\n\n');
  assert.deepEqual(out, [{ kind: "other", text: "", error: "boom" }]);
});

test("isRefusal recognises the canned reply in several languages and nothing else", () => {
  assert.equal(isRefusal("Sorry, I can't help you with this request at the moment.\nIs there anything else I can help you with?"), true);
  assert.equal(isRefusal("Lo siento, ahora mismo no puedo ayudarte con esta solicitud. ¿Hay algo más en lo que pueda ayudarte?"), true);
  assert.equal(isRefusal('@@RUN {"name":"read","arguments":{"path":"a"}}'), false);
  assert.equal(isRefusal("I'm sorry the build failed; the error is a missing semicolon, which I can fix by editing line 4."), false);
  assert.equal(isRefusal("x".repeat(400) + " sorry cannot"), false);
});

test("a chat is rotated after rotateTurns requests and resends fresh context", () => {
  const t = new SessionTracker({ maxChars: 15000, systemChars: 3000, rotateTurns: 3, rotateChars: 1_000_000 });
  const msgs: MuseMessage[] = [{ role: "user", content: "start" }];
  const ids: string[] = [];
  for (let turn = 0; turn < 5; turn++) {
    const plan = t.plan(msgs, "sys", "", undefined, tools);
    ids.push(plan.sessionId);
    t.commit(plan);
    msgs.push({ role: "assistant", content: "ok" }, { role: "user", content: `next ${turn}` });
  }
  assert.equal(ids[0], ids[1]);
  assert.equal(ids[1], ids[2]);
  assert.notEqual(ids[2], ids[3]);
  assert.equal(ids[3], ids[4]);
});

test("reset starts a brand-new chat with the full preamble", () => {
  const t = new SessionTracker();
  const first = t.plan([{ role: "user", content: "go" }], "sys", "", undefined, tools);
  t.commit(first);
  t.reset(first.key);
  const again = t.plan([{ role: "user", content: "go" }, { role: "assistant", content: "hm" }, { role: "user", content: "more" }], "sys", "", undefined, tools);
  assert.equal(again.fresh, true);
  assert.notEqual(again.sessionId, first.sessionId);
  assert.ok(again.content.startsWith("I'm working on my own laptop"));
});

import { isTransient } from "./stream.ts";

test("isTransient recognises dropped Muse connections but not aborts or bad requests", () => {
  assert.equal(isTransient(new Error("muse-proxy: Muse disconnected before completing the reply.")), true);
  assert.equal(isTransient(new Error("muse-proxy 502: muse_connection_error")), true);
  assert.equal(isTransient(new TypeError("fetch failed")), true);
  assert.equal(isTransient(new Error("aborted")), false);
  assert.equal(isTransient(new Error("muse-proxy 400: Client-supplied tools are not supported.")), false);
});
