import net from "node:net";
import { randomUUID } from "node:crypto";
import { validateRequest, validateResponse, validateNativeResponse } from "./bridge-protocol.mjs";
import { defaultConfigPath, resolveSocketPath } from "./native-host/ipc-path.mjs";
import { loadRuntimeConfig } from "./native-host/runtime-config.mjs";

export const MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const coded = (code, message) => Object.assign(new Error(message), { code });

function encode(value) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length > MAX_MESSAGE_BYTES) throw coded("TOO_LARGE", "Bridge message exceeds 1 MiB");
  const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}
function consume(state, chunk, onMessage) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 4) {
    const size = state.buffer.readUInt32LE(0);
    if (!size || size > MAX_MESSAGE_BYTES) throw coded("TOO_LARGE", "Invalid bridge frame length");
    if (state.buffer.length < size + 4) return;
    const bytes = state.buffer.subarray(4, size + 4);
    state.buffer = state.buffer.subarray(size + 4);
    let message;
    try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw coded("INVALID_REQUEST", "Malformed bridge frame"); }
    if (!message || Array.isArray(message) || typeof message !== "object") throw coded("INVALID_REQUEST", "Invalid bridge message");
    onMessage(message);
  }
}
function exact(value, fields, required = fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw coded("INVALID_REQUEST", "Invalid broker wrapper fields");
}
function openSocket(path) {
  path = resolveSocketPath(path);
  const localPath = process.platform === "win32" ? path.startsWith("\\\\.\\pipe\\") : path.startsWith("/");
  if (!localPath) return Promise.reject(new Error("Only local Unix sockets or current-user Windows named pipes are supported"));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once("error", reject);
    socket.once("connect", () => { socket.removeAllListeners("error"); resolve(socket); });
  });
}

