export const MAX_NATIVE_BYTES = 1024 * 1024;

export function encodeNativeFrame(value) {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  if (payload.byteLength > MAX_NATIVE_BYTES) throw new RangeError("native message too large");
  const frame = new Uint8Array(payload.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, true);
  frame.set(payload, 4);
  return frame;
}

export function decodeNativeFrame(frame) {
  if (!(frame instanceof Uint8Array) || frame.byteLength < 4) throw new TypeError("invalid native frame");
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
  if (length > MAX_NATIVE_BYTES || length !== frame.byteLength - 4) throw new RangeError("invalid native frame length");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(4)));
}
