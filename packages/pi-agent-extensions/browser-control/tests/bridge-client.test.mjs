import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createBridgeClient } from "../bridge-client.mjs";

// Fixture broker implements the same framed IPC exchange used by the client; every
// operation traverses a real duplex byte channel, not a request-level mock.
class FixtureBroker extends EventEmitter {
  writes = [];
  session = "fixture-host-session";
  targets = [{ id: "opaque-target", tabId: 7, origin: "https://example.test", title: "untrusted title" }];
  mode = "normal";
  write(buf) {
    this.writes.push(Buffer.from(buf));
    const length = buf.readUInt32LE(0);
    if (!length || length > 1024 * 1024) throw Error("invalid inbound frame");
    let msg;
    try { msg = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(4, length + 4))); }
    catch { throw Error("malformed inbound JSON"); }
    queueMicrotask(() => {
      if (this.mode === "oversized" && msg.type === "hello") { const h = Buffer.alloc(4); h.writeUInt32LE(1024 * 1024 + 1); this.emit("data", h); return; }
      if (this.mode === "malformed" && msg.type === "hello") { const b = Buffer.from("{"); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); this.emit("data", Buffer.concat([h, b])); return; }
      if (msg.type === "hello") return this.send({ type: "ready", version: 1, id: msg.id, session: this.mode === "unauthorized" ? "" : this.session, targets: this.targets });
      if (msg.type === "targets") return this.send({ type: "targets", id: msg.id, session: this.session, targets: this.targets });
      if (msg.type === "request") {
        if (this.mode === "unknown-field") return this.send({ type: "response", id: msg.id, session: this.session, unexpected: true, response: { version: 1, id: msg.request.id, session: this.session, ok: true, result: {} } });
        if (this.mode === "hang") return;
        if (this.mode === "stale") return this.send({ type: "response", id: msg.id, session: "revoked", response: { version: 1, id: msg.request.id, session: "revoked", ok: true, result: { accepted: true } } });
        return this.send({ type: "response", id: msg.id, session: this.session, response: { version: 1, id: msg.request.id, session: this.session, ok: true, result: { accepted: true } } });
      }
    });
    return true;
  }
  send(value) { const b = Buffer.from(JSON.stringify(value)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); this.emit("data", Buffer.concat([h, b])); }
  end(done) { this.emit("close"); done?.(); }
  destroy() { this.emit("close"); }
}
const connected = async (broker) => { const c = createBridgeClient({ connect: async () => broker, timeoutMs: 50 }); await c.connect(); await c.listTargets(); return c; };

test("actual framed IPC join, catalog and canonical request/response", async () => {
  const broker = new FixtureBroker(), client = await connected(broker);
  assert.deepEqual(await client.listTargets(), broker.targets);
  const result = await client.request("click", { x: 3, y: 4, button: "left" }, { targetId: "opaque-target" });
  assert.equal(result.ok, true); assert.equal(result.result.accepted, true);
  const request = broker.writes.map((b) => JSON.parse(b.subarray(4).toString())).find((m) => m.type === "request");
  assert.equal(request.request.session, broker.session); assert.equal(request.request.target, "opaque-target");
  assert.equal(request.request.action, "click");
  await client.close();
});

test("rejects oversized request before transport and malformed/oversized broker frames", async () => {
  const bounded = await connected(new FixtureBroker());
  await assert.rejects(bounded.request("type", { text: "x".repeat(300_000) }, { targetId: "opaque-target" }), /oversized text/);
  await bounded.close();
  for (const mode of ["malformed", "oversized"]) {
    const broker = new FixtureBroker(); broker.mode = mode;
    const client = createBridgeClient({ connect: async () => broker, timeoutMs: 25 });
    await assert.rejects(client.connect()); await client.close();
  }
});

test("authentication rejection and stale/revoked sessions fail closed", async () => {
  const broker = new FixtureBroker(); broker.mode = "unauthorized";
  const client = createBridgeClient({ connect: async () => broker, timeoutMs: 20 });
  await assert.rejects(client.connect(), /invalid session|authentication failed|timed out/i); await client.close();
  const stale = new FixtureBroker(); const other = await connected(stale); stale.mode = "stale";
  await assert.rejects(other.request("observe", {}, { targetId: "opaque-target" }), /stale broker response/i);
  await other.close();
  const malformed = new FixtureBroker(); const strictClient = await connected(malformed); malformed.mode = "unknown-field";
  await assert.rejects(strictClient.request("observe", {}, { targetId: "opaque-target" }), /wrapper fields/i);
  await strictClient.close();
});

test("abort before or during broker readiness never dispatches an action frame", async () => {
  const broker = new FixtureBroker(), client = await connected(broker);
  const before = broker.writes.filter((b) => JSON.parse(b.subarray(4).toString()).type === "request").length;
  const already = new AbortController(); already.abort();
  await assert.rejects(client.request("click", { x: 1, y: 1, button: "left" }, { targetId: "opaque-target", signal: already.signal }), /before dispatch/i);
  const during = new AbortController();
  const pending = client.request("click", { x: 2, y: 2, button: "left" }, { targetId: "opaque-target", signal: during.signal });
  during.abort();
  await assert.rejects(pending, /before dispatch/i);
  await new Promise((r) => setImmediate(r));
  assert.equal(broker.writes.filter((b) => JSON.parse(b.subarray(4).toString()).type === "request").length, before);
  await client.close();
});

test("cancellation and timeout send best-effort cancel and report uncertain outcome", async () => {
  const broker = new FixtureBroker(); const client = await connected(broker); broker.mode = "hang";
  const ac = new AbortController(); const pending = client.request("click", { x: 2, y: 3, button: "left" }, { targetId: "opaque-target", signal: ac.signal });
  await new Promise((r) => setImmediate(r)); ac.abort();
  await assert.rejects(pending, /uncertain outcome|cancelled/i);
  await assert.rejects(client.request("click", { x: 2, y: 3, button: "left" }, { targetId: "opaque-target", timeoutMs: 10 }), /uncertain/i);
  assert.ok(broker.writes.some((b) => JSON.parse(b.subarray(4).toString()).type === "cancel"));
  await client.close();
});
