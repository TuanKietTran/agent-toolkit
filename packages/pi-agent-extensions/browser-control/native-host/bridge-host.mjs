#!/usr/bin/env node
import net from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chmod, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { runBrokerStdio } from "./broker-stdio.mjs";
import { defaultConfigPath, resolveSocketPath } from "./ipc-path.mjs";
import { loadRuntimeConfig } from "./runtime-config.mjs";
import { validateRequest, validateResponse, validateNativeRequest, validateNativeResponse, MAX_MESSAGE_BYTES } from "../bridge-protocol.mjs";

const MAX = MAX_MESSAGE_BYTES;
const trace = (line) => { if (process.env.PI_BROWSER_BRIDGE_TRACE === "1") process.stderr.write(`[PI-BRIDGE-TRACE] ${line}\\n`); };
const sessionId = () => randomUUID();
const errorResponse = (req, code, message) => ({ version: 1, id: req.id, session: req.session, ok: false, error: { code, message: message.slice(0, 512), retryable: false } });
function encode(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (!body.length || body.length > MAX) throw new Error("Bridge frame exceeds 1 MiB");
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
class Frames {
  constructor(socket, onMessage, onError = () => {}) {
    this.socket = socket; this.onMessage = onMessage; this.onError = onError; this.buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => this.consume(chunk));
    let ended = false;
    const end = () => { if (!ended) { ended = true; onError(new Error("IPC closed")); } };
    socket.on("error", end);
    socket.on("end", end);
    socket.on("close", end);
  }
  consume(chunk) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const n = this.buffer.readUInt32LE(0);
        if (!n || n > MAX) throw new Error("Invalid IPC frame length");
        if (this.buffer.length < n + 4) return;
        const bytes = this.buffer.subarray(4, n + 4); this.buffer = this.buffer.subarray(n + 4);
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid IPC message object");
        trace(`ipc-in type=${typeof value.type === "string" ? value.type : "invalid"}`);
        this.onMessage(value);
      }
    } catch (error) { this.onError(error); this.socket.destroy(); }
  }
  send(value) { trace(`ipc-out type=${typeof value.type === "string" ? value.type : "invalid"}`); this.socket.write(encode(value)); }
}
function strict(value, required, allowed = required) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !allowed.includes(k)) || required.some((k) => !Object.hasOwn(value, k))) throw new Error("Invalid broker IPC message fields");
}
/** Start the broker on an OS local IPC endpoint. Unix sockets are owner-only;
 * Windows named pipes use the creating user's default security descriptor. */
