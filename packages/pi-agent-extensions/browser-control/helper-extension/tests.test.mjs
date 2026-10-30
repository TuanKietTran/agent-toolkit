import test from "node:test";
import assert from "node:assert/strict";
import { encodeNativeFrame, decodeNativeFrame } from "./native-frame.mjs";
import { MAX_IMAGE_BASE64_BYTES, validateNativeRequest, validateNativeResponse, validateRequest, validateResponse } from "../bridge-protocol.mjs";
import { connectNative, onNativeMessage, onUiMessage } from "./service-worker.js";

const origin = "https://example.test";
const request = { version: 1, id: "req-1", session: "opaque-session", target: "opaque-target", action: "click", args: { x: 10, y: 12, button: "left" } };
function fakeChrome({ url = `${origin}/page`, command } = {}) {
  const posted = [], calls = [];
  const messageListeners = [], disconnectListeners = [];
  const port = { postMessage: value => posted.push(value), onMessage: { addListener: fn => messageListeners.push(fn) }, onDisconnect: { addListener: fn => disconnectListeners.push(fn) } };
  const api = {
    runtime: { id: "extension-id", connectNative: name => { assert.equal(name, "com.pi_agent_extensions.browser_bridge"); return port; }, sendMessage: async () => {}, onMessage: { addListener: () => {} } },
    tabs: { get: async () => ({ id: 4, url }), query: async () => [{ id: 4, url, title: "page" }], onUpdated: { addListener: () => {} }, onRemoved: { addListener: () => {} } },
    debugger: {
      attach: async () => {}, detach: async () => {},
      sendCommand: async (_target, method, args) => { calls.push({ method, args }); return command?.(method, args) || (method === "Page.captureScreenshot" ? { data: "aGVsbG8=" } : {}); },
    },
  };
  return { api, port, posted, calls, messageListeners, disconnectListeners };
}
async function bootstrap(fake) {
  connectNative(fake.api);
  assert.deepEqual(fake.posted[0], { type: "hello", version: 1 });
  await onNativeMessage({ type: "ready", version: 1, session: "opaque-session", targets: [{ id: "opaque-target", tabId: 4, origin, title: "page" }] }, fake.api);
}


test("Chrome native 4-byte little-endian UTF-8 frame round trips bounded messages", () => {
  const frame = encodeNativeFrame({ type: "hello", version: 1 });
  assert.equal(new DataView(frame.buffer).getUint32(0, true), frame.length - 4);
  assert.deepEqual(decodeNativeFrame(frame), { type: "hello", version: 1 });
  assert.throws(() => decodeNativeFrame(frame.subarray(0, 5)), /length/);
  const oversized = new Uint8Array(4); new DataView(oversized.buffer).setUint32(0, 1024 * 1024 + 1, true);
  assert.throws(() => decodeNativeFrame(oversized), /length/);
  assert.throws(() => decodeNativeFrame(Uint8Array.from([4, 0, 0, 0, 0xff, 0xff, 0xff, 0xff])), /encoded|UTF-8/i);
  assert.throws(() => decodeNativeFrame(new Uint8Array([1, 2, 3])), /frame/i);
  assert.throws(() => decodeNativeFrame(Uint8Array.from([1, 0, 0, 0, 0x7b])), /JSON|position/i);
  const backing = new Uint8Array(frame.length + 7); backing.set(frame, 3);
  assert.deepEqual(decodeNativeFrame(backing.subarray(3, 3 + frame.length)), { type: "hello", version: 1 });
  assert.throws(() => encodeNativeFrame({ data: "x".repeat(1024 * 1024) }), /too large/);
});

