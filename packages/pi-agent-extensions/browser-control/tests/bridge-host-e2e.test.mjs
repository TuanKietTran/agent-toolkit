import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chmod, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createBridgeClient } from "../bridge-client.mjs";
import * as protocol from "../bridge-protocol.mjs";

const host = resolve(import.meta.dirname, "../native-host/bridge-host.mjs");
const MAX = protocol.MAX_MESSAGE_BYTES;
function encode(v) { const b = Buffer.from(JSON.stringify(v)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); }
async function waitFor(testFn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (testFn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("Timed out waiting for native host process");
}

test("production broker + native host subprocess + protocol-checked mock extension + actual client", async (t) => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\pi-bridge-e2e-${randomUUID()}` : join(tmpdir(), `pi-bridge-e2e-${randomUUID()}.sock`);
  const configPath = join(tmpdir(), `pi-bridge-e2e-${randomUUID()}.json`);
  await writeFile(configPath, JSON.stringify({ socketPath }), { mode: 0o600 });
  if (process.platform !== "win32") await chmod(configPath, 0o600);
  const env = { ...process.env };
  delete env.PI_BROWSER_BRIDGE_SOCKET;
  t.after(async () => { await import("node:fs/promises").then(({ unlink }) => unlink(configPath).catch(() => {})); });
  const broker = spawn(process.execPath, [host, "--broker", "--config", configPath, "--test-only-insecure-pipe"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let brokerDiagnostics = "";
  broker.stderr.on("data", (b) => { brokerDiagnostics += b.toString(); });
  t.after(() => { if (brokerDiagnostics) t.diagnostic(`broker stderr: ${brokerDiagnostics}`); broker.kill(); });
  let listening = false;
  for (let i = 0; i < 150 && !listening; i++) {
    listening = await new Promise((r) => { const s = net.createConnection(socketPath); s.once("connect", () => { s.destroy(); r(true); }); s.once("error", () => r(false)); });
    if (!listening) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(listening, "broker child process listens on the temporary OS IPC endpoint");
  if (process.platform !== "win32") assert.equal((await stat(socketPath)).mode & 0o077, 0, "Unix broker socket is owner-only");

  const native = spawn(process.execPath, [host, "--native", "--config", configPath, "--test-only-insecure-pipe"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let nativeDiagnostics = "";
  native.stderr.on("data", (b) => { nativeDiagnostics += b.toString(); });
  t.after(() => { if (nativeDiagnostics) t.diagnostic(`native stderr: ${nativeDiagnostics}`); native.kill(); });
  let out = Buffer.alloc(0), nativeReady, granted = false, dragMouseUps = 0;
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
        extSend({ type: "targets", targets: [{ id: "host-target", tabId: 22, origin: "https://example.test", title: "mock" }] });
      } else if (msg.type === "targets") {
        protocol.validateNativeRequest(msg);
        extSend({ type: "targets", targets: [{ id: "host-target", tabId: 22, origin: "https://example.test", title: "mock" }] });
      } else if (msg.type === "authorized") {
        protocol.validateNativeResponse(msg); granted = true;
      } else if (msg.type === "revoked") {
        protocol.validateNativeResponse(msg); granted = false;
      } else if (msg.type === "execute") {
        protocol.validateNativeRequest(msg);
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
        protocol.validateNativeRequest(msg); pendingExtension.get(msg.id)?.();
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
  assert.equal((await client.connect()).session, nativeReady.session, "broker join uses one host-issued session across client/native relay");
  const targets = await client.listTargets();
  assert.equal(targets[0].id, "host-target");

  // Same-user IPC admission does not authorize a caller-supplied/forged session.
  const intruder = net.createConnection(socketPath);
  let raw = Buffer.alloc(0);
  const sessionDenied = new Promise((resolve) => {
    intruder.on("data", (chunk) => {
      raw = Buffer.concat([raw, chunk]);
      while (raw.length >= 4 && raw.length >= raw.readUInt32LE(0) + 4) {
        const n = raw.readUInt32LE(0), message = JSON.parse(raw.subarray(4, n + 4).toString()); raw = raw.subarray(n + 4);
        if (message.type === "ready") intruder.write(encode({ type: "request", id: "forged-id", session: "forged-session", request: { version: 1, id: "forged-id", session: "forged-session", target: "host-target", action: "observe", args: {} } }));
      }
    });
    intruder.on("close", resolve);
    intruder.write(encode({ type: "hello", version: 1, id: "forged-join" }));
  });
  await Promise.race([sessionDenied, new Promise((_, reject) => setTimeout(() => reject(new Error("forged session was not rejected")), 1000))]);
  const denied = await client.request("click", { x: 1, y: 2, button: "left" }, { targetId: "host-target" });
  assert.equal(denied.ok, false); assert.equal(denied.error.code, "UNAUTHORIZED");

  extSend({ type: "authorize", session: nativeReady.session, targetId: "host-target", origin: "https://example.test" });
  await waitFor(() => granted);
  const delivered = await client.request("click", { x: 4, y: 6, button: "left" }, { targetId: "host-target" });
  protocol.validateResponse(delivered); assert.equal(delivered.result.accepted, true);
  const drag = await client.request("drag", { start: { x: 1, y: 2 }, end: { x: 50, y: 60 }, button: "left" }, { targetId: "host-target" });
  assert.equal(drag.ok, true); assert.equal(dragMouseUps, 1);

  const ac = new AbortController();
  const cancelled = client.request("drag", { start: { x: 2, y: 3 }, end: { x: 55, y: 65 }, button: "left" }, { targetId: "host-target", signal: ac.signal });
  await new Promise((r) => setTimeout(r, 25)); ac.abort();
  await assert.rejects(cancelled, /outcome may be uncertain/i);
  await waitFor(() => dragMouseUps === 2);

  extSend({ type: "revoke", session: nativeReady.session, targetId: "host-target" });
  await waitFor(() => !granted);
  const revoked = await client.request("click", { x: 4, y: 6, button: "left" }, { targetId: "host-target" });
  assert.equal(revoked.error.code, "UNAUTHORIZED");

  extSend({ type: "targets", targets: [] });
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(client.request("click", { x: 4, y: 6, button: "left" }, { targetId: "host-target" }), /absent from the latest broker catalog/i);
});
