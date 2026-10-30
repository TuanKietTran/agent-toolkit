import net from "node:net";
import { randomUUID } from "node:crypto";
import { MAX_MESSAGE_BYTES } from "../bridge-protocol.mjs";

const MAX = MAX_MESSAGE_BYTES;
const RAW_CHUNK = 700 * 1024;
const encode = (value) => {
  const body = Buffer.from(JSON.stringify(value));
  if (!body.length || body.length > MAX) throw new Error("relay fixture frame too large");
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};

// Test-only equivalent of the package-owned ACL front end; it does not interpret broker messages.
export function startStdioRelayFixture(socketPath, worker) {
  const peers = new Map();
  let workerInput = Buffer.alloc(0);
  const toWorker = (message) => worker.stdin.write(encode(message));
  const server = net.createServer((socket) => {
    const id = randomUUID(); peers.set(id, socket);
    toWorker({ v: 1, type: "open", peer: id });
    socket.on("data", (chunk) => {
      for (let offset = 0; offset < chunk.length; offset += RAW_CHUNK) {
        toWorker({ v: 1, type: "data", peer: id, bytes: chunk.subarray(offset, offset + RAW_CHUNK).toString("base64") });
      }
    });
    socket.on("close", () => { if (peers.delete(id)) toWorker({ v: 1, type: "close", peer: id }); });
  });
  worker.stdout.on("data", (chunk) => {
    workerInput = Buffer.concat([workerInput, chunk]);
    while (workerInput.length >= 4) {
      const length = workerInput.readUInt32LE(0);
      if (!length || length > MAX) { worker.kill(); return; }
      if (workerInput.length < length + 4) return;
      let message;
      try { message = JSON.parse(workerInput.subarray(4, length + 4).toString("utf8")); }
      catch { worker.kill(); return; }
      workerInput = workerInput.subarray(length + 4);
      if (message.v !== 1 || typeof message.peer !== "string") { worker.kill(); return; }
      const peer = peers.get(message.peer);
      if (!peer) continue;
      if (message.type === "data") {
        const raw = Buffer.from(message.bytes, "base64");
        if (!raw.length || raw.length > RAW_CHUNK || raw.toString("base64") !== message.bytes) { worker.kill(); return; }
        peer.write(raw);
      } else if (message.type === "close") { peers.delete(message.peer); peer.destroy(); }
      else { worker.kill(); return; }
    }
  });
  const listening = new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  return { listening, close: () => new Promise((resolve) => server.close(resolve)) };
}
