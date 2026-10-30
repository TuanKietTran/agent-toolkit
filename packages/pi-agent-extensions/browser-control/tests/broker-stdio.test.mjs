import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { runBrokerStdio } from "../native-host/broker-stdio.mjs";
import { MAX_MESSAGE_BYTES } from "../bridge-protocol.mjs";

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function decodeFrames(buffer) {
  const messages = [];
  while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
    const size = buffer.readUInt32LE(0);
    assert.ok(size > 0 && size <= MAX_MESSAGE_BYTES);
    messages.push(JSON.parse(buffer.subarray(4, size + 4).toString("utf8")));
    buffer = buffer.subarray(size + 4);
  }
  return { messages, rest: buffer };
}

test("broker stdio multiplexes framed peer bytes and propagates independent peer close", async () => {
  const input = new PassThrough(), output = new PassThrough();
  let peer;
  let connections;
  let outputBuffer = Buffer.alloc(0);
  const outputMessages = [];
  output.on("data", (chunk) => {
    const parsed = decodeFrames(Buffer.concat([outputBuffer, chunk]));
    outputMessages.push(...parsed.messages); outputBuffer = parsed.rest;
  });
  let brokerClosed = false;
  const done = runBrokerStdio({ input, output, onPeer: async (server) => {
    connections = server;
    server.on("connection", (value) => { peer = value; });
    return { close: async () => { brokerClosed = true; } };
  } });

  input.write(frame({ v: 1, type: "open", peer: "native-1" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(peer);
  const incoming = new Promise((resolve) => peer.once("data", resolve));
  input.write(frame({ v: 1, type: "data", peer: "native-1", bytes: Buffer.from("client bytes").toString("base64") }));
  assert.equal((await incoming).toString(), "client bytes");

  peer.write(Buffer.from("host bytes"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(outputMessages.at(-1), { v: 1, type: "data", peer: "native-1", bytes: Buffer.from("host bytes").toString("base64") });
  const large = Buffer.alloc(100 * 1024, 0x61);
  await new Promise((resolve, reject) => peer.write(large, (error) => error ? reject(error) : resolve()));
  await new Promise((resolve) => setImmediate(resolve));
  const chunks = outputMessages.filter((message) => message.peer === "native-1" && message.type === "data").slice(1);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((message) => Buffer.from(message.bytes, "base64").length <= 48 * 1024));
  assert.deepEqual(Buffer.concat(chunks.map((message) => Buffer.from(message.bytes, "base64"))), large);
  input.write(frame({ v: 1, type: "close", peer: "native-1" }));
  await new Promise((resolve) => peer.once("end", resolve));
  input.end();
  await done;
  assert.equal(brokerClosed, true);
});

test("broker stdio rejects duplicate peers, malformed base64, and truncated EOF", async () => {
  for (const frames of [
    [ { v: 1, type: "open", peer: "x" }, { v: 1, type: "open", peer: "x" } ],
    [ { v: 1, type: "open", peer: "x" }, { v: 1, type: "data", peer: "x", bytes: "%%%" } ],
  ]) {
    const input = new PassThrough(), output = new PassThrough();
    const done = runBrokerStdio({ input, output, onPeer: async () => ({ close() {} }) });
    input.write(Buffer.concat(frames.map(frame)));
    await assert.rejects(done, /duplicate|invalid/i);
    output.destroy();
  }
  const input = new PassThrough(), output = new PassThrough();
  const done = runBrokerStdio({ input, output, onPeer: async () => ({ close() {} }) });
  input.write(Buffer.from([5, 0])); input.end();
  await assert.rejects(done, /truncated/i);
  output.destroy();
});
