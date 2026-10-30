import test from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, MAX_MESSAGE_BYTES, decodeMessage, encodeMessage, validateRequest, validateResponse } from "../bridge-protocol.mjs";

const request = (overrides = {}) => ({ version: 1, id: "r1", session: "s1", target: "tab-1", action: "observe", args: {}, ...overrides });

test("freezes action vocabulary and round-trips canonical request", () => {
  assert.deepEqual(ACTIONS, ["observe", "tabs", "click", "type", "key", "scroll", "navigate", "cancel"]);
  const encoded = encodeMessage(request());
  assert.deepEqual(decodeMessage(new TextEncoder().encode(encoded)), request());
});

test("rejects malformed, unknown, unsupported, and ill-typed requests", () => {
  for (const bad of [null, [], { ...request(), extra: 1 }, request({ version: 2 }), request({ id: "" }), request({ action: "eval" }), request({ args: [] })]) {
    assert.throws(() => validateRequest(bad));
  }
  for (const text of ["{", JSON.stringify(request({ action: "exec" }))]) assert.throws(() => decodeMessage(text));
});

test("rejects oversize messages before JSON parsing", () => {
  assert.throws(() => decodeMessage(new Uint8Array(MAX_MESSAGE_BYTES + 1)), /maximum size/);
  assert.throws(() => encodeMessage(request({ args: { data: "x".repeat(MAX_MESSAGE_BYTES) } })), /maximum size/);
});

test("validates success and stable bounded error response schemas", () => {
  assert.equal(validateResponse({ version: 1, id: "r1", session: "s1", ok: true, result: { accepted: true } }).ok, true);
  assert.equal(validateResponse({ version: 1, id: "r1", session: "s1", ok: false, error: { code: "STALE_SESSION", message: "revoked", retryable: false } }).ok, false);
  for (const bad of [
    { version: 1, id: "r", session: "s", ok: true },
    { version: 1, id: "r", session: "s", ok: false, error: { code: "NOPE", message: "x", retryable: false } },
    { version: 1, id: "r", session: "s", ok: false, error: { code: "INTERNAL", message: "x".repeat(513), retryable: false } },
  ]) assert.throws(() => validateResponse(bad));
});

test("cancel is an explicit correlated request and cannot carry arbitrary args", () => {
  assert.equal(validateRequest(request({ action: "cancel", args: { requestId: "prior" } })).action, "cancel");
  assert.throws(() => validateRequest(request({ action: "cancel", args: { requestId: "prior", force: true } })));
});
