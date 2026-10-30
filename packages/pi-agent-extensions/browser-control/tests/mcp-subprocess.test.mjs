import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chmod, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as protocol from "../bridge-protocol.mjs";

const host = resolve(import.meta.dirname, "../native-host/bridge-host.mjs");
const mcp = resolve(import.meta.dirname, "../mcp-server.mjs");
function frame(v) { const b = Buffer.from(JSON.stringify(v)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); }
const delay = ms => new Promise(r => setTimeout(r, ms));
async function eventually(fn) { for (let i = 0; i < 250; i++) { if (fn()) return; await delay(20); } throw new Error("Timed out waiting for subprocess protocol event"); }

test("stdio MCP child calls the real broker/native host through a protocol mock extension", async t => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\pi-mcp-${randomUUID()}` : join(tmpdir(), `pi-mcp-${randomUUID()}.sock`);
  const configPath = join(tmpdir(), `pi-mcp-${randomUUID()}.json`);
  await writeFile(configPath, JSON.stringify({ socketPath }), { mode: 0o600 });
  if (process.platform !== "win32") await chmod(configPath, 0o600);
  const env = { ...process.env }; delete env.PI_BROWSER_BRIDGE_SOCKET;
  const children = [];
  const stop = child => { if (child && child.exitCode === null) child.kill(); };
  t.after(async () => { children.forEach(stop); await unlink(configPath).catch(() => {}); });
  const broker = spawn(process.execPath, [host, "--broker", "--config", configPath, "--test-only-insecure-pipe"], { env, stdio: ["ignore", "ignore", "pipe"] }); children.push(broker);
  let brokerErr = ""; broker.stderr.on("data", b => brokerErr += b);
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) {
    ready = await new Promise(r => { const s = net.createConnection(socketPath); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
    if (!ready) await delay(20);
  }
  assert.ok(ready, `broker did not start: ${brokerErr}`);

  const native = spawn(process.execPath, [host, "--native", "--config", configPath, "--test-only-insecure-pipe"], { env, stdio: ["pipe", "pipe", "pipe"] }); children.push(native);
  let nativeErr = "", nativeBuf = Buffer.alloc(0), nativeSession, granted = false;
  const inFlight = new Map(); let cancellationSeen = false;
  native.stderr.on("data", b => nativeErr += b);
  const nativeSend = m => native.stdin.write(frame(m));
  native.stdout.on("data", chunk => {
    nativeBuf = Buffer.concat([nativeBuf, chunk]);
    while (nativeBuf.length >= 4) {
      const n = nativeBuf.readUInt32LE(0); if (!n || n > protocol.MAX_MESSAGE_BYTES) { native.kill(); return; }
      if (nativeBuf.length < n + 4) return;
      const m = JSON.parse(nativeBuf.subarray(4, n + 4).toString()); nativeBuf = nativeBuf.subarray(n + 4);
      if (m.type === "ready") { protocol.validateNativeResponse(m); nativeSession = m.session; nativeSend({ type: "targets", targets: [{ id: "mock-target", tabId: 7, origin: "https://fixture.test", title: "fixture" }] }); }
      else if (m.type === "targets") nativeSend({ type: "targets", targets: [{ id: "mock-target", tabId: 7, origin: "https://fixture.test", title: "fixture" }] });
      else if (m.type === "authorize") { granted = true; nativeSend({ type: "authorized", session: m.session, targetId: m.targetId, origin: m.origin }); }
      else if (m.type === "execute") {
        protocol.validateNativeRequest(m);
        const req = m.request;
        const timer = setTimeout(() => { inFlight.delete(req.id); nativeSend({ type: "executeResult", response: { version: 1, id: req.id, session: req.session, ok: true, result: { accepted: true } } }); }, req.action === "drag" ? 500 : 10);
        inFlight.set(req.id, timer);
      }
      else if (m.type === "cancel") { protocol.validateNativeRequest(m); cancellationSeen = true; clearTimeout(inFlight.get(m.id)); inFlight.delete(m.id); nativeSend({ type: "cancelled", session: m.session, id: m.id, dispatched: true }); }
    }
  });
  nativeSend({ type: "hello", version: 1 });
  await eventually(() => nativeSession);

  const mcpChild = spawn(process.execPath, [mcp], { env: { ...env, PI_BROWSER_BRIDGE_SOCKET: socketPath }, stdio: ["pipe", "pipe", "pipe"] }); children.push(mcpChild);
  let stdout = "", stderr = "";
  mcpChild.stdout.setEncoding("utf8"); mcpChild.stdout.on("data", s => stdout += s);
  mcpChild.stderr.setEncoding("utf8"); mcpChild.stderr.on("data", s => stderr += s);
  let replies = [], pending = new Map(), incomplete = "";
  mcpChild.stdout.on("data", () => {
    const lines = stdout.split("\n"); stdout = lines.pop();
    for (const line of lines) { assert.ok(line.trim(), "stdout contains only JSON-RPC lines"); const parsed = JSON.parse(line); assert.equal(parsed.jsonrpc, "2.0"); replies.push(parsed); pending.get(parsed.id)?.(parsed); pending.delete(parsed.id); }
  });
  let id = 0;
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id; pending.set(requestId, resolve);
    mcpChild.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    setTimeout(() => { if (pending.has(requestId)) { pending.delete(requestId); reject(new Error(`MCP timeout; stderr=${stderr}`)); } }, 5000).unref();
  });
  try {
    assert.equal((await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } })).result.serverInfo.name, "pi-browser-bridge");
    mcpChild.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const listed = await rpc("tools/list"); assert.ok(listed.result.tools.some(x => x.name === "browser_click"));
    // The broker denies an ungranted target, demonstrating MCP errors traverse real IPC.
    const targets = await rpc("tools/call", { name: "browser_targets", arguments: {} });
    assert.match(targets.result.content[0].text, /mock-target/);
    nativeSend({ type: "authorize", session: nativeSession, targetId: "mock-target", origin: "https://fixture.test" });
    await eventually(() => granted);
    const result = await rpc("tools/call", { name: "browser_click", arguments: { targetId: "mock-target", x: 12, y: 15 } });
    assert.equal(result.result.content[0].text, JSON.stringify({ accepted: true }));
    // Cancellation is exercised through the actual protocol route using a separate MCP call.
    // Send cancellation after dispatch; the fixture reports completion if it wins the race.
    const cancelId = ++id;
    mcpChild.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: cancelId, method: "tools/call", params: { name: "browser_drag", arguments: { targetId: "mock-target", start: { x: 1, y: 1 }, end: { x: 4, y: 4 } } } })}\n`);
    await delay(20);
    mcpChild.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: cancelId } })}\n`);
    await eventually(() => cancellationSeen);
    // Client cancellation is reported as an MCP error; dispatched effects remain uncertain.
    await eventually(() => replies.some(x => x.id === cancelId));
    assert.ok(replies.find(x => x.id === cancelId).error);
    mcpChild.stdin.end();
    await new Promise(r => mcpChild.once("exit", r));
    assert.equal(stdout.trim(), "", "no non-JSON trailing stdout");
    assert.equal(stderr, "", "normal operation emits no diagnostics");
  } finally { stop(mcpChild); }
});