test("frozen control bootstrap, target, grant/revoke, execute and cancellation schemas validate", () => {
  assert.deepEqual(validateNativeRequest({ type: "hello", version: 1 }), { type: "hello", version: 1 });
  assert.deepEqual(validateNativeResponse({ type: "ready", version: 1, session: "s", targets: [] }).session, "s");
  assert.doesNotThrow(() => validateNativeResponse({ type: "targetsRequest", session: "s" }));
  assert.doesNotThrow(() => validateNativeRequest({ type: "targets", session: "s" }));
  assert.doesNotThrow(() => validateNativeRequest({ type: "targetInventory", session: "s", tabs: [{ tabId: 3, origin, title: "page" }] }));
  assert.throws(() => validateNativeRequest({ type: "targetInventory", session: "s", tabs: [{ tabId: 3, origin, title: "one" }, { tabId: 3, origin, title: "duplicate" }] }));
  assert.doesNotThrow(() => validateNativeResponse({ type: "targets", session: "s", targets: [{ id: "opaque", tabId: 3, origin, title: "page" }] }));
  assert.doesNotThrow(() => validateNativeResponse({ type: "execute", request }));
  assert.doesNotThrow(() => validateNativeRequest({ type: "executeResult", response: { version: 1, id: "req-1", session: "opaque-session", ok: true, result: { accepted: true } } }));
  assert.doesNotThrow(() => validateNativeRequest({ type: "authorize", session: "s", targetId: "t", origin }));
  assert.doesNotThrow(() => validateNativeRequest({ type: "revoke", session: "s", targetId: "t" }));
  assert.doesNotThrow(() => validateNativeResponse({ type: "execute", request }));
  assert.doesNotThrow(() => validateNativeResponse({ type: "cancel", session: "s", id: "req-1" }));
  assert.doesNotThrow(() => validateNativeRequest({ type: "cancelled", session: "s", id: "req-1", dispatched: false }));
  assert.throws(() => validateNativeRequest({ type: "authorize", session: "s", targetId: "t", origin: "javascript:alert(1)" }));
  assert.throws(() => validateNativeRequest({ type: "hello", version: 1, extra: true }));
});

test("canonical action and response envelope is validated unchanged", () => {
  assert.equal(validateRequest(request), request);
  const response = { version: 1, id: "req-1", session: "opaque-session", ok: true, result: { accepted: true } };
  assert.equal(validateResponse(response), response);
  assert.throws(() => validateRequest({ ...request, target: "" }));
  assert.throws(() => validateResponse({ ...response, extra: 1 }));
});

test("drag envelope is bounded by shared protocol and supports only one explicit gesture", () => {
  assert.doesNotThrow(() => validateRequest({ ...request, action: "drag", args: { start: { x: 1, y: 2 }, end: { x: 30, y: 40 }, button: "left" } }));
  assert.throws(() => validateRequest({ ...request, action: "drag", args: { start: { x: -1, y: 2 }, end: { x: 3, y: 4 }, button: "left" } }));
});

test("host target discovery requests live Chrome inventory without extension-created IDs", async () => {
  const fake = fakeChrome(); await bootstrap(fake);
  await onNativeMessage({ type: "targetsRequest", session: "opaque-session" }, fake.api);
  const inventory = fake.posted.at(-1);
  assert.equal(inventory.type, "targetInventory");
  assert.equal(inventory.session, "opaque-session");
  assert.deepEqual(inventory.tabs, [{ tabId: 4, origin, title: "page" }]);
  assert.equal(Object.hasOwn(inventory.tabs[0], "id"), false);
  await onNativeMessage({ type: "targets", session: "opaque-session", targets: [{ id: "broker-issued", tabId: 4, origin, title: "page" }] }, fake.api);
  assert.deepEqual((await onUiMessage({ type: "get-state" }, fake.api)).targets.map(t => t.id), ["broker-issued"]);
  fake.disconnectListeners[0]();
});

test("no connection/grant by default; explicit popup click requests authorization", async () => {
  const fake = fakeChrome();
  assert.deepEqual(await onUiMessage({ type: "get-state" }, fake.api), { connected: false, targets: [], grants: [] });
  await bootstrap(fake);
  const denied = await onNativeMessage({ type: "execute", request }, fake.api);
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.posted.at(-1).type, "executeResult");
  assert.equal(fake.posted.at(-1).response.error.code, "UNAUTHORIZED");
  await onUiMessage({ type: "grant", targetId: "opaque-target", origin }, fake.api);
  assert.deepEqual(fake.posted.at(-1), { type: "authorize", session: "opaque-session", targetId: "opaque-target", origin });
  await onNativeMessage({ type: "authorized", session: "opaque-session", targetId: "opaque-target", origin }, fake.api);
  const accepted = await onNativeMessage({ type: "execute", request }, fake.api);
  assert.equal(fake.calls.filter(call => call.args.type === "mousePressed").length, 1);
  assert.equal(fake.calls.filter(call => call.args.type === "mouseReleased").length, 1);
  assert.equal(accepted, undefined);
  assert.equal(fake.posted.at(-1).type, "executeResult");
  assert.equal(fake.posted.at(-1).response.ok, true);
  fake.disconnectListeners[0]();
});

