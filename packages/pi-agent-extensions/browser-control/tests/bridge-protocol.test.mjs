import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS, MAX_IMAGE_BASE64_BYTES, MAX_MESSAGE_BYTES, MAX_TEXT_BYTES, decodeMessage, encodeMessage, validateRequest,
  validateResponse, validateNativeRequest, validateNativeResponse,
} from "../bridge-protocol.mjs";

const request = (overrides = {}) => ({ version: 1, id: "r1", session: "s1", target: "opaque-target", action: "observe", args: {}, ...overrides });
const response = (overrides = {}) => ({ version: 1, id: "r1", session: "s1", ok: true, result: { accepted: true }, ...overrides });
const targets = [{ id: "opaque-target", tabId: 19, origin: "https://example.com", title: "Example" }];

test("canonical action envelope round trips without wrapper fields", () => {
  assert.deepEqual(ACTIONS, ["observe", "click", "drag", "type", "key", "scroll", "navigate"]);
  const encoded = encodeMessage(request());
  assert.deepEqual(decodeMessage(new TextEncoder().encode(encoded)), request());
  assert.throws(() => validateRequest({ ...request(), kind: "action" }), /unknown fields/);
  assert.throws(() => validateRequest({ ...request(), action: "tabs" }), /unsupported action/);
});

test("rejects malformed, unknown, unsupported and ill-typed canonical requests", () => {
  for (const bad of [null, [], { ...request(), extra: 1 }, request({ version: 2 }), request({ id: "" }), request({ action: "eval" }), request({ args: [] })]) assert.throws(() => validateRequest(bad));
  for (const text of ["{", JSON.stringify(request({ action: "exec" }))]) assert.throws(() => decodeMessage(text));
});

test("rejects oversize frames before parse and on encode", () => {
  assert.throws(() => decodeMessage(new Uint8Array(MAX_MESSAGE_BYTES + 1)), /maximum size/);
  assert.throws(() => encodeMessage(request({ action: "observe", args: { data: "x".repeat(MAX_MESSAGE_BYTES) } })), /missing or unknown fields/);
});

test("validates canonical success/error envelopes and bounded errors", () => {
  assert.equal(validateResponse(response()).ok, true);
  const failure = { version: 1, id: "r1", session: "s1", ok: false, error: { code: "STALE_SESSION", message: "revoked", retryable: false } };
  assert.equal(validateResponse(failure).ok, false);
  for (const bad of [
    { version: 1, id: "r", session: "s", ok: true },
    { ...response(), extra: true },
    response({ ok: false, error: { code: "NOPE", message: "x", retryable: false } }),
    { version: 1, id: "r1", session: "s1", ok: false, error: { code: "INTERNAL", message: "x".repeat(513), retryable: false } },
  ]) assert.throws(() => validateResponse(bad));
});

test("all action argument schemas are strict and bounded", () => {
  const good = [
    ["observe", {}], ["click", { x: 1, y: 2, button: "left" }],
    ["type", { text: "hello" }], ["key", { key: "Enter", modifiers: ["Shift"] }],
    ["scroll", { x: 1, y: 2, deltaX: 0, deltaY: -120 }],
    ["navigate", { url: "https://example.com/path" }],
  ];
  for (const [action, args] of good) assert.equal(validateRequest(request({ action, args })).action, action);
  assert.equal(validateRequest(request({ action: "click", args: { x: 100000, y: 100000, button: "right" } })).action, "click");
  assert.equal(validateRequest(request({ action: "type", args: { text: "x".repeat(MAX_TEXT_BYTES) } })).action, "type");
  assert.equal(validateRequest(request({ action: "key", args: { key: "K".repeat(64), modifiers: ["Shift", "Ctrl", "Alt", "Meta"] } })).action, "key");
  assert.equal(validateRequest(request({ action: "scroll", args: { x: 100000, y: 0, deltaX: -10000, deltaY: 10000 } })).action, "scroll");
  const maxUrl = `https://e.com/${"a".repeat(2048 - "https://e.com/".length)}`;
  assert.equal(validateRequest(request({ action: "navigate", args: { url: maxUrl } })).action, "navigate");
  const bad = [
    ["observe", { extra: 1 }], ["click", { x: -1, y: 2, button: "left" }],
    ["click", { x: 100001, y: 2, button: "left" }], ["click", { x: 1, y: 2 }],
    ["click", { x: 1, y: 2, button: "left", extra: true }],
    ["type", { text: "x".repeat(MAX_TEXT_BYTES + 1) }], ["type", { value: "bad key" }],
    ["key", { key: "K".repeat(65) }], ["key", { key: "x", modifiers: ["Hyper"] }],
    ["key", { key: "Enter", modifiers: ["Shift", "Shift"] }],
    ["key", { key: "\n" }], ["scroll", { x: 0, y: 0, deltaX: 10001, deltaY: 0 }],
    ["scroll", { x: 100001, y: 0, deltaX: 0, deltaY: 0 }],
    ["navigate", { url: "javascript:alert(1)" }],
    ["navigate", { url: "https://user:pass@example.com/" }],
    ["navigate", { url: `https://e.com/${"a".repeat(2049 - "https://e.com/".length)}` }],
  ];
  for (const [action, args] of bad) assert.throws(() => validateRequest(request({ action, args })), `${action} should reject invalid args`);
});

