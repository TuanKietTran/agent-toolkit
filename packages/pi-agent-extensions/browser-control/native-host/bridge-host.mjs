#!/usr/bin/env node
import net from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chmod, unlink } from "node:fs/promises";
import { defaultConfigPath, resolveSocketPath } from "./ipc-path.mjs";
import { loadRuntimeConfig } from "./runtime-config.mjs";
import { validateRequest, validateResponse, validateNativeRequest, validateNativeResponse, MAX_MESSAGE_BYTES } from "../bridge-protocol.mjs";

const MAX = MAX_MESSAGE_BYTES;
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
    socket.on("error", onError);
    socket.on("close", () => onError(new Error("IPC closed")));
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
        this.onMessage(value);
      }
    } catch (error) { this.onError(error); this.socket.destroy(); }
  }
  send(value) { this.socket.write(encode(value)); }
}
function strict(value, required, allowed = required) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !allowed.includes(k)) || required.some((k) => !Object.hasOwn(value, k))) throw new Error("Invalid broker IPC message fields");
}
function validateTargets(targets) {
  if (!Array.isArray(targets) || targets.length > 256) throw new Error("Invalid target catalog");
  for (const target of targets) {
    validateNativeResponse({ type: "targets", targets: [target] });
  }
  return targets;
}

/** Start the broker on an OS local IPC endpoint. Unix sockets are owner-only;
 * Windows named pipes use the creating user's default security descriptor. */
