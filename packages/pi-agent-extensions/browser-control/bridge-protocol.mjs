export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_ERROR_BYTES = 512;
export const ACTIONS = Object.freeze(["observe", "click", "drag", "type", "key", "scroll", "navigate"]);
const ERRORS = new Set(["INVALID_REQUEST", "UNSUPPORTED_VERSION", "UNAUTHORIZED", "STALE_SESSION", "TARGET_NOT_FOUND", "UNSUPPORTED_ACTION", "CANCELLED", "TIMEOUT", "TOO_LARGE", "INTERNAL"]);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const record = v => v !== null && typeof v === "object" && !Array.isArray(v);
const bytes = v => new TextEncoder().encode(v).byteLength;
const fail = m => { throw new TypeError(m); };
function exact(o, keys, required = keys) {
  if (Object.keys(o).some(k => !keys.includes(k)) || required.some(k => !own(o, k))) fail("message has missing or unknown fields");
}
function str(v, name, max = 256) {
  if (typeof v !== "string" || !v.length || bytes(v) > max) fail(`invalid ${name}`);
}
function err(e) {
  if (!record(e)) fail("error must be an object");
  exact(e, ["code", "message", "retryable"]);
  if (!ERRORS.has(e.code) || typeof e.message !== "string" || bytes(e.message) > MAX_ERROR_BYTES || typeof e.retryable !== "boolean") fail("invalid error object");
}
function coord(v, name) { if (!Number.isFinite(v) || v < 0 || v > 100000) fail(`invalid ${name}`); }

// Canonical broker envelope. Session, ID, and target are always supplied by the host client.
export function validateRequest(v) {
  if (!record(v)) fail("request must be an object");
  exact(v, ["version", "id", "session", "target", "action", "args"]);
  if (v.version !== PROTOCOL_VERSION) fail("unsupported version");
  str(v.id, "id", 128); str(v.session, "session"); str(v.target, "target");
  if (!ACTIONS.includes(v.action)) fail("unsupported action");
  if (!record(v.args)) fail("args must be an object");
  if (v.action === "drag") {
    exact(v.args, ["start", "end", "button"]);
    for (const [pointName, point] of [["start", v.args.start], ["end", v.args.end]]) {
      if (!record(point)) fail(`invalid drag ${pointName}`);
      exact(point, ["x", "y"]); coord(point.x, `${pointName}.x`); coord(point.y, `${pointName}.y`);
    }
    if (!["left", "middle", "right"].includes(v.args.button)) fail("invalid drag button");
  }
  return v;
}
export function validateResponse(v) {
  if (!record(v)) fail("response must be an object");
  exact(v, ["version", "id", "session", "ok", "result", "error"], ["version", "id", "session", "ok"]);
  if (v.version !== PROTOCOL_VERSION) fail("unsupported version");
  str(v.id, "id", 128); str(v.session, "session");
  if (typeof v.ok !== "boolean") fail("ok must be boolean");
  if (v.ok) { if (!own(v, "result") || !record(v.result) || own(v, "error")) fail("success requires result only"); }
  else { if (own(v, "result") || !own(v, "error")) fail("failure requires error only"); err(v.error); }
  return v;
}

// Native Messaging frames wrap, but never redefine, canonical broker envelopes.
export function validateNativeRequest(v) {
  if (!record(v)) fail("native request must be an object");
  if (v.type === "hello") { exact(v, ["type", "version"]); if (v.version !== PROTOCOL_VERSION) fail("unsupported version"); return v; }
  if (v.type === "targets") { exact(v, ["type"]); return v; }
  if (v.type === "authorize") {
    exact(v, ["type", "session", "targetId", "origin"]); str(v.session, "session"); str(v.targetId, "targetId");
    if (!validOrigin(v.origin)) fail("invalid origin"); return v;
  }
  if (v.type === "revoke") { exact(v, ["type", "session", "targetId"]); str(v.session, "session"); str(v.targetId, "targetId"); return v; }
  if (v.type === "request") { exact(v, ["type", "request"]); validateRequest(v.request); return v; }
  if (v.type === "cancel") { exact(v, ["type", "session", "id"]); str(v.session, "session"); str(v.id, "id", 128); return v; }
  if (v.type === "execute") { exact(v, ["type", "request"]); validateRequest(v.request); return v; }
  fail("unsupported native request type");
}
export function validateNativeResponse(v) {
  if (!record(v)) fail("native response must be an object");
  if (v.type === "ready") {
    exact(v, ["type", "version", "session", "targets"]); if (v.version !== PROTOCOL_VERSION) fail("unsupported version");
    str(v.session, "session"); targetList(v.targets, true); return v;
  }
  if (v.type === "targets") { exact(v, ["type", "targets"]); targetList(v.targets, false); return v; }
  if (v.type === "authorized") { exact(v, ["type", "session", "targetId", "origin"]); str(v.session, "session"); str(v.targetId, "targetId"); if (!validOrigin(v.origin)) fail("invalid origin"); return v; }
  if (v.type === "revoked") { exact(v, ["type", "session", "targetId", "reason"]); str(v.session, "session"); str(v.targetId, "targetId"); str(v.reason, "reason", 512); return v; }
  if (v.type === "response" || v.type === "executeResult") { exact(v, ["type", "response"]); validateResponse(v.response); return v; }
  if (v.type === "cancelled") { exact(v, ["type", "session", "id", "dispatched"]); str(v.session, "session"); str(v.id, "id", 128); if (typeof v.dispatched !== "boolean") fail("invalid dispatched flag"); return v; }
  if (v.type === "error") { exact(v, ["type", "code", "message"]); if (!ERRORS.has(v.code) || typeof v.message !== "string" || bytes(v.message) > MAX_ERROR_BYTES) fail("invalid native error"); return v; }
  fail("unsupported native response type");
}
function validOrigin(value) {
  if (typeof value !== "string" || bytes(value) > 2048) return false;
  try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) && u.origin === value; } catch { return false; }
}
function targetList(targets, ready) {
  if (!Array.isArray(targets)) fail("targets must be an array");
  for (const t of targets) {
    if (!record(t)) fail("target must be an object");
    exact(t, ready ? ["id", "tabId", "origin", "title"] : ["id", "tabId", "origin", "title"]);
    str(t.id, "target id"); if (!Number.isSafeInteger(t.tabId) || t.tabId < 0) fail("invalid tabId");
    if (!validOrigin(t.origin)) fail("invalid target origin");
    if (typeof t.title !== "string" || bytes(t.title) > 4096) fail("invalid target title");
  }
}
export function encodeMessage(v) {
  validateRequest(v); const text = JSON.stringify(v);
  if (bytes(text) > MAX_MESSAGE_BYTES) fail("message exceeds maximum size"); return text;
}
export function decodeMessage(input) {
  let text;
  if (typeof input === "string") text = input;
  else if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_MESSAGE_BYTES) fail("message exceeds maximum size");
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } else fail("message must be UTF-8 text or bytes");
  if (bytes(text) > MAX_MESSAGE_BYTES) fail("message exceeds maximum size");
  let parsed; try { parsed = JSON.parse(text); } catch { fail("malformed JSON message"); }
  return validateRequest(parsed);
}