test("drag is one bounded action; malformed coordinates/buttons reject", () => {
  const drag = request({ action: "drag", args: { start: { x: 1, y: 2 }, end: { x: 30, y: 40 }, button: "left" } });
  assert.equal(validateRequest(drag), drag);
  for (const args of [
    { start: { x: -1, y: 2 }, end: { x: 3, y: 4 }, button: "left" },
    { start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, button: "unknown" },
    { start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, button: "left", extra: 1 },
  ]) assert.throws(() => validateRequest(request({ action: "drag", args })));
});

test("validates native bootstrap/catalog and host-issued opaque target mapping", () => {
  assert.equal(validateNativeRequest({ type: "hello", version: 1 }).type, "hello");
  assert.deepEqual(validateNativeResponse({ type: "ready", version: 1, session: "host-session", targets }), { type: "ready", version: 1, session: "host-session", targets });
  assert.deepEqual(validateNativeResponse({ type: "targets", targets }), { type: "targets", targets });
  assert.throws(() => validateNativeResponse({ type: "ready", version: 1, session: "s", targets: [{ ...targets[0], id: "" }] }));
  assert.throws(() => validateNativeRequest({ type: "hello", version: 1, session: "magic" }));
});

test("validates native grants, canonical execute wrapper and correlated response wrapper", () => {
  assert.equal(validateNativeRequest({ type: "authorize", session: "s", targetId: "t", origin: "https://example.com" }).type, "authorize");
  assert.throws(() => validateNativeRequest({ type: "authorize", session: "s", targetId: "t", origin: "https://example.com/path" }));
  const req = request();
  assert.deepEqual(validateNativeRequest({ type: "request", request: req }).request, req);
  assert.deepEqual(validateNativeResponse({ type: "response", response: response() }).response, response());
  assert.deepEqual(validateNativeRequest({ type: "execute", request: req }).request, req);
  assert.deepEqual(validateNativeResponse({ type: "executeResult", response: response() }).response, response());
  assert.throws(() => validateNativeRequest({ type: "execute", request: { ...req, target: "" } }));
});

test("result depth, property, array, string, image and total response bounds are enforced", () => {
  const validImage = "A".repeat(MAX_IMAGE_BASE64_BYTES - 2) + "==";
  assert.equal(validateResponse(response({ result: { imageBase64: validImage } })).ok, true);
  assert.throws(() => validateResponse(response({ result: { imageBase64: "A".repeat(MAX_IMAGE_BASE64_BYTES) } })), /decoded image/);
  assert.throws(() => validateResponse(response({ result: { imageBase64: "not base64!" } })), /imageBase64/);
  assert.throws(() => validateResponse(response({ result: { nested: "x".repeat(MAX_TEXT_BYTES + 1) } })), /too large/);

  let depthEight = true;
  for (let i = 0; i < 7; i++) depthEight = { child: depthEight };
  assert.equal(validateResponse(response({ result: { nested: depthEight } })).ok, true);
  let tooDeep = depthEight;
  for (let i = 0; i < 2; i++) tooDeep = { child: tooDeep };
  assert.throws(() => validateResponse(response({ result: tooDeep })), /nesting/);
  assert.throws(() => validateResponse(response({ result: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${i}`, true])) })), /invalid result/);
  assert.throws(() => validateResponse(response({ result: { items: Array(1025).fill(true) } })), /array too large/);
  assert.throws(() => validateResponse(response({ result: { items: Array(100).fill("x".repeat(MAX_TEXT_BYTES)) } })), /maximum message size/);
});

test("native cancel is request-scoped and dispatched status is explicit", () => {
  assert.equal(validateNativeRequest({ type: "cancel", session: "s", id: "r1" }).id, "r1");
  assert.equal(validateNativeResponse({ type: "cancelled", session: "s", id: "r1", dispatched: true }).dispatched, true);
  assert.throws(() => validateNativeResponse({ type: "cancelled", session: "s", id: "r1", dispatched: "yes" }));
});
