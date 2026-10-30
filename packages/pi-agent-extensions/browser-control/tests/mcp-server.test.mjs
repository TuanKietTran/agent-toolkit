import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { serve } from "../mcp-server.mjs";

test("MCP initialize, tools, action, image, errors, and cancellation use bridge client", async () => {
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
  assert.deepEqual(messages[2].result.content[0], { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" });
  assert.equal(messages[3].error.code, -32000);
  assert.equal(messages[4].error.code, -32602);
  assert.equal(calls[0].action, "type");
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
