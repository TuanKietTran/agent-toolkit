import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createBridgeClient } from "../bridge-client.mjs";
import { startStdioRelayFixture } from "./stdio-relay-fixture.mjs";
import * as protocol from "../bridge-protocol.mjs";

const host = resolve(import.meta.dirname, "../native-host/bridge-host.mjs");
const MAX = protocol.MAX_MESSAGE_BYTES;
function encode(v) { const b = Buffer.from(JSON.stringify(v)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); }
async function rawClient(path) {
  const socket = net.createConnection(path);
  let input = Buffer.alloc(0), queue = [], waiters = [];
  socket.on("data", (chunk) => {
    input = Buffer.concat([input, chunk]);
    while (input.length >= 4 && input.length >= input.readUInt32LE(0) + 4) {
      const n = input.readUInt32LE(0), msg = JSON.parse(input.subarray(4, n + 4).toString()); input = input.subarray(n + 4);
      const waiter = waiters.shift(); waiter ? waiter(msg) : queue.push(msg);
    }
  });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve));
  const send = (msg) => socket.write(encode(msg));
  const joinId = randomUUID();
  send({ type: "hello", version: 1, id: joinId });
  const ready = await next(); assert.equal(ready.type, "ready"); assert.equal(ready.id, joinId);
  return { socket, next, send, session: ready.session };
}
async function waitFor(testFn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (testFn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("Timed out waiting for native host process");
}

test("production broker + native host subprocess + protocol-checked mock extension + actual client", async (t) => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\pi-bridge-e2e-${randomUUID()}` : join(tmpdir(), `pi-bridge-e2e-${randomUUID()}.sock`);
  const privateDir = await mkdtemp(join(tmpdir(), `pi-bridge-e2e-${randomUUID()}-`));
  if (process.platform !== "win32") await chmod(privateDir, 0o700);
  else {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const whoami = join(systemRoot, "System32", "whoami.exe");
    const sidOutput = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    const userSid = sidOutput.match(/S-\d-\d+(?:-\d+)+/)?.[0];
    assert.ok(userSid, "test account SID available");
    execFileSync(join(systemRoot, "System32", "icacls.exe"), [privateDir, "/inheritance:r", "/grant:r", `*${userSid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { windowsHide: true, stdio: "ignore" });
  }
  const configPath = join(privateDir, "host-config.json");
  const config = process.platform === "win32" ? { pipeName: socketPath, extensionOrigin: "chrome-extension://fixture/" } : { socketPath };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  if (process.platform !== "win32") await chmod(configPath, 0o600);
  const env = { ...process.env };
  delete env.PI_BROWSER_BRIDGE_SOCKET;
  t.after(async () => { await rm(privateDir, { recursive: true, force: true }); });
  const broker = spawn(process.execPath, [host, "--broker-stdio", "--config", configPath], { env, stdio: ["pipe", "pipe", "pipe"] });
  let brokerDiagnostics = "";
  broker.stderr.on("data", (b) => { brokerDiagnostics += b.toString(); });
  let relay;
  relay = startStdioRelayFixture(socketPath, broker);
  await relay.listening;
  t.after(() => relay.close());
  t.after(() => { if (brokerDiagnostics) t.diagnostic(`broker stderr: ${brokerDiagnostics}`); broker.kill(); });
  const listening = true;
  assert.ok(listening, "test relay listens on the temporary OS IPC endpoint and multiplexes to the production Node worker");
  if (process.platform !== "win32") assert.equal((await stat(socketPath)).mode & 0o077, 0, "Unix broker socket is owner-only");

  const native = spawn(process.execPath, [host, "--native", "--config", configPath], { env, stdio: ["pipe", "pipe", "pipe"] });
  let nativeDiagnostics = "";
  native.stderr.on("data", (b) => { nativeDiagnostics += b.toString(); });
  t.after(() => { if (nativeDiagnostics) t.diagnostic(`native stderr: ${nativeDiagnostics}`); native.kill(); });
  let out = Buffer.alloc(0), nativeReady, granted = false, dragMouseUps = 0, hostTargetId, dispatchCount = 0, cancelCount = 0;
  const extensionTabs = [{ tabId: 22, origin: "https://example.test", title: "mock" }];
  const pendingExtension = new Map();
  function extSend(m) { native.stdin.write(encode(m)); }
  native.stdout.on("data", (chunk) => {
    out = Buffer.concat([out, chunk]);
    while (out.length >= 4) {
      const n = out.readUInt32LE(0); if (!n || n > MAX) { native.kill(); return; }
      if (out.length < n + 4) return;
      const msg = JSON.parse(out.subarray(4, n + 4).toString("utf8")); out = out.subarray(n + 4);
      if (msg.type === "ready") {
        protocol.validateNativeResponse(msg); nativeReady = msg;
      } else if (msg.type === "targetsRequest") {
        protocol.validateNativeResponse(msg);
        extSend({ type: "targetInventory", session: msg.session, tabs: extensionTabs.map(({ tabId, origin, title }) => ({ tabId, origin, title })) });
      } else if (msg.type === "targets") {
        protocol.validateNativeResponse(msg);
        hostTargetId = msg.targets[0]?.id;
      } else if (msg.type === "authorized") {
        protocol.validateNativeResponse(msg); granted = true;
      } else if (msg.type === "revoked") {
        protocol.validateNativeResponse(msg); granted = false;
      } else if (msg.type === "execute") {
        protocol.validateNativeRequest(msg);
        dispatchCount++;
        const req = msg.request;
        const response = async () => {
          if (!granted) return { version: 1, id: req.id, session: req.session, ok: false, error: { code: "UNAUTHORIZED", message: "Mock extension grant revoked", retryable: false } };
          if (req.action === "drag") {
            try {
              await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, 120);
                pendingExtension.set(req.id, () => { clearTimeout(timer); reject(Error("cancelled")); });
              });
            } catch { /* cancellation remains best effort */ }
            finally { dragMouseUps++; pendingExtension.delete(req.id); }
          }
          return { version: 1, id: req.id, session: req.session, ok: true, result: { accepted: true } };
        };
        response().then((result) => extSend({ type: "executeResult", response: result }));
      } else if (msg.type === "cancel") {
        protocol.validateNativeRequest(msg); cancelCount++; pendingExtension.get(msg.id)?.();
        extSend({ type: "cancelled", session: msg.session, id: msg.id, dispatched: true });
      }
    }
  });
  native.stderr.on("data", () => {}); // diagnostics are intentionally separate from framed stdout
  extSend({ type: "hello", version: 1 });
  await waitFor(() => Boolean(nativeReady));
  assert.ok(nativeReady.session);

  const client = createBridgeClient({ configPath, timeoutMs: 2000 });
  t.after(() => client.close());
  const clientSession = (await client.connect()).session;
  assert.ok(clientSession && clientSession !== nativeReady.session, "broker maps isolated client sessions to the active extension session");
  const targets = await client.listTargets();
  assert.ok(targets[0].id);
  assert.ok(targets[0].id, "broker assigns opaque target IDs from raw extension inventory");
  assert.equal(targets[0].tabId, 22);
  const targetId = targets[0].id;
  assert.equal(hostTargetId, targetId);

  // A valid same-user peer still cannot forge another connection's session.
  const forged = await rawClient(socketPath);
  const forgedClosed = new Promise((resolve) => forged.socket.once("close", resolve));
  forged.send({ type: "request", id: "forged-id", session: "forged-session", request: { version: 1, id: "forged-id", session: "forged-session", target: targetId, action: "observe", args: {} } });
  await Promise.race([forgedClosed, new Promise((_, reject) => setTimeout(() => reject(new Error("forged session was not rejected")), 1000))]);
  const denied = await client.request("click", { x: 1, y: 2, button: "left" }, { targetId });
  assert.equal(denied.ok, false); assert.equal(denied.error.code, "UNAUTHORIZED");

  extSend({ type: "authorize", session: nativeReady.session, targetId, origin: "https://example.test" });
  await waitFor(() => granted);

  const first = await rawClient(socketPath), second = await rawClient(socketPath);
  assert.notEqual(first.session, second.session, "each same-user client receives a distinct principal session");
  const sharedId = "cross-client-id";
  first.send({ type: "request", id: sharedId, session: first.session, request: { version: 1, id: sharedId, session: first.session, target: targetId, action: "drag", args: { start: { x: 1, y: 1 }, end: { x: 20, y: 20 }, button: "left" } } });
  await waitFor(() => pendingExtension.has(sharedId));
  const dispatchedCount = dispatchCount;
  second.send({ type: "cancel", id: sharedId, session: second.session });
  second.send({ type: "request", id: sharedId, session: second.session, request: { version: 1, id: sharedId, session: second.session, target: targetId, action: "click", args: { x: 2, y: 2, button: "left" } } });
  const duplicate = await second.next();
  assert.equal(duplicate.type, "response"); assert.equal(duplicate.response.error.code, "INVALID_REQUEST");
  assert.equal(dispatchCount, dispatchedCount, "duplicate ID does not dispatch a second action");
  assert.equal(cancelCount, 0, "a different client connection cannot cancel the owning request");
  const firstResult = await first.next();
  assert.equal(firstResult.response.id, sharedId); assert.equal(firstResult.response.session, first.session);
  first.socket.destroy(); second.socket.destroy();

  const delivered = await client.request("click", { x: 4, y: 6, button: "left" }, { targetId });
  protocol.validateResponse(delivered); assert.equal(delivered.result.accepted, true);
  const drag = await client.request("drag", { start: { x: 1, y: 2 }, end: { x: 50, y: 60 }, button: "left" }, { targetId });
  assert.equal(drag.ok, true); assert.equal(dragMouseUps, 2);

  const ac = new AbortController();
  const cancelled = client.request("drag", { start: { x: 2, y: 3 }, end: { x: 55, y: 65 }, button: "left" }, { targetId, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 25)); ac.abort();
  await assert.rejects(cancelled, /outcome may be uncertain/i);
  await waitFor(() => dragMouseUps === 3);

  extSend({ type: "revoke", session: nativeReady.session, targetId });
  await waitFor(() => !granted);
  const revoked = await client.request("click", { x: 4, y: 6, button: "left" }, { targetId });
  assert.equal(revoked.error.code, "UNAUTHORIZED");

  extSend({ type: "targets", targets: [] });
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(client.request("click", { x: 4, y: 6, button: "left" }, { targetId: "host-target" }), /absent from the latest broker catalog/i);
});
