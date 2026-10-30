import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createBridgeClient } from "../bridge-client.mjs";
import { startStdioRelayFixture } from "./stdio-relay-fixture.mjs";
import * as protocol from "../bridge-protocol.mjs";

const host = resolve(import.meta.dirname, "../native-host/bridge-host.mjs");
const installer = resolve(import.meta.dirname, "../native-host/install.mjs");
const mcpServer = resolve(import.meta.dirname, "../mcp-server.mjs");
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
async function waitPipe(path, child, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`broker exited ${child.exitCode}`);
    const socket = net.createConnection(path);
    const connected = await new Promise(resolveConnect => { socket.once("connect", () => resolveConnect(true)); socket.once("error", () => resolveConnect(false)); });
    if (connected) return socket;
    socket.destroy(); await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  throw new Error("Timed out waiting for production broker pipe");
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
}
class McpProcessClient {
  constructor(child) {
    this.child = child; this.nextId = 1; this.pending = new Map(); this.buffer = ""; this.parseError = null; this.stderr = ""; this.traceTypes = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      this.buffer += chunk;
      for (;;) {
        const end = this.buffer.indexOf("\n"); if (end < 0) break;
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try { const message = JSON.parse(line); if (message.jsonrpc !== "2.0") throw new Error("non-JSON-RPC stdout"); this.traceTypes.push(`response:${message.id}:${message.result ? "result" : "error"}`); const done = this.pending.get(message.id); if (done) { this.pending.delete(message.id); done(message); } }
        catch (error) { this.parseError = error; }
      }
    });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { this.stderr += chunk; });
  }
  request(method, params = {}) {
    const id = this.nextId++; this.lastId = id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timeout; argv=${JSON.stringify(this.child.spawnargs)} exit=${this.child.exitCode} stdoutTypes=${this.traceTypes.join(",")} partialBytes=${Buffer.byteLength(this.buffer)} stderr=${this.stderr}`)); }, 5000);
      this.pending.set(id, message => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); }
}

test("production broker relay + actual helper service worker + bridge client and MCP subprocess", async (t) => {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\pi-browser-bridge-${randomUUID().replace(/-/g, "").slice(0, 32)}` : join(tmpdir(), `pi-bridge-e2e-${randomUUID()}.sock`);
  const privateDir = await mkdtemp(join(tmpdir(), `pi-bridge-e2e-${randomUUID()}-`));
  if (process.platform !== "win32") await chmod(privateDir, 0o700);
  else {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const sidOutput = execFileSync(join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    const userSid = sidOutput.match(/S-\d-\d+(?:-\d+)+/)?.[0];
    assert.ok(userSid, "test account SID available");
    execFileSync(join(systemRoot, "System32", "icacls.exe"), [privateDir, "/inheritance:r", "/grant:r", `*${userSid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { windowsHide: true, stdio: "ignore" });
  }
  const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let configPath = join(privateDir, "host-config.json");
  let nativeManifest;
  if (process.platform === "win32") {
    const installed = spawnSync(process.execPath, [installer, "--install", "--fixture", privateDir, "--browser", "brave", "--extension-id", extensionId,
      "--pipe-name", socketPath, "--node", process.execPath, "--host-script", host,
      "--csc", "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"], { encoding: "utf8", timeout: 30000 });
    assert.equal(installed.status, 0, installed.stderr);
    const result = JSON.parse(installed.stdout);
    nativeManifest = JSON.parse(await (await import("node:fs/promises")).readFile(result.manifestPath, "utf8"));
    configPath = result.configPath;
    assert.equal(nativeManifest.path, join(privateDir, "PiBrowserBridge", "bridge-host.exe"));
  } else {
    await writeFile(configPath, JSON.stringify({ socketPath }), { mode: 0o600 });
    await chmod(configPath, 0o600);
  }

  let broker, native, relay, client, mcpChild;
  const openSockets = new Set();
  let traceStage = "fixture-setup";
  const stage = (name, promise) => { traceStage = name; return promise.catch(async error => {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    error.message = `stage=${name}; brokerArgv=${JSON.stringify(broker?.spawnargs)}; nativeArgv=${JSON.stringify(native?.spawnargs)}; brokerExit=${broker?.exitCode}; nativeExit=${native?.exitCode}; configPath=${configPath}; configKeys=${Object.keys(config).sort().join(",")}; pipeConfigured=${Boolean(config.pipeName || config.socketPath)}; extensionTypes=${nativeMessageTypes.join(",")}; helperOutputTypes=${helperPostedTypes.join(",")}; nativeWriteEvents=${nativeWriteEvents.join(",")}; helperTaskStates=${helperTaskResults.join(",")}; cdpEvents=${cdpEvents.join(",")}; cdpMethods=${cdps.map(call => call.method).join(",")}; nativeStderr=${nativeDiagnostics}; brokerStderr=${brokerDiagnostics}; ${error.message}`;
    throw error;
  }); };
  t.after(async () => {
    for (const socket of openSockets) socket.destroy();
    await client?.close().catch(() => {});
    await stop(mcpChild); await stop(native); await stop(broker);
    await relay?.close();
    await rm(privateDir, { recursive: true, force: true });
  });

  const env = { ...process.env }; delete env.PI_BROWSER_BRIDGE_SOCKET;
  let brokerDiagnostics = "";
  if (process.platform === "win32") {
    broker = spawn(nativeManifest.path, ["--broker", "--config", configPath], { env, stdio: ["ignore", "ignore", "pipe"] });
    broker.stderr.on("data", (b) => { brokerDiagnostics += b.toString(); });
    openSockets.add(await waitPipe(socketPath, broker));
  } else {
    broker = spawn(process.execPath, [host, "--broker-stdio", "--config", configPath], { env, stdio: ["pipe", "pipe", "pipe"] });
    broker.stderr.on("data", (b) => { brokerDiagnostics += b.toString(); });
    relay = startStdioRelayFixture(socketPath, broker);
    await relay.listening;
    assert.equal((await stat(socketPath)).mode & 0o077, 0, "test relay endpoint is owner-only");
  }

  native = process.platform === "win32"
    ? spawn(nativeManifest.path, [`chrome-extension://${extensionId}/`], { env, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(process.execPath, [host, "--native", "--config", configPath], { env, stdio: ["pipe", "pipe", "pipe"] });
  let nativeDiagnostics = "";
  native.stderr.on("data", (b) => { nativeDiagnostics += b.toString(); });
  native.stderr.on("data", () => {});
  const source = (await import("node:fs/promises")).readFile;
  const workerSource = await source(helperPath, "utf8");
  const rewritten = workerSource.replace('"../bridge-protocol.mjs"', JSON.stringify(pathToFileURL(protocolPath).href));
  assert.notEqual(rewritten, workerSource, "helper protocol import resolved to canonical protocol asset");
  const helperUrl = `data:text/javascript;base64,${Buffer.from(rewritten).toString("base64")}`;
  const helper = await import(helperUrl);

  let tabs = [{ id: 22, url: "https://example.test/page", title: "mock page" }];
  let resolvePress, blockNextPress = false;
  const helperStates = [], cdps = [], nativeMessageTypes = [], helperPostedTypes = [], nativeWriteEvents = [], helperTaskResults = [], cdpEvents = [];
  const helperTasks = new Set();
  let dispatchCount = 0, cancelCount = 0, dragMouseUps = 0, nativeReady;
  const nativeListeners = [], disconnectListeners = [];
  const nativePort = {
    postMessage(message) {
      helperPostedTypes.push(message.type);
      const accepted = native.stdin.write(encode(message), error => nativeWriteEvents.push(`${message.type}:${error ? `error:${error.code || error.name}` : "flushed"}`));
      nativeWriteEvents.push(`${message.type}:queued:${accepted}`);
    },
    onMessage: { addListener(fn) { nativeListeners.push(fn); } },
    onDisconnect: { addListener(fn) { disconnectListeners.push(fn); } },
  };
  const chromeApi = {
    runtime: { id: "fixture-extension", connectNative(name) { assert.equal(name, "com.pi_agent_extensions.browser_bridge"); return nativePort; }, async sendMessage(message) { if (message.type === "helper-state") helperStates.push(message); } },
    tabs: { query: async () => tabs, get: async (tabId) => { const tab = tabs.find((item) => item.id === tabId); if (!tab) throw new Error("tab missing"); return tab; }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    debugger: {
      attach: async () => {}, detach: async () => {},
      async sendCommand(_target, method, args) {
        cdps.push({ method, args }); cdpEvents.push(`${method}:begin`);
        try {
          if (args.type === "mousePressed") {
            dispatchCount++;
            if (blockNextPress) { blockNextPress = false; await new Promise((resolve) => { resolvePress = resolve; }); }
          }
          if (args.type === "mouseReleased") dragMouseUps++;
          const result = method === "Page.captureScreenshot" ? { data: "aGVsbG8=" } : {};
          cdpEvents.push(`${method}:resolved`);
          return result;
        } catch (error) { cdpEvents.push(`${method}:rejected:${error.name}`); throw error; }
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
      nativeMessageTypes.push(msg.type);
      if (msg.type === "ready") { protocol.validateNativeResponse(msg); nativeReady = msg; }
      if (msg.type === "cancel") cancelCount++;
      for (const listener of nativeListeners) {
        try {
          const task = listener(msg);
          if (task && typeof task.then === "function") {
            const tracked = Promise.resolve(task).then(
              () => { helperTaskResults.push(`${msg.type}:resolved`); },
              error => { helperTaskResults.push(`${msg.type}:rejected:${error.name}`); },
            ).finally(() => helperTasks.delete(tracked));
            helperTasks.add(tracked);
          }
        } catch (error) { helperTaskResults.push(`${msg.type}:threw:${error.name}`); }
      }
    }
  });
  helper.connectNative(chromeApi);
  try { await waitFor(() => Boolean(nativeReady)); }
  catch (error) { throw new Error(`${error.message}; nativeExit=${native.exitCode}; nativeStderr=${nativeDiagnostics}; brokerExit=${broker.exitCode}; brokerStderr=${brokerDiagnostics}`); }
  assert.ok(nativeReady.session);

  client = createBridgeClient({ configPath, timeoutMs: 10_000 });
  const clientSession = (await stage("bridge-client-connect", client.connect())).session;
  assert.ok(clientSession && clientSession !== nativeReady.session, "each client has its own broker session");
  const targets = await stage("bridge-client-targets", client.listTargets());
  assert.equal(targets.length, 1);
  assert.equal(targets[0].tabId, 22);
  const targetId = targets[0].id;
  assert.ok(targetId && targetId !== "extension-local-placeholder", "broker mints opaque IDs from raw helper inventory");
  assert.equal((await helper.onUiMessage({ type: "get-state" }, chromeApi)).targets[0].id, targetId);

  const forged = await rawClient(socketPath); openSockets.add(forged.socket);
  const forgedClosed = new Promise((resolve) => forged.socket.once("close", resolve));
  forged.send({ type: "request", id: "forged-id", session: "forged-session", request: { version: 1, id: "forged-id", session: "forged-session", target: targetId, action: "observe", args: {} } });
  await Promise.race([forgedClosed, new Promise((_, reject) => setTimeout(() => reject(new Error("forged session was not rejected")), 1000))]);
  const denied = await stage("bridge-client-denied-click", client.request("click", { x: 1, y: 2, button: "left" }, { targetId }));
  assert.equal(denied.ok, false); assert.equal(denied.error.code, "UNAUTHORIZED");

  await helper.onUiMessage({ type: "grant", targetId, origin: "https://example.test" }, chromeApi);
  await waitFor(() => helperStates.some((state) => state.grants.includes(targetId)));
  const mcpEnv = process.platform === "win32"
    ? { ...env, LOCALAPPDATA: privateDir }
    : { ...env, PI_BROWSER_BRIDGE_SOCKET: socketPath, PI_BROWSER_BRIDGE_TEST_MODE: "1" };
  mcpChild = spawn(process.execPath, [mcpServer], { env: mcpEnv, stdio: ["pipe", "pipe", "pipe"] });
  const mcpClient = new McpProcessClient(mcpChild);
  assert.equal((await stage("mcp-initialize", mcpClient.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bridge-e2e", version: "1" } }))).result.serverInfo.name, "pi-browser-bridge");
  mcpClient.notify("notifications/initialized");
  const mcpTargets = await stage("mcp-targets", mcpClient.request("tools/call", { name: "browser_targets", arguments: {} }));
  assert.match(mcpTargets.result.content[0].text, new RegExp(targetId));
  const mcpClick = await stage("mcp-click", mcpClient.request("tools/call", { name: "browser_click", arguments: { targetId, x: 3, y: 4 } }));
  assert.equal(mcpClick.result.isError, false);
  const mcpObserve = await stage("mcp-observe", mcpClient.request("tools/call", { name: "browser_observe", arguments: { targetId } }));
  assert.equal(mcpObserve.result.content[0].type, "image");
  assert.equal(mcpObserve.result.content[0].data, "aGVsbG8=");
  const mcpUpsBefore = dragMouseUps;
  blockNextPress = true;
  const mcpDrag = mcpClient.request("tools/call", { name: "browser_drag", arguments: { targetId, start: { x: 2, y: 3 }, end: { x: 30, y: 40 } } });
  await waitFor(() => Boolean(resolvePress));
  const mcpDragId = mcpClient.lastId;
  mcpClient.notify("notifications/cancelled", { requestId: mcpDragId });
  resolvePress(); resolvePress = undefined;
  const mcpCancelled = await stage("mcp-drag-cancel", mcpDrag);
  assert.equal(mcpCancelled.error?.code, -32800);
  await waitFor(() => dragMouseUps > mcpUpsBefore, 5000);
  assert.equal(mcpClient.parseError, null, "MCP stdout contains only JSON-RPC messages");
  assert.equal(mcpClient.stderr, "", "normal MCP operations emit no diagnostics");
  const first = await rawClient(socketPath), second = await rawClient(socketPath);
  openSockets.add(first.socket); openSockets.add(second.socket);
  assert.notEqual(first.session, second.session);
  const sharedId = "cross-client-id";
  blockNextPress = true;
  first.send({ type: "request", id: sharedId, session: first.session, request: { version: 1, id: sharedId, session: first.session, target: targetId, action: "drag", args: { start: { x: 1, y: 1 }, end: { x: 20, y: 20 }, button: "left" } } });
  await waitFor(() => Boolean(resolvePress));
  const dispatchedCount = dispatchCount, cancelsBeforeCrossClient = cancelCount;
  second.send({ type: "cancel", id: sharedId, session: second.session });
  second.send({ type: "request", id: sharedId, session: second.session, request: { version: 1, id: sharedId, session: second.session, target: targetId, action: "click", args: { x: 2, y: 2, button: "left" } } });
  const duplicate = await second.next();
  assert.equal(duplicate.response.error.code, "INVALID_REQUEST");
  assert.equal(dispatchCount, dispatchedCount, "duplicate request ID does not dispatch another action");
  assert.equal(cancelCount, cancelsBeforeCrossClient, "another connection cannot cancel the owner request");
  resolvePress(); resolvePress = undefined;
  const firstResult = await first.next();
  assert.equal(firstResult.response.id, sharedId); assert.equal(firstResult.response.session, first.session);
  first.socket.destroy(); second.socket.destroy();

  const delivered = await stage("bridge-client-delivered-click", client.request("click", { x: 4, y: 6, button: "left" }, { targetId }));
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
  const revoked = await stage("bridge-client-revoked-click", client.request("click", { x: 4, y: 6, button: "left" }, { targetId }));
  assert.equal(revoked.error.code, "UNAUTHORIZED");

  tabs = [];
  await helper.onUiMessage({ type: "targets-refresh" }, chromeApi);
  await waitFor(() => helperStates.at(-1)?.targets.length === 0);
  await assert.rejects(client.request("click", { x: 4, y: 6, button: "left" }, { targetId }), /absent from the latest broker catalog/i);
  assert.equal(nativeDiagnostics, "", `native/extension diagnostics: ${nativeDiagnostics}`);
  assert.equal(brokerDiagnostics, "", `broker diagnostics: ${brokerDiagnostics}`);
});