export async function startBroker(socketPath, { testOnlyInsecurePipe = false } = {}) {
  socketPath = resolveSocketPath(socketPath);
  if (process.platform === "win32" && !testOnlyInsecurePipe) throw new Error("Windows broker is disabled: Node net cannot apply the required current-user named-pipe DACL; use the ACL-secured .NET broker relay");
  const localPath = process.platform === "win32" ? socketPath.startsWith("\\\\.\\pipe\\") : socketPath.startsWith("/");
  if (!localPath) throw new Error("Broker requires a local Unix socket or Windows named pipe");
  const clients = new Set(), inflight = new Map();
  let nativeSession = sessionId();
  let native = null, targets = [];
  const grants = new Map();
  const server = net.createServer((socket) => {
    let role, clientSession, closed = false;
    const conn = new Frames(socket, (msg) => {
      if (!role) {
        if (msg.type === "nativeJoin") {
          strict(msg, ["type", "version"]);
          if (msg.version !== 1 || native) { socket.destroy(); return; }
          if (!nativeSession) nativeSession = sessionId();
          role = "native"; native = conn;
          conn.send({ type: "nativeReady", version: 1, session: nativeSession });
          return;
        }
        strict(msg, ["type", "version", "id"]);
        if (msg.type !== "hello" || msg.version !== 1 || typeof msg.id !== "string") { socket.destroy(); return; }
        role = "client"; clientSession = nativeSession; conn.session = clientSession; clients.add(conn);
        conn.send({ type: "ready", version: 1, id: msg.id, session: clientSession, targets: [] });
        return;
      }
      if (role === "native") {
        if (msg.type === "targets") {
          try { validateNativeResponse(msg); targets = validateTargets(msg.targets); }
          catch { socket.destroy(); return; }
          for (const [id, origin] of grants) if (!targets.some((t) => t.id === id && t.origin === origin)) grants.delete(id);
          for (const c of clients) if (c.catalogId) c.send({ type: "targets", id: c.catalogId, session: c.session, targets });
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
          try { validateNativeResponse(msg); } catch { socket.destroy(); return; }
          const wait = inflight.get(msg.response.id);
          if (!wait || msg.response.session !== wait.session) return;
          inflight.delete(msg.response.id);
          wait.client.send({ type: "response", id: msg.response.id, session: wait.client.session, response: msg.response });
          return;
        }
        if (msg.type === "cancelled") {
          try { validateNativeResponse(msg); } catch { socket.destroy(); return; }
          return;
        }
        socket.destroy(); return;
      }
      if (msg.type === "targets") {
        strict(msg, ["type", "id", "session"]);
        if (msg.session !== clientSession || typeof msg.id !== "string") { socket.destroy(); return; }
        conn.catalogId = msg.id;
        if (native) { conn.catalogId = msg.id; native.send({ type: "targets" }); }
        else conn.send({ type: "targets", id: msg.id, session: clientSession, targets: [] });
        return;
      }
      if (msg.type === "cancel") {
        strict(msg, ["type", "id", "session"]);
        if (msg.session !== clientSession) { socket.destroy(); return; }
        const wait = inflight.get(msg.id);
        if (wait && native) native.send({ type: "cancel", session: wait.session, id: msg.id });
        return;
      }
      if (msg.type === "request") {
        strict(msg, ["type", "id", "session", "request"]);
        if (msg.session !== clientSession) { socket.destroy(); return; }
        let req;
        try { req = validateRequest(msg.request); } catch { conn.send({ type: "response", id: msg.id, session: clientSession, response: errorResponse(msg.request ?? { id: msg.id, session: clientSession }, "INVALID_REQUEST", "Invalid action request") }); return; }
        if (msg.id !== req.id || msg.session !== req.session) { socket.destroy(); return; }
        const target = targets.find((t) => t.id === req.target);
        if (req.session !== clientSession || req.session !== nativeSession || !target) {
          conn.send({ type: "response", id: msg.id, session: clientSession, response: errorResponse(req, "TARGET_NOT_FOUND", "Target unavailable" ) }); return;
        }
        if (grants.get(req.target) !== target.origin) {
          conn.send({ type: "response", id: msg.id, session: clientSession, response: errorResponse(req, "UNAUTHORIZED", "Target is not authorized") }); return;
        }
        if (!native) { conn.send({ type: "response", id: msg.id, session: clientSession, response: errorResponse(req, "UNAUTHORIZED", "Native extension is disconnected") }); return; }
        inflight.set(req.id, { client: conn, session: clientSession });
        native.send({ type: "execute", request: req });
        return;
      }
      socket.destroy();
    }, () => {
      if (role === "native" && native === conn) {
        native = null; nativeSession = null; targets = []; grants.clear();
        for (const [id] of inflight) inflight.delete(id);
        for (const client of clients) client.socket.destroy();
      }
      if (role === "client") clients.delete(conn);
      closed = true;
      for (const [id, wait] of inflight) if (wait.client === conn || conn === native) inflight.delete(id);
    });
    conn.session = clientSession;
    conn.catalogId = null;
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  if (process.platform !== "win32") await chmod(socketPath, 0o600);
  return { close: async () => {
    await new Promise((resolve) => server.close(resolve));
    if (process.platform !== "win32") await unlink(socketPath).catch(() => {});
  } };
}

/** Run as a Chrome Native Messaging host: stdin/stdout are exclusively Chrome's
 * 4-byte little-endian framed JSON protocol. Diagnostics go to stderr. */
export async function runNativeHost({ socketPath, configPath, input = process.stdin, output = process.stdout, testOnlyInsecurePipe = false } = {}) {
  configPath ||= process.platform === "win32" ? defaultConfigPath() : undefined;
  const config = await loadRuntimeConfig(configPath);
  socketPath = resolveSocketPath(socketPath || config.socketPath);
  if (process.platform === "win32" && !testOnlyInsecurePipe && (!configPath || !config.socketPath)) throw new Error("Windows native host requires a protected config path with an ACL-secured broker socketPath");
  const socket = await new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath); s.once("error", reject); s.once("connect", () => { s.removeAllListeners("error"); resolve(s); });
  });
  let ready = false, nativeSession;
  const sendNative = (v) => {
    if (v.type === "execute" || v.type === "cancel" || v.type === "targets") validateNativeRequest(v);
    else validateNativeResponse(v);
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
    if (msg.type === "execute") { validateNativeRequest(msg); sendNative(msg); return; }
    if (msg.type === "cancel" || msg.type === "targets") { validateNativeRequest(msg); sendNative(msg); return; }
    if (msg.type === "authorized" || msg.type === "revoked") { validateNativeResponse(msg); sendNative(msg); return; }
    if (msg.type === "error") { validateNativeResponse(msg); sendNative(msg); return; }
    throw new Error("Unexpected broker relay message");
  }, (error) => { if (!socket.destroyed) process.stderr.write(`browser bridge IPC closed: ${error.stack ?? error.message}\n`); });
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
      if (!hello) {
        validateNativeRequest(message);
        if (message.type !== "hello") throw new Error("Expected native hello");
        hello = true;
        while (!ready) await new Promise((r) => setTimeout(r, 2));
        sendNative({ type: "ready", version: 1, session: nativeSession, targets: [] });
      } else if (message.type === "targets") {
        validateNativeResponse(message);
        broker.send(message);
      } else if (message.type === "executeResult" || message.type === "cancelled") {
        validateNativeResponse(message);
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
  socket.end();
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const configIndex = args.indexOf("--config");
  const configPath = configIndex >= 0 ? args[configIndex + 1] : (process.platform === "win32" ? defaultConfigPath() : undefined);
  if (configIndex >= 0 && !configPath) throw new Error("--config requires a file path");
  const testOnlyInsecurePipe = args.includes("--test-only-insecure-pipe");
  const config = await loadRuntimeConfig(configPath);
  const socketPath = resolveSocketPath(config.socketPath);
  if (mode === "--broker") {
    const broker = await startBroker(socketPath, { testOnlyInsecurePipe });
    process.stderr.write("browser bridge broker ready on authenticated local IPC\n");
    const stop = async () => { await broker.close(); process.exit(0); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  } else if (mode === "--native") await runNativeHost({ socketPath, configPath, testOnlyInsecurePipe });
  else throw new Error("Usage: bridge-host.mjs --broker|--native [--config ABSOLUTE_CONFIG_PATH]");
}
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  main().catch((error) => { process.stderr.write(`browser bridge host: ${error.message}\n`); process.exitCode = 1; });
}
