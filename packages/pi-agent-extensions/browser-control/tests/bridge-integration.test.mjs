import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createBridgeClient } from "../bridge-client.mjs";
import * as protocol from "../bridge-protocol.mjs";

const SESSION = "host-issued-session", TARGET = "host-target-opaque";
const frame = (v) => { const b = Buffer.from(JSON.stringify(v)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); };

// Temporary IPC broker -> native relay -> extension executor. Messages cross the
// bridge client's actual framed socket and are checked by the shared protocol module.
test("temporary IPC -> broker/native relay -> mock CDP executor: auth, result, cancel, drag cleanup", async () => {
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\pi-bridge-${randomUUID()}` : join(tmpdir(), `pi-bridge-${randomUUID()}.sock`);
  const extension = { granted: true, mouseUp: 0, async execute(request, signal) {
    protocol.validateNativeResponse({ type: "execute", request });
    if (!this.granted) return { version: 1, id: request.id, session: SESSION, ok: false, error: { code: "UNAUTHORIZED", message: "Target authorization denied", retryable: false } };
    if (request.action === "drag") {
      try { await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 15);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Error("cancelled")); }, { once: true });
      }); }
      finally { this.mouseUp++; }
    }
    return { version: 1, id: request.id, session: SESSION, ok: true, result: { accepted: true } };
  } };
  const server = net.createServer((client) => {
    let input = Buffer.alloc(0), current = new Map();
    const send = (m) => client.write(frame(m));
    client.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 4 && input.length >= input.readUInt32LE(0) + 4) {
        const n = input.readUInt32LE(0), bytes = input.subarray(4, n + 4); input = input.subarray(n + 4);
        let m; try { m = JSON.parse(bytes.toString("utf8")); } catch { client.destroy(); return; }
        if (m.type === "hello") {
          send({ type: "ready", version: 1, id: m.id, session: SESSION, targets: [] });
        } else if (m.type === "targets") {
          send({ type: "targets", id: m.id, session: SESSION, targets: [{ id: TARGET, tabId: 9, origin: "https://example.test", title: "fixture" }] });
        } else if (m.type === "request") {
          try { protocol.validateRequest(m.request); } catch { send({ type: "error", id: m.id, session: SESSION }); continue; }
          if (m.request.session !== SESSION || m.request.target !== TARGET) {
            send({ type: "response", id: m.id, session: SESSION, response: { version: 1, id: m.request.id, session: SESSION, ok: false, error: { code: "UNAUTHORIZED", message: "Denied", retryable: false } } }); continue;
          }
          const abort = new AbortController(); current.set(m.request.id, abort);
          extension.execute(m.request, abort.signal).then((response) => {
            current.delete(m.request.id);
            const relayed = { type: "executeResult", response };
            protocol.validateNativeRequest(relayed);
            send({ type: "response", id: m.id, session: SESSION, response: relayed.response });
          }, () => {
            current.delete(m.request.id);
            const relayed = { type: "executeResult", response: { version: 1, id: m.request.id, session: SESSION, ok: false, error: { code: "CANCELLED", message: "Cancelled; effect may be uncertain", retryable: false } } };
            protocol.validateNativeRequest(relayed);
            send({ type: "response", id: m.id, session: SESSION, response: relayed.response });
          });
        } else if (m.type === "cancel") {
          protocol.validateNativeRequest(m);
          current.get(m.id)?.abort();
        }
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(pipe, resolve).once("error", reject));
  const client = createBridgeClient({ socketPath: pipe, timeoutMs: 1000 });
  try {
    assert.equal((await client.connect()).session, SESSION);
    assert.equal((await client.listTargets())[0].id, TARGET);
    const ok = await client.request("click", { x: 4, y: 8, button: "left" }, { targetId: TARGET });
    protocol.validateResponse(ok); assert.equal(ok.ok, true, JSON.stringify(ok)); assert.equal(ok.result.accepted, true, JSON.stringify(ok));
    const drag = await client.request("drag", { start: { x: 1, y: 2 }, end: { x: 10, y: 20 }, button: "left" }, { targetId: TARGET });
    assert.equal(drag.ok, true); assert.equal(extension.mouseUp, 1);
    extension.granted = false;
    const denied = await client.request("click", { x: 1, y: 1, button: "left" }, { targetId: TARGET });
    assert.equal(denied.error.code, "UNAUTHORIZED");
    extension.granted = true;
    const controller = new AbortController();
    const cancelled = client.request("drag", { start: { x: 1, y: 2 }, end: { x: 30, y: 40 }, button: "left" }, { targetId: TARGET, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 2)); controller.abort();
    await assert.rejects(cancelled, /outcome may be uncertain/i);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(extension.mouseUp, 2, "drag attempts mouse-up in finally after cancellation");
  } finally {
    await client.close(); await new Promise((r) => server.close(r));
  }
});
