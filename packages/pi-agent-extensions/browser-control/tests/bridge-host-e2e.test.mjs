import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createBridgeClient } from "../bridge-client.mjs";
import { startStdioRelayFixture } from "./stdio-relay-fixture.mjs";
import * as protocol from "../bridge-protocol.mjs";

const host = resolve(import.meta.dirname, "../native-host/bridge-host.mjs");
const helperPath = resolve(import.meta.dirname, "../helper-extension/service-worker.js");
const protocolPath = resolve(import.meta.dirname, "../bridge-protocol.mjs");
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
  const next = (timeoutMs = 3000) => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("raw broker response timed out")), timeoutMs);
    waiters.push((value) => { clearTimeout(timer); resolve(value); });
  });
  const send = (msg) => socket.write(encode(msg));
  const joinId = randomUUID();
  send({ type: "hello", version: 1, id: joinId });
  const ready = await next(); assert.equal(ready.type, "ready"); assert.equal(ready.id, joinId);
  return { socket, next, send, session: ready.session };
}
async function waitFor(testFn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (testFn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("Timed out waiting for broker/helper lifecycle event");
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
}

test("production broker stdio relay + native host + actual helper service worker + bridge client", async (t) => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\pi-bridge-e2e-${randomUUID()}` : join(tmpdir(), `pi-bridge-e2e-${randomUUID()}.sock`);
  const privateDir = await mkdtemp(join(tmpdir(), `pi-bridge-e2e-${randomUUID()}-`));
  if (process.platform !== "win32") await chmod(privateDir, 0o700);
  else {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const sidOutput = execFileSync(join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    const userSid = sidOutput.match(/S-\d-\d+(?:-\d+)+/)?.[0];
    assert.ok(userSid, "test account SID available");
    execFileSync(join(systemRoot, "System32", "icacls.exe"), [privateDir, "/inheritance:r", "/grant:r", `*${userSid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { windowsHide: true, stdio: "ignore" });
  }
  const configPath = join(privateDir, "host-config.json");
  await writeFile(configPath, JSON.stringify(process.platform === "win32" ? { pipeName: socketPath, extensionOrigin: "chrome-extension://fixture/" } : { socketPath }), { mode: 0o600 });
  if (process.platform !== "win32") await chmod(configPath, 0o600);

  let broker, native, relay, client;
  const openSockets = new Set();
  t.after(async () => {
    for (const socket of openSockets) socket.destroy();
    await client?.close().catch(() => {});
    await stop(native); await stop(broker);
    await relay?.close();
    await rm(privateDir, { recursive: true, force: true });
  });

  const env = { ...process.env }; delete env.PI_BROWSER_BRIDGE_SOCKET;
  broker = spawn(process.execPath, [host, "--broker-stdio", "--config", configPath], { env, stdio: ["pipe", "pipe", "pipe"] });
  let brokerDiagnostics = "";
  broker.stderr.on("data", (b) => { brokerDiagnostics += b.toString(); });
  relay = startStdioRelayFixture(socketPath, broker);
  await relay.listening;
  if (process.platform !== "win32") assert.equal((await stat(socketPath)).mode & 0o077, 0, "test relay endpoint is owner-only");

  native = spawn(process.execPath, [host, "--native", "--config", configPath], { env, stdio: ["pipe", "pipe", "pipe"] });
  let nativeDiagnostics = "";
  native.stderr.on("data", (b) => { nativeDiagnostics += b.toString(); });
  native.stderr.on("data", () => {});
  const source = (await import("node:fs/promises")).readFile;
  const workerSource = await source(helperPath, "utf8");
  const rewritten = workerSource.replace('"./bridge-protocol.mjs"', JSON.stringify(pathToFileURL(protocolPath).href));
  assert.notEqual(rewritten, workerSource, "helper protocol import resolved to canonical protocol asset");
  const helperUrl = `data:text/javascript;base64,${Buffer.from(rewritten).toString("base64")}`;
  const helper = await import(helperUrl);

  let tabs = [{ id: 22, url: "https://example.test/page", title: "mock page" }];
  let resolvePress, blockNextPress = false;
  const helperStates = [], cdps = [];
  let dispatchCount = 0, cancelCount = 0, dragMouseUps = 0, nativeReady;
  const nativeListeners = [], disconnectListeners = [];
  const nativePort = {
    postMessage(message) { native.stdin.write(encode(message)); },
    onMessage: { addListener(fn) { nativeListeners.push(fn); } },
    onDisconnect: { addListener(fn) { disconnectListeners.push(fn); } },
  };
  const chromeApi = {
    runtime: { id: "fixture-extension", connectNative(name) { assert.equal(name, "com.pi_agent_extensions.browser_bridge"); return nativePort; }, async sendMessage(message) { if (message.type === "helper-state") helperStates.push(message); } },
    tabs: { query: async () => tabs, get: async (tabId) => { const tab = tabs.find((item) => item.id === tabId); if (!tab) throw new Error("tab missing"); return tab; }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    debugger: {
      attach: async () => {}, detach: async () => {},
      async sendCommand(_target, method, args) {
        cdps.push({ method, args });
        if (args.type === "mousePressed") {
          dispatchCount++;
          if (blockNextPress) { blockNextPress = false; await new Promise((resolve) => { resolvePress = resolve; }); }
        }
        if (args.type === "mouseReleased") dragMouseUps++;
        if (method === "Page.captureScreenshot") return { data: "aGVsbG8=" };
        return {};
      },
    },
  };

  let out = Buffer.alloc(0);
  native.stdout.on("data", (chunk) => {
    out = Buffer.concat([out, chunk]);
    while (out.length >= 4) {
      const n = out.readUInt32LE(0); if (!n || n > MAX) { native.kill(); return; }
      if (out.length < n + 4) return;
      const msg = JSON.parse(out.subarray(4, n + 4).toString("utf8")); out = out.subarray(n + 4);
      if (msg.type === "ready") { protocol.validateNativeResponse(msg); nativeReady = msg; }
      if (msg.type === "cancel") cancelCount++;
      for (const listener of nativeListeners) listener(msg);
    }
  });
  helper.connectNative(chromeApi);
  await waitFor(() => Boolean(nativeReady));
  assert.ok(nativeReady.session);

  client = createBridgeClient({ configPath, timeoutMs: 2000 });
  const clientSession = (await client.connect()).session;
  assert.ok(clientSession && clientSession !== nativeReady.session, "each client has its own broker session");
  const targets = await client.listTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].tabId, 22);
  const targetId = targets[0].id;
  assert.ok(targetId && targetId !== "extension-local-placeholder", "broker mints opaque IDs from raw helper inventory");
  assert.equal((await helper.onUiMessage({ type: "get-state" }, chromeApi)).targets[0].id, targetId);

  const forged = await rawClient(socketPath); openSockets.add(forged.socket);
  const forgedClosed = new Promise((resolve) => forged.socket.once("close", resolve));
  forged.send({ type: "request", id: "forged-id", session: "forged-session", request: { version: 1, id: "forged-id", session: "forged-session", target: targetId, action: "observe", args: {} } });
  await Promise.race([forgedClosed, new Promise((_, reject) => setTimeout(() => reject(new Error("forged session was not rejected")), 1000))]);
  const denied = await client.request("click", { x: 1, y: 2, button: "left" }, { targetId });
  assert.equal(denied.ok, false); assert.equal(denied.error.code, "UNAUTHORIZED");

  await helper.onUiMessage({ type: "grant", targetId, origin: "https://example.test" }, chromeApi);
  await waitFor(() => helperStates.some((state) => state.grants.includes(targetId)));
  const first = await rawClient(socketPath), second = await rawClient(socketPath);
  openSockets.add(first.socket); openSockets.add(second.socket);
  assert.notEqual(first.session, second.session);
  const sharedId = "cross-client-id";
  blockNextPress = true;
  first.send({ type: "request", id: sharedId, session: first.session, request: { version: 1, id: sharedId, session: first.session, target: targetId, action: "drag", args: { start: { x: 1, y: 1 }, end: { x: 20, y: 20 }, button: "left" } } });
  await waitFor(() => Boolean(resolvePress));
  const dispatchedCount = dispatchCount;
  second.send({ type: "cancel", id: sharedId, session: second.session });
  second.send({ type: "request", id: sharedId, session: second.session, request: { version: 1, id: sharedId, session: second.session, target: targetId, action: "click", args: { x: 2, y: 2, button: "left" } } });
  const duplicate = await second.next();
  assert.equal(duplicate.response.error.code, "INVALID_REQUEST");
  assert.equal(dispatchCount, dispatchedCount, "duplicate request ID does not dispatch another action");
  assert.equal(cancelCount, 0, "another connection cannot cancel the owner request");
  resolvePress(); resolvePress = undefined;
  const firstResult = await first.next();
  assert.equal(firstResult.response.id, sharedId); assert.equal(firstResult.response.session, first.session);
  first.socket.destroy(); second.socket.destroy();

  const delivered = await client.request("click", { x: 4, y: 6, button: "left" }, { targetId });
  protocol.validateResponse(delivered); assert.equal(delivered.ok, true, JSON.stringify(delivered)); assert.equal(delivered.result.accepted, true);
  blockNextPress = true;
  const abort = new AbortController();
  const cancelled = client.request("drag", { start: { x: 2, y: 3 }, end: { x: 55, y: 65 }, button: "left" }, { targetId, signal: abort.signal });
  await waitFor(() => Boolean(resolvePress));
  abort.abort();
  await assert.rejects(cancelled, /outcome may be uncertain/i);
  await waitFor(() => cancelCount > 0);
  resolvePress(); resolvePress = undefined;
  await waitFor(() => dragMouseUps >= 2);

  await helper.onUiMessage({ type: "revoke", targetId }, chromeApi);
  await waitFor(() => !helperStates.at(-1)?.grants.includes(targetId));
  const revoked = await client.request("click", { x: 4, y: 6, button: "left" }, { targetId });
  assert.equal(revoked.error.code, "UNAUTHORIZED");

  tabs = [];
  await helper.onUiMessage({ type: "targets-refresh" }, chromeApi);
  await waitFor(() => helperStates.at(-1)?.targets.length === 0);
  await assert.rejects(client.request("click", { x: 4, y: 6, button: "left" }, { targetId }), /absent from the latest broker catalog/i);
  assert.equal(nativeDiagnostics, "", `native/extension diagnostics: ${nativeDiagnostics}`);
  assert.equal(brokerDiagnostics, "", `broker diagnostics: ${brokerDiagnostics}`);
});
