import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import { MAX_MESSAGE_BYTES } from "../bridge-protocol.mjs";

const OUTER_MAX = MAX_MESSAGE_BYTES;
// Match the C# relay's fixed raw-pipe chunk bound; base64 framing stays small.
const RAW_CHUNK_MAX = 48 * 1024;
const fail = (message) => { throw new Error(message); };
function envelope(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (!body.length || body.length > OUTER_MAX) fail("stdio relay envelope exceeds 1 MiB");
  const h = Buffer.alloc(4); h.writeUInt32LE(body.length);
  return Buffer.concat([h, body]);
}
function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(value, key))) fail("invalid stdio relay fields");
}
class RelayPeer extends Duplex {
  constructor(id, send, onClose) {
    super(); this.id = id; this.sendEnvelope = send; this.onPeerClose = onClose;
    this.sentClose = false; this.receivedClose = false;
  }
  _read() {}
  _write(chunk, _encoding, callback) {
    try {
      for (let offset = 0; offset < chunk.length; offset += RAW_CHUNK_MAX) {
        const bytes = chunk.subarray(offset, Math.min(offset + RAW_CHUNK_MAX, chunk.length));
        this.sendEnvelope({ v: 1, type: "data", peer: this.id, bytes: bytes.toString("base64") });
      }
      callback();
    } catch (error) { callback(error); }
  }
  sendClose() {
    if (this.sentClose) return;
    this.sentClose = true;
    this.sendEnvelope({ v: 1, type: "close", peer: this.id });
    this.finishClose();
  }
  finishClose() {
    if (this.sentClose && this.receivedClose) this.onPeerClose(this.id);
  }
  _final(callback) {
    try { this.sendClose(); callback(); }
    catch (error) { callback(error); }
  }
  _destroy(error, callback) {
    try { this.sendClose(); }
    catch (sendError) { error ||= sendError; }
    this.finishClose();
    callback(error);
  }
  receive(bytes) {
    if (this.destroyed || this.receivedClose) return;
    if (this.readableLength + bytes.length > OUTER_MAX * 2) fail("stdio relay peer input backlog exceeded");
    this.push(bytes);
  }
  peerEnd() {
    if (this.receivedClose) return;
    this.receivedClose = true;
    this.push(null);
    try { this.sendClose(); }
    finally { this.finishClose(); }
  }
}

/** Adapt the frozen C# multiplexed stdio protocol to the broker's existing
 * socket-shaped connection API. It contains no session/grant/routing logic. */
export async function runBrokerStdio({ input = process.stdin, output = process.stdout, onPeer } = {}) {
  const connections = new EventEmitter();
  const peers = new Map();
  const send = (message) => {
    if (output.writableLength > OUTER_MAX * 4) fail("stdio relay output backlog exceeded");
    output.write(envelope(message));
  }
  const remove = (id) => peers.delete(id);
  const broker = await onPeer(connections);
  let buffer = Buffer.alloc(0);
  try {
    for await (const chunk of input) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (!length || length > OUTER_MAX) fail("invalid stdio relay frame length");
        if (buffer.length < length + 4) break;
        const bytes = buffer.subarray(4, length + 4); buffer = buffer.subarray(length + 4);
        let message;
        try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { fail("malformed stdio relay JSON"); }
        if (message.v !== 1) fail("unsupported stdio relay version");
        if (message.type === "open") {
          exact(message, ["v", "type", "peer"]);
          if (typeof message.peer !== "string" || !message.peer || message.peer.length > 128 || peers.has(message.peer) || peers.size >= 64) fail("invalid, duplicate, or excessive stdio peer");
          const peer = new RelayPeer(message.peer, send, remove);
          peers.set(message.peer, peer); connections.emit("connection", peer);
        } else if (message.type === "data") {
          exact(message, ["v", "type", "peer", "bytes"]);
          const peer = peers.get(message.peer);
          if (!peer || peer.sentClose || peer.receivedClose || typeof message.bytes !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.bytes)) fail("invalid stdio peer data");
          const raw = Buffer.from(message.bytes, "base64");
          if (!raw.length || raw.length > RAW_CHUNK_MAX || raw.toString("base64") !== message.bytes) fail("invalid or oversized stdio peer bytes");
          peer.receive(raw);
        } else if (message.type === "close") {
          exact(message, ["v", "type", "peer"]);
          const peer = peers.get(message.peer);
          if (!peer) fail("close for unknown stdio peer");
          peer.peerEnd();
        } else fail("unknown stdio relay message type");
      }
    }
    if (buffer.length) fail("truncated stdio relay frame at EOF");
  } finally {
    for (const peer of peers.values()) peer.peerEnd();
    await broker?.close?.();
  }
}