export async function startBroker(socketPath, { connectionServer } = {}) {
  if (!connectionServer) socketPath = resolveSocketPath(socketPath);
  if (process.platform === "win32" && !connectionServer) throw new Error("Windows broker must run behind the ACL-secured C# relay (`--broker-stdio`)");
  if (!connectionServer) {
    const localPath = socketPath.startsWith("/");
    if (!localPath) throw new Error("Broker requires a local Unix socket");
  }
  trace("broker-state-engine starting");
  const clients = new Set(), inflight = new Map(), completedIds = new Set();
  let nativeSession = sessionId();
  const MAX_INFLIGHT = 128, REQUEST_LIFETIME_MS = 30_000;
  const rememberCompleted = (id) => { completedIds.add(id); if (completedIds.size > 1024) completedIds.delete(completedIds.values().next().value); };
  let native = null, targets = [];
  const grants = new Map();
  const onConnection = (socket) => {
    let role, clientSession, closed = false;
    const conn = new Frames(socket, (msg) => {
      if (!role) {
        const isNative = msg.type === "nativeJoin";
        if (isNative) strict(msg, ["type", "version"]);
        else strict(msg, ["type", "version", "id"]);
        if (msg.version !== 1) { socket.destroy(); return; }
        if (isNative) {
          if (native) { socket.destroy(); return; }
          if (!nativeSession) nativeSession = sessionId();
          role = "native"; native = conn;
          conn.send({ type: "nativeReady", version: 1, session: nativeSession });
        } else {
          if (msg.type !== "hello" || typeof msg.id !== "string" || !msg.id) { socket.destroy(); return; }
          role = "client"; clientSession = sessionId(); conn.session = clientSession; clients.add(conn);
          conn.send({ type: "ready", version: 1, id: msg.id, session: clientSession, targets: [] });
        }
        return;
      }
      if (role === "native") {
        if (msg.type === "targetInventory") {
          try { validateNativeRequest(msg); } catch { socket.destroy(); return; }
          if (msg.session !== nativeSession) { socket.destroy(); return; }
          const priorByTab = new Map(targets.map((target) => [target.tabId, target]));
          targets = msg.tabs.map((tab) => {
            const prior = priorByTab.get(tab.tabId);
            return { ...tab, id: prior?.origin === tab.origin ? prior.id : randomUUID() };
          });
          for (const [id, origin] of grants) if (!targets.some((target) => target.id === id && target.origin === origin)) grants.delete(id);
          native.send({ type: "targets", session: nativeSession, targets });
          for (const c of clients) if (c.catalogId) c.send({ type: "targets", id: c.catalogId, session: c.session, targets });
          return;
        }
        if (msg.type === "targets") {
          try { validateNativeRequest(msg); } catch { socket.destroy(); return; }
          if (msg.session !== nativeSession) { socket.destroy(); return; }
          native.send({ type: "targetsRequest", session: nativeSession });
          return;
        }
        if (msg.type === "authorize") {
          try { validateNativeRequest(msg); } catch { socket.destroy(); return; }
          if (msg.session !== nativeSession || !targets.some((t) => t.id === msg.targetId && t.origin === msg.origin)) {
            conn.send({ type: "error", code: "UNAUTHORIZED", message: "Authorization target is not live" }); return;
          }
          grants.set(msg.targetId, msg.origin);
          conn.send({ type: "authorized", session: nativeSession, targetId: msg.targetId, origin: msg.origin });
          return;
        }
        if (msg.type === "revoke") {
          try { validateNativeRequest(msg); } catch { socket.destroy(); return; }
          if (msg.session === nativeSession) grants.delete(msg.targetId);
          conn.send({ type: "revoked", session: nativeSession, targetId: msg.targetId, reason: "revoked" });
          return;
        }
        if (msg.type === "authorized") {
          try { validateNativeResponse(msg); } catch { socket.destroy(); return; }
          if (msg.session !== nativeSession || !targets.some((t) => t.id === msg.targetId && t.origin === msg.origin)) return;
          grants.set(msg.targetId, msg.origin);
          return;
        }
        if (msg.type === "revoked") {
          try { validateNativeResponse(msg); } catch { socket.destroy(); return; }
          if (msg.session === nativeSession) grants.delete(msg.targetId);
          return;
        }
        if (msg.type === "executeResult") {
          try { validateNativeRequest(msg); } catch { socket.destroy(); return; }
          const wait = inflight.get(msg.response.id);
          if (!wait || msg.response.session !== wait.nativeSession) { if (!completedIds.has(msg.response.id)) socket.destroy(); return; }
          inflight.delete(msg.response.id); clearTimeout(wait.timer); rememberCompleted(msg.response.id);
          const response = { ...msg.response, session: wait.clientSession };
          wait.client.send({ type: "response", id: msg.response.id, session: wait.clientSession, response });
          return;
        }
        if (msg.type === "cancelled") {
          try { validateNativeRequest(msg); } catch { socket.destroy(); return; }
          return;
        }
        socket.destroy(); return;
      }
      if (msg.type === "targets") {
        strict(msg, ["type", "id", "session"]);
        if (msg.session !== clientSession || typeof msg.id !== "string") { socket.destroy(); return; }
        conn.catalogId = msg.id;
        if (native) { conn.catalogId = msg.id; native.send({ type: "targetsRequest", session: nativeSession }); }
        else conn.send({ type: "targets", id: msg.id, session: clientSession, targets: [] });
        return;
      }
      if (msg.type === "cancel") {
        strict(msg, ["type", "id", "session"]);
        if (msg.session !== clientSession) { socket.destroy(); return; }
        const wait = inflight.get(msg.id);
        if (wait && wait.client === conn && wait.clientSession === clientSession && native) native.send({ type: "cancel", session: wait.nativeSession, id: msg.id });
        return;
      }
      if (msg.type === "request") {
        strict(msg, ["type", "id", "session", "request"]);
        if (msg.session !== clientSession) { socket.destroy(); return; }
        let req;
        try { req = validateRequest(msg.request); } catch { conn.send({ type: "response", id: msg.id, session: clientSession, response: errorResponse(msg.request ?? { id: msg.id, session: clientSession }, "INVALID_REQUEST", "Invalid action request") }); return; }
        if (msg.id !== req.id || msg.session !== req.session) { socket.destroy(); return; }
        const target = targets.find((t) => t.id === req.target);
        if (req.session !== clientSession || !target || !native || !nativeSession) {
          conn.send({ type: "response", id: msg.id, session: clientSession, response: errorResponse(req, "TARGET_NOT_FOUND", "Target unavailable" ) }); return;
        }
        if (grants.get(req.target) !== target.origin) {
          conn.send({ type: "response", id: msg.id, session: clientSession, response: errorResponse(req, "UNAUTHORIZED", "Target is not authorized") }); return;
        }
        if (inflight.has(req.id) || completedIds.has(req.id)) {
          conn.send({ type: "response", id: msg.id, session: clientSession, response: errorResponse(req, "INVALID_REQUEST", "Duplicate or recently completed request id") }); return;
        }
        if (inflight.size >= MAX_INFLIGHT) {
          conn.send({ type: "response", id: msg.id, session: clientSession, response: errorResponse(req, "TOO_LARGE", "Broker in-flight request limit reached") }); return;
        }
        const wait = { client: conn, clientSession, nativeSession, clientRequest: req, timer: null };
        wait.timer = setTimeout(() => {
          if (inflight.get(req.id) !== wait) return;
          inflight.delete(req.id); rememberCompleted(req.id);
          try { native?.send({ type: "cancel", session: nativeSession, id: req.id }); } catch {}
          conn.send({ type: "response", id: req.id, session: clientSession, response: errorResponse(req, "TIMEOUT", "Native action timed out; effect may be uncertain") });
        }, REQUEST_LIFETIME_MS);
        wait.timer.unref?.();
        inflight.set(req.id, wait);
        native.send({ type: "execute", request: { ...req, session: nativeSession } });
        return;
      }
      socket.destroy();
    }, () => {
      if (role === "native" && native === conn) {
        native = null; nativeSession = null; targets = []; grants.clear();
        for (const [id, wait] of inflight) { clearTimeout(wait.timer); inflight.delete(id); rememberCompleted(id); }
        for (const client of clients) client.socket.destroy();
      }
      if (role === "client") clients.delete(conn);
      closed = true;
      for (const [id, wait] of inflight) if (wait.client === conn) {
        clearTimeout(wait.timer); inflight.delete(id); rememberCompleted(id);
        try { if (native) native.send({ type: "cancel", session: wait.nativeSession, id }); } catch {}
      }
    });
    conn.session = clientSession;
    conn.catalogId = null;
  };
  const server = connectionServer ?? net.createServer(onConnection);
  if (connectionServer) connectionServer.on("connection", onConnection);
  else {
    await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
    await chmod(socketPath, 0o600);
  }
  return { close: async () => {
    if (connectionServer) connectionServer.removeListener("connection", onConnection);
    else {
      await new Promise((resolve) => server.close(resolve));
      await unlink(socketPath).catch(() => {});
    }
  } };
}

