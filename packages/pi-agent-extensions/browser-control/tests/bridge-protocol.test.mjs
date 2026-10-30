import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS, MAX_MESSAGE_BYTES, decodeMessage, encodeMessage, validateRequest,
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
  assert.throws(() => encodeMessage(request({ args: { data: "x".repeat(MAX_MESSAGE_BYTES) } })), /maximum size/);
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

test("native cancel is request-scoped and dispatched status is explicit", () => {
  assert.equal(validateNativeRequest({ type: "cancel", session: "s", id: "r1" }).id, "r1");
  assert.equal(validateNativeResponse({ type: "cancelled", session: "s", id: "r1", dispatched: true }).dispatched, true);
  assert.throws(() => validateNativeResponse({ type: "cancelled", session: "s", id: "r1", dispatched: "yes" }));
});