test("revoked grants and live-origin navigation deny actions at execution time", async () => {
  const fake = fakeChrome(); await bootstrap(fake);
  await onUiMessage({ type: "grant", targetId: "opaque-target", origin }, fake.api);
  await onNativeMessage({ type: "authorized", session: "opaque-session", targetId: "opaque-target", origin }, fake.api);
  const revoked = await onUiMessage({ type: "revoke", targetId: "opaque-target" }, fake.api);
  assert.equal(revoked.requested, true);
  assert.equal(fake.posted.at(-1).type, "revoke");
  const denied = await onNativeMessage({ type: "execute", request }, fake.api);
  assert.equal(fake.posted.at(-1).response.error.code, "UNAUTHORIZED");
  fake.disconnectListeners[0]();
  const fake2 = fakeChrome({ url: "https://other.test/page" }); await bootstrap(fake2);
  await onUiMessage({ type: "grant", targetId: "opaque-target", origin }, fake2.api);
  await onNativeMessage({ type: "authorized", session: "opaque-session", targetId: "opaque-target", origin }, fake2.api);
  await onNativeMessage({ type: "execute", request }, fake2.api);
  assert.equal(fake2.posted.at(-1).response.error.code, "UNAUTHORIZED");
  assert.equal(fake2.calls.length, 0);
  fake2.disconnectListeners[0]();
});

test("drag always attempts mouseUp after a failed move and cancellation before dispatch is best effort", async () => {
  const fake = fakeChrome();
  // Replace the CDP mock with a move failure and verify finally releases the pressed button.
  fake.api.debugger.sendCommand = async (_target, method, args) => {
    fake.calls.push({ method, args });
    if (method === "Input.dispatchMouseEvent" && args.type === "mouseMoved") throw new Error("mock move failure");
    return {};
  };
  await bootstrap(fake);
  await onUiMessage({ type: "grant", targetId: "opaque-target", origin }, fake.api);
  await onNativeMessage({ type: "authorized", session: "opaque-session", targetId: "opaque-target", origin }, fake.api);
  const drag = { ...request, id: "drag", action: "drag", args: { start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, button: "left" } };
  await onNativeMessage({ type: "execute", request: drag }, fake.api);
  assert.ok(fake.calls.some(call => call.args.type === "mouseReleased"));

  let resolvePress;
  fake.api.debugger.sendCommand = async (_target, method, args) => {
    fake.calls.push({ method, args });
    if (args.type === "mousePressed") await new Promise(resolve => { resolvePress = resolve; });
    return {};
  };
  const dispatchedDrag = { ...drag, id: "drag-cancel-after-dispatch" };
  const runningDrag = onNativeMessage({ type: "execute", request: dispatchedDrag }, fake.api);
  await new Promise(resolve => setImmediate(resolve));
  await onNativeMessage({ type: "cancel", session: "opaque-session", id: dispatchedDrag.id }, fake.api);
  assert.ok(fake.posted.some(message => message.type === "cancelled" && message.id === dispatchedDrag.id && message.dispatched === true));
  resolvePress();
  await runningDrag;
  assert.ok(fake.calls.some(call => call.args.type === "mouseReleased"));

  let resolveTab;
  fake.api.tabs.get = () => new Promise(resolve => { resolveTab = resolve; });
  const execution = onNativeMessage({ type: "execute", request: { ...request, id: "cancel-me" } }, fake.api);
  await new Promise(resolve => setImmediate(resolve));
  await onNativeMessage({ type: "cancel", session: "opaque-session", id: "cancel-me" }, fake.api);
  resolveTab({ id: 4, url: `${origin}/page` });
  await execution;
  assert.ok(fake.posted.some(message => message.type === "cancelled" && message.id === "cancel-me" && message.dispatched === false));
  fake.disconnectListeners[0]();
});

test("screenshot output bound and native disconnect fail closed; malformed host messages ignored", async () => {
  const fake = fakeChrome(); await bootstrap(fake);
  await onUiMessage({ type: "grant", targetId: "opaque-target", origin }, fake.api);
  await onNativeMessage({ type: "authorized", session: "opaque-session", targetId: "opaque-target", origin }, fake.api);
  fake.api.debugger.sendCommand = async (_target, method) => method === "Page.captureScreenshot" ? { data: "x".repeat(MAX_IMAGE_BASE64_BYTES + 1) } : {};
  await onNativeMessage({ type: "execute", request: { ...request, action: "observe", args: {} } }, fake.api);
  assert.equal(fake.posted.at(-1).response.error.code, "TOO_LARGE");
  const before = fake.posted.length;
  await onNativeMessage({ type: "execute", request: { ...request, extra: 1 } }, fake.api);
  assert.equal(fake.posted.length, before);
  fake.disconnectListeners[0]();
  assert.equal((await onUiMessage({ type: "get-state" }, fake.api)).connected, false);
});