/** Run as a Chrome Native Messaging host: stdin/stdout are exclusively Chrome's
 * 4-byte little-endian framed JSON protocol. Diagnostics go to stderr. */
export async function runNativeHost({ socketPath, configPath, input = process.stdin, output = process.stdout } = {}) {
  configPath ||= process.platform === "win32" ? defaultConfigPath() : undefined;
  const config = await loadRuntimeConfig(configPath);
  socketPath = resolveSocketPath(socketPath || config.pipeName || config.socketPath);
  if (process.platform === "win32" && (!configPath || !config.pipeName)) throw new Error("Windows native host requires protected config with pipeName");
  const socket = await new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath); s.once("error", reject); s.once("connect", () => { s.removeAllListeners("error"); resolve(s); });
  });
  let ready = false, nativeSession;
  const sendNative = (v) => {
    validateNativeResponse(v);
    trace(`native-out type=${v.type}`);
    const b = Buffer.from(JSON.stringify(v));
    if (b.length > MAX) throw new Error("Native message exceeds 1 MiB");
    const h = Buffer.alloc(4); h.writeUInt32LE(b.length); output.write(Buffer.concat([h, b]));
  };
  const broker = new Frames(socket, (msg) => {
    if (!ready) {
      strict(msg, ["type", "version", "session"]);
      if (msg.type !== "nativeReady" || msg.version !== 1 || typeof msg.session !== "string") throw new Error("Broker native join failed");
      ready = true; nativeSession = msg.session; return;
    }
    if (msg.type === "execute" || msg.type === "cancel" || msg.type === "targetsRequest" || msg.type === "targets") { validateNativeResponse(msg); sendNative(msg); return; }
    if (msg.type === "authorized" || msg.type === "revoked") { validateNativeResponse(msg); sendNative(msg); return; }
    if (msg.type === "error") { validateNativeResponse(msg); sendNative(msg); return; }
    throw new Error("Unexpected broker relay message");
  }, (error) => { if (!socket.destroyed) process.stderr.write(`browser bridge IPC closed: ${error.stack ?? error.message}\n`); });
  trace("native-bridge sending nativeJoin");
  broker.send({ type: "nativeJoin", version: 1 });
  let buffer = Buffer.alloc(0), hello = false;
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const n = buffer.readUInt32LE(0);
      if (!n || n > MAX) throw new Error("Invalid Chrome Native Messaging frame length");
      if (buffer.length < n + 4) break;
      const bytes = buffer.subarray(4, n + 4); buffer = buffer.subarray(n + 4);
      const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      trace(`native-in type=${typeof message.type === "string" ? message.type : "invalid"}`);
      if (!hello) {
        validateNativeRequest(message);
        if (message.type !== "hello") throw new Error("Expected native hello");
        hello = true;
        while (!ready) await new Promise((r) => setTimeout(r, 2));
        sendNative({ type: "ready", version: 1, session: nativeSession, targets: [] });
        // The extension supplies raw inventory; the broker assigns opaque IDs.
        sendNative({ type: "targetsRequest", session: nativeSession });
      } else if (message.type === "targetInventory") {
        validateNativeRequest(message);
        broker.send(message);
      } else if (message.type === "targets") {
        validateNativeRequest(message);
        broker.send(message);
      } else if (message.type === "executeResult" || message.type === "cancelled") {
        validateNativeRequest(message);
        broker.send(message);
      } else if (message.type === "authorize" || message.type === "revoke") {
        validateNativeRequest(message);
        broker.send(message);
      } else if (message.type === "cancel") {
        validateNativeRequest(message);
        broker.send(message);
      } else throw new Error("Unsupported native message");
    }
  }
  trace("native-bridge input EOF; ending broker peer");
  socket.end();
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const configIndex = args.indexOf("--config");
  const configPath = configIndex >= 0 ? args[configIndex + 1] : (process.platform === "win32" ? defaultConfigPath() : undefined);
  trace(`process mode=${mode || "none"} config=${basename(configPath || "default")}`);
  if (configIndex >= 0 && !configPath) throw new Error("--config requires a file path");
  const config = await loadRuntimeConfig(configPath, { required: process.platform === "win32" });
  const socketPath = resolveSocketPath(config.pipeName || config.socketPath);
  if (mode === "--broker-stdio") {
    if (process.platform === "win32" && !config.pipeName) throw new Error("Windows broker worker requires configured pipeName");
    await runBrokerStdio({ onPeer: (connectionServer) => startBroker(undefined, { connectionServer }) });
    trace("broker-stdio child output ended");
    return;
  }
  if (mode === "--broker") {
    const broker = await startBroker(socketPath);
    process.stderr.write("browser bridge broker ready on authenticated local IPC\n");
    const stop = async () => { await broker.close(); process.exit(0); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  } else if (mode === "--native") await runNativeHost({ socketPath, configPath });
  else throw new Error("Usage: bridge-host.mjs --broker|--broker-stdio|--native [--config ABSOLUTE_CONFIG_PATH]");
}
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  main().catch((error) => { process.stderr.write(`browser bridge host: ${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
