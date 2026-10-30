import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// The shared protocol is shipped as ESM source without a duplicate .d.mts declaration.
// @ts-ignore
import * as protocol from "../bridge-protocol.mjs";
import { registerBrowserBridge } from "../bridge-pi.ts";

type Tool = { execute: (...args: any[]) => Promise<any> };
const issuedTargets = [{ id: "host-target-7f31", title: "untrusted title", url: "https://example.test/" }];

function setup(reply: (action: string, args: Record<string, unknown>, targetId: string) => Promise<any> = async () => ({ ok: true, result: { accepted: true } })) {
  const tools = new Map<string, Tool>();
  const events = new Map<string, Function>();
  const traffic: Array<{ action: string; args: Record<string, unknown>; targetId: string }> = [];
  let connects = 0;
  let lists = 0;
  let closes = 0;
  const client = {
    async connect() { connects++; return { session: "host-session-secretless-opaque" }; },
    async listTargets() { lists++; return issuedTargets; },
    async request(action: string, args: Record<string, unknown>, options: { targetId: string }) {
      traffic.push({ action, args, targetId: options.targetId });
      const request = protocol.validateRequest({ version: 1, id: randomUUID(), session: "fixture-host-session", target: options.targetId, action, args });
      const body = await reply(action, args, options.targetId);
      return protocol.validateResponse({ version: 1, id: request.id, session: request.session, ...body });
    },
    async close() { closes++; },
  };
  const pi = {
    registerTool(tool: { name: string; execute: Tool["execute"] }) { tools.set(tool.name, tool); },
    on(name: string, fn: Function) { events.set(name, fn); },
  } as unknown as ExtensionAPI;
  registerBrowserBridge(pi, () => client);
  const run = (name: string, args: object, signal?: AbortSignal) => tools.get(name)!.execute("id", args, signal, undefined, {});
  return { run, events, traffic, counts: () => ({ connects, lists, closes }) };
}

test("browser bridge lists host-issued targets and requires explicit current target for every operation", async () => {
  const f = setup();
  const listed = await f.run("browser_bridge_tabs", {});
  assert.deepEqual(JSON.parse(listed.content[0].text).targets.map((item: any) => item.id), [issuedTargets[0].id]);
  await assert.rejects(f.run("browser_bridge_observe", { target_id: "*" }), /not in the current host-issued catalog/);
  await assert.rejects(f.run("browser_bridge_input", { action: "click", target_id: "", x: 1, y: 2 }), /targetId|target/);
  assert.equal(f.traffic.length, 0);
  assert.deepEqual(f.counts(), { connects: 1, lists: 3, closes: 0 });
});

test("observe and input use only client-issued target IDs and canonical bounded actions", async () => {
  const f = setup(async () => ({ ok: true, result: { text: "page is untrusted", imageBase64: "aGVsbG8=", mimeType: "image/png" } }));
  await f.run("browser_bridge_tabs", {});
  const observed = await f.run("browser_bridge_observe", { target_id: issuedTargets[0].id });
  assert.equal(observed.content[1].type, "image");
  await f.run("browser_bridge_input", { action: "click", target_id: issuedTargets[0].id, x: 10, y: 20 });
  await f.run("browser_bridge_input", { action: "drag", target_id: issuedTargets[0].id, x: 1, y: 2, target_x: 3, target_y: 4 });
  await f.run("browser_bridge_input", { action: "type", target_id: issuedTargets[0].id, text: "hello" });
  await f.run("browser_bridge_input", { action: "scroll", target_id: issuedTargets[0].id, x: 10, y: 20, delta_x: 1, delta_y: -2 });
  await f.run("browser_bridge_input", { action: "key", target_id: issuedTargets[0].id, key: "Enter", modifiers: ["Shift"] });
  await f.run("browser_bridge_input", { action: "navigate", target_id: issuedTargets[0].id, url: "https://example.test/path" });
  assert.deepEqual(f.traffic.map((entry) => [entry.action, entry.targetId]), [
    ["observe", issuedTargets[0].id], ["click", issuedTargets[0].id], ["drag", issuedTargets[0].id], ["type", issuedTargets[0].id], ["scroll", issuedTargets[0].id], ["key", issuedTargets[0].id], ["navigate", issuedTargets[0].id],
  ]);
  assert.deepEqual(f.traffic[0].args, {});
  assert.deepEqual(f.traffic[1].args, { x: 10, y: 20, button: "left" });
  assert.deepEqual(f.traffic[2].args, { start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, button: "left" });
  assert.deepEqual(f.traffic[3].args, { text: "hello" });
  assert.deepEqual(f.traffic[4].args, { x: 10, y: 20, deltaX: 1, deltaY: -2 });
  assert.deepEqual(f.traffic[5].args, { key: "Enter", modifiers: ["Shift"] });
  assert.deepEqual(f.traffic[6].args, { url: "https://example.test/path" });
});

test("adapter fails closed on denied, stale, and transport errors; it never selects another target", async () => {
  for (const [response, message] of [
    [{ ok: false, error: { code: "UNAUTHORIZED", message: "Denied", retryable: false } }, /UNAUTHORIZED: Denied/],
    [{ ok: false, error: { code: "STALE_SESSION", message: "Stale", retryable: true } }, /STALE_SESSION: Stale/],
  ] as const) {
    const f = setup(async () => response);
    await assert.rejects(f.run("browser_bridge_input", { action: "key", target_id: issuedTargets[0].id, key: "Enter" }), message);
    assert.deepEqual(f.traffic.map((entry) => entry.targetId), [issuedTargets[0].id]);
  }
  const transport = setup(async () => { throw new Error("fixture disconnected"); });
  await assert.rejects(transport.run("browser_bridge_observe", { target_id: issuedTargets[0].id }), /fixture disconnected/);
  assert.equal(transport.traffic.length, 1);
});

test("adapter rejects unsafe URLs, invalid action arguments, and malformed image payloads", async () => {
  const f = setup();
  await assert.rejects(f.run("browser_bridge_input", { action: "navigate", target_id: issuedTargets[0].id, url: "javascript:alert(1)" }), /HTTP\(S\)/);
  await assert.rejects(f.run("browser_bridge_input", { action: "navigate", target_id: issuedTargets[0].id, url: "https://user:pass@example.test/" }), /credential-free/);
  await assert.rejects(f.run("browser_bridge_input", { action: "type", target_id: issuedTargets[0].id, text: "é".repeat(9_000) }), /bounded UTF-8/);
  await assert.rejects(f.run("browser_bridge_input", { action: "click", target_id: issuedTargets[0].id, x: NaN, y: 1 }), /finite/);
  await assert.rejects(f.run("browser_bridge_input", { action: "key", target_id: issuedTargets[0].id, key: "Enter; arbitrary" }), /supported key/);
  assert.equal(f.traffic.length, 0);
});

test("session shutdown closes only the owned shared bridge client", async () => {
  const f = setup();
  await f.run("browser_bridge_tabs", {});
  await f.events.get("session_shutdown")!({}, {});
  assert.deepEqual(f.counts(), { connects: 1, lists: 1, closes: 1 });
});
