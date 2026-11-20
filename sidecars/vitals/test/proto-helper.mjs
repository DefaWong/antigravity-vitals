/**
 * Minimal protobuf wire encoder used exclusively by unit tests to build
 * synthetic Antigravity `gen_metadata` and `steps` blobs.
 */

export function encodeVarint(value) {
  let v = BigInt(value);
  if (v < 0n) {
    v = (1n << 64n) + v;
  }
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return Buffer.from(out);
}

export function encodeTag(field, wireType) {
  return encodeVarint((field << 3) | wireType);
}

export function fieldVarint(field, value) {
  return Buffer.concat([encodeTag(field, 0), encodeVarint(value)]);
}

export function fieldBytes(field, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return Buffer.concat([encodeTag(field, 2), encodeVarint(b.length), b]);
}

export function fieldString(field, str) {
  return fieldBytes(field, Buffer.from(str, 'utf-8'));
}

export function encodeMessage(parts) {
  return Buffer.concat(parts.filter(Boolean));
}

export function encodeDuration(sec) {
  const whole = Math.trunc(sec);
  const nanos = Math.round((sec - whole) * 1e9);
  return encodeMessage([
    whole !== 0 ? fieldVarint(1, whole) : null,
    nanos !== 0 ? fieldVarint(2, nanos) : null,
  ]);
}

export function encodeTimestampMs(epochMs) {
  const whole = Math.floor(epochMs / 1000);
  const nanos = Math.round((epochMs - whole * 1000) * 1e6);
  return encodeMessage([
    fieldVarint(1, whole),
    nanos !== 0 ? fieldVarint(2, nanos) : null,
  ]);
}

export function encodePackedVarints(values) {
  return Buffer.concat(values.map((v) => encodeVarint(v)));
}