/** Client for a host-owned, same-user authenticated local IPC broker. */
export function createBridgeClient(options = {}) {
  const timeoutDefault = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutDefault) || timeoutDefault <= 0 || timeoutDefault > 120_000) throw new RangeError("Invalid timeoutMs");
  const connectChannel = options.connect ?? (async () => {
    if (options.socketPath) return openSocket(options.socketPath);
    const configPath = options.configPath ?? (process.platform === "win32" ? defaultConfigPath() : undefined);
    const config = await loadRuntimeConfig(configPath, { required: process.platform === "win32" });
    return openSocket(config.socketPath);
  });
  let channel, session, connecting, closed = false;
  const targetCatalog = new Map();
  const state = { buffer: Buffer.alloc(0) }, pending = new Map(), abandoned = new Set();
  const rejectPending = (error) => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.cleanup?.(); p.reject(error); }
    pending.clear(); session = undefined; targetCatalog.clear(); abandoned.clear();
  };
  const receive = (message) => {
    if (message.type === "ready") {
      exact(message, ["type", "version", "id", "session", "targets"], ["type", "version", "id", "session"]);
      if (message.version !== 1 || typeof message.id !== "string" || typeof message.session !== "string") throw coded("INVALID_REQUEST", "Invalid broker ready frame");
      if (message.targets !== undefined) validateNativeResponse({ type: "targets", targets: message.targets });
      if (message.session) session = message.session;
    } else if (message.type === "targets") {
      exact(message, ["type", "id", "session", "targets"]);
      validateNativeResponse({ type: "targets", targets: message.targets });
    } else if (message.type === "response") {
      exact(message, ["type", "id", "session", "response"]);
      validateResponse(message.response);
    } else {
      throw coded("INVALID_REQUEST", "Unexpected broker response type");
    }
    if (typeof message.id !== "string" || typeof message.session !== "string") throw coded("INVALID_REQUEST", "Broker response ID/session must be strings");
    const p = pending.get(message.id);
    if (!p && message.type === "targets") {
      if (message.session !== session) throw coded("STALE_SESSION", "Unauthenticated target catalog update");
      targetCatalog.clear();
      for (const target of message.targets) {
        if (targetCatalog.has(target.id)) throw coded("INVALID_REQUEST", "Duplicate target ID in broker catalog");
        targetCatalog.set(target.id, target);
      }
      return;
    }
    if (!p && abandoned.has(message.id)) {
      if (message.session !== session) throw coded("STALE_SESSION", "Unauthenticated late broker response");
      abandoned.delete(message.id);
      return;
    }
    if (!p) throw coded("INVALID_REQUEST", "Uncorrelated broker response");
    pending.delete(message.id); clearTimeout(p.timer); p.cleanup?.();
    if (message.type === "ready" && !message.session) { const error = coded("UNAUTHORIZED", "Broker authentication failed"); p.reject(error); throw error; }
    if (message.session !== session) { const error = coded("STALE_SESSION", "Unauthenticated or stale broker response"); p.reject(error); throw error; }
    if (message.type === "response" && (message.response.id !== message.id || message.response.session !== session)) { const error = coded("INVALID_REQUEST", "Mismatched canonical response correlation"); p.reject(error); throw error; }
    p.resolve(message);
  };
  async function connect() {
    if (closed) throw new Error("Bridge client is closed");
    if (session) return { session };
    if (connecting) return connecting;
    connecting = (async () => {
      const sock = await connectChannel();
      if (!sock || typeof sock.write !== "function" || typeof sock.on !== "function") throw new Error("Invalid IPC channel");
      channel = sock;
      sock.on("data", (chunk) => { try { consume(state, chunk, receive); } catch (e) { rejectPending(e); sock.destroy?.(); } });
      sock.on("error", (e) => { rejectPending(e); channel = undefined; });
      sock.on("close", () => { rejectPending(coded("STALE_SESSION", "Broker IPC connection closed")); channel = undefined; });
      const id = randomUUID();
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Broker join timed out")); }, timeoutDefault);
        pending.set(id, { resolve: (m) => { clearTimeout(timer); if (m.type !== "ready" || !m.session) reject(coded("UNAUTHORIZED", "Broker authentication failed")); else resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); }, timer });
      });
      // The OS IPC endpoint authenticates the same-user process; the broker issues a per-connection session.
      sock.write(encode({ type: "hello", version: 1, id }));
      await ready;
      return { session };
    })().finally(() => { connecting = undefined; });
    return connecting;
  }
  async function exchange(message, { signal, timeoutMs = timeoutDefault } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new RangeError("Invalid timeoutMs");
    if (signal?.aborted) throw signal.reason ?? coded("CANCELLED", "Cancelled before dispatch");
    await connect();
    const id = message.id ?? randomUUID();
    const payload = encode({ ...message, id, session });
    return new Promise((resolve, reject) => {
      const p = { resolve, reject, cleanup: undefined };
      const finish = (error) => { pending.delete(id); clearTimeout(p.timer); p.cleanup?.(); error ? reject(error) : undefined; };
      p.timer = setTimeout(() => {
        abandoned.add(id);
        if (abandoned.size > 512) abandoned.delete(abandoned.values().next().value);
        finish(coded("TIMEOUT", "Timed out; dispatched outcome may be uncertain"));
        try { channel?.write(encode({ type: "cancel", session, id })); } catch {}
      }, timeoutMs);
      if (signal) {
        const abort = () => {
          abandoned.add(id);
          if (abandoned.size > 512) abandoned.delete(abandoned.values().next().value);
          finish(coded("CANCELLED", "Cancelled; dispatched outcome may be uncertain"));
          try { channel?.write(encode({ type: "cancel", session, id })); } catch {}
        };
        signal.addEventListener("abort", abort, { once: true });
        p.cleanup = () => signal.removeEventListener("abort", abort);
      }
      pending.set(id, p);
      try { channel.write(payload); } catch (e) { finish(e); }
    });
  }
  return {
    connect,
    async listTargets() {
      if (!session) await connect();
      const response = await exchange({ type: "targets" });
      if (response.type !== "targets") throw coded("INVALID_REQUEST", "Invalid target catalog response");
      targetCatalog.clear();
      for (const target of response.targets) {
        if (targetCatalog.has(target.id)) throw coded("INVALID_REQUEST", "Duplicate target ID in broker catalog");
        targetCatalog.set(target.id, target);
      }
      return response.targets;
    },
    async request(action, args, { targetId, signal, timeoutMs } = {}) {
      if (typeof action !== "string" || !action || !args || typeof args !== "object" || Array.isArray(args) || typeof targetId !== "string" || !targetId) throw coded("INVALID_REQUEST", "Invalid action request");
      if (!session) throw coded("STALE_SESSION", "Call connect() before request()");
      if (!targetCatalog.has(targetId)) throw coded("TARGET_NOT_FOUND", "Target is absent from the latest broker catalog");
      const request = { version: 1, id: randomUUID(), session, target: targetId, action, args };
      validateRequest(request);
      // Payload bound before connection or dispatch; host additionally validates canonical protocol.
      encode({ type: "request", request });
      const result = await exchange({ type: "request", id: request.id, request }, { signal, timeoutMs });
      if (result.type !== "response" || !result.response || result.response.id !== request.id || result.response.session !== session) throw coded("INVALID_REQUEST", "Invalid broker action response");
      try { validateResponse(result.response); } catch { throw coded("INVALID_REQUEST", "Invalid canonical broker response"); }
      return result.response;
    },
    async close() {
      if (closed) return;
      closed = true;
      const priorSession = session;
      rejectPending(new Error("Bridge client closed"));
      const sock = channel; channel = undefined;
      if (sock) {
        try { if (priorSession) sock.write(encode({ type: "leave", session: priorSession })); } catch {}
        await new Promise((resolve) => { sock.end?.(resolve); setTimeout(() => { sock.destroy?.(); resolve(); }, 250).unref?.(); });
      }
    },
  };
}
