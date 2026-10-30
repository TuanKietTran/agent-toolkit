import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { serve } from "../mcp-server.mjs";

test("MCP initialize, tools, action, imageBase64, errors, and default-disabled foreground tools", async () => {
  const input = new PassThrough(), output = new PassThrough(); let text = "";
  output.on("data", chunk => text += chunk);
  const calls = [];
  const client = {
    async connect() {}, async listTargets() { return [{ id: "opaque" }]; },
    async request(action, args, opts) {
      calls.push({ action, args, opts });
      if (args.text === "fail") return { ok: false, error: { code: "UNAUTHORIZED", message: "Denied" } };
      if (args.text === "image") return { version: 1, id: "mock-request", session: "mock-session", ok: true, result: { accepted: true, imageBase64: "aGVsbG8=", mimeType: "image/jpeg" } };
      return { ok: true, result: { accepted: true } };
    }, async close() {},
  };
  const running = serve({ input, output, client });
  const send = async obj => { input.write(`${JSON.stringify(obj)}\n`); await new Promise(r => setImmediate(r)); };
  await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_type", arguments: { targetId: "opaque", text: "image" } } });
  await send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_type", arguments: { targetId: "opaque", text: "fail" } } });
  await send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } });
  input.end(); await running;
  const messages = text.trim().split("\n").map(JSON.parse);
  assert.equal(messages[0].result.serverInfo.name, "pi-browser-bridge");
  assert.ok(messages[1].result.tools.some(t => t.name === "browser_observe"));
  assert.equal(messages[1].result.tools.some(t => t.name === "windows_foreground_act"), false, "native foreground tools are disabled by default");
  assert.deepEqual(messages[2].result.content[0], { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" });
  assert.equal(messages[3].error.code, -32000);
  assert.equal(messages[4].error.code, -32602);
  assert.equal(calls[0].action, "type");
});

test("opted-in Windows adapter tools are advertised and routed through the shared adapter", async () => {
  const input = new PassThrough(), output = new PassThrough(); let text = ""; output.on("data", b => text += b);
  const calls = [];
  const client = { async connect() {}, async close() {} };
  const windowsAdapter = { async call(name, args) { calls.push({ name, args }); return { content: [{ type: "text", text: "shared result" }] }; } };
  const running = serve({ input, output, client, windowsAdapter });
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  input.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"windows_foreground_surface","arguments":{"action":"on"}}}\n');
  input.end(); await running;
  const messages = text.trim().split("\n").map(JSON.parse);
  assert.ok(messages[1].result.tools.some(t => t.name === "windows_foreground_act"));
  assert.equal(messages[2].result.content[0].text, "shared result");
  assert.deepEqual(calls, [{ name: "windows_foreground_surface", args: { action: "on" } }]);
});

test("MCP rejects malformed JSON and methods before initialization", async () => {
  const input = new PassThrough(), output = new PassThrough(); let text = ""; output.on("data", b => text += b);
  const client = { async close() {}, async connect() {}, async listTargets() {}, async request() {} };
  const running = serve({ input, output, client });
  input.write("{bad}\n"); input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'); input.end(); await running;
  const messages = text.trim().split("\n").map(JSON.parse);
  assert.equal(messages[0].error.code, -32700);
  assert.equal(messages[1].error.code, -32002);
});
