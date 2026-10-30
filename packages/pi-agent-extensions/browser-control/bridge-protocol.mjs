export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_ERROR_BYTES = 512;
export const ACTIONS = Object.freeze([
  "observe", "tabs", "click", "type", "key", "scroll", "navigate", "cancel",
]);

const ERROR_CODES = new Set([
  "INVALID_REQUEST", "UNSUPPORTED_VERSION", "UNAUTHORIZED", "STALE_SESSION",
  "TARGET_NOT_FOUND", "UNSUPPORTED_ACTION", "CANCELLED", "TIMEOUT", "TOO_LARGE", "INTERNAL",
]);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const byteLength = value => new TextEncoder().encode(value).byteLength;
const fail = message => { throw new TypeError(message); };

function boundedString(value, name, max = 256) {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > max) fail(`${name} must be a non-empty string of at most ${max} UTF-8 bytes`);
}

export function validateRequest(value) {
  if (!isRecord(value)) fail("request must be an object");
  const keys = ["version", "id", "session", "target", "action", "args"];
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !own(value, key))) fail("request has missing or unknown fields");
  if (value.version !== PROTOCOL_VERSION) fail("unsupported protocol version");
  boundedString(value.id, "id", 128);
  boundedString(value.session, "session", 256);
  boundedString(value.target, "target", 256);
  if (typeof value.action !== "string" || !ACTIONS.includes(value.action)) fail("unsupported action");
  if (!isRecord(value.args)) fail("args must be an object");
  if (value.action === "cancel") {
    if (Object.keys(value.args).length !== 1 || !own(value.args, "requestId")) fail("cancel args must contain only requestId");
    boundedString(value.args.requestId, "requestId", 128);
  }
  return value;
}

export function validateResponse(value) {
  if (!isRecord(value)) fail("response must be an object");
  const keys = ["version", "id", "session", "ok", "result", "error"];
  if (Object.keys(value).some(key => !keys.includes(key))) fail("response has unknown fields");
  for (const key of ["version", "id", "session", "ok"]) if (!own(value, key)) fail(`response missing ${key}`);
  if (value.version !== PROTOCOL_VERSION) fail("unsupported protocol version");
  boundedString(value.id, "id", 128);
  boundedString(value.session, "session", 256);
  if (typeof value.ok !== "boolean") fail("ok must be boolean");
  if (value.ok) {
    if (!own(value, "result") || !isRecord(value.result) || own(value, "error")) fail("successful response requires result only");
  } else {
    if (!own(value, "error") || own(value, "result") || !isRecord(value.error)) fail("failed response requires error only");
    const { code, message, retryable } = value.error;
    if (Object.keys(value.error).some(key => !["code", "message", "retryable"].includes(key))) fail("error has unknown fields");
    if (!ERROR_CODES.has(code) || typeof message !== "string" || byteLength(message) > MAX_ERROR_BYTES || typeof retryable !== "boolean") fail("invalid error object");
  }
  return value;
}

export function encodeMessage(value) {
  validateRequest(value);
  const encoded = JSON.stringify(value);
  if (byteLength(encoded) > MAX_MESSAGE_BYTES) fail("message exceeds maximum size");
  return encoded;
}

export function decodeMessage(input) {
  let text;
  if (typeof input === "string") text = input;
  else if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_MESSAGE_BYTES) fail("message exceeds maximum size");
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } else fail("message must be UTF-8 text or bytes");
  if (byteLength(text) > MAX_MESSAGE_BYTES) fail("message exceeds maximum size");
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail("malformed JSON message"); }
  return validateRequest(parsed);
}
