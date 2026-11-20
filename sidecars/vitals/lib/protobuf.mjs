/**
 * Minimal, zero-dependency Protocol Buffers wire-format reader.
 *
 * Uses zero-copy Buffer/Uint8Array subarrays and guards every offset/length
 * check so truncated or future-schema blobs never throw inside the sidecar.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MASK_64 = (1n << 64n) - 1n;
const SIGN_64 = 1n << 63n;
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Convert raw input into a Buffer/Uint8Array view, or null if empty/unsupported.
 */
export function toUint8Array(input) {
  if (!input) return null;
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return null;
}

/**
 * Decode an unsigned LEB128 varint starting at `offset`.
 * Returns `{ value: bigint, nextOffset: number }` or `null` if malformed/truncated.
 */
export function decodeVarint(bytes, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  let count = 0;

  while (pos < bytes.length && count < 10) {
    const byte = bytes[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    count++;
    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: pos };
    }
    shift += 7n;
  }
  return null;
}

/**
 * Convert an unsigned protobuf varint BigInt to a JS Number (signed int64 aware).
 */
export function varintToNumber(val) {
  const masked = val & MASK_64;
  if (masked >= SIGN_64) {
    const signed = masked - (1n << 64n);
    return Number(signed);
  }
  return masked <= MAX_SAFE ? Number(masked) : Number(masked);
}

/**
 * Parse top-level wire fields of a protobuf message.
 * Returns an array of `{ field, wireType, value?, bytes? }` or `null` if invalid.
 */
export function parseFields(input) {
  const bytes = toUint8Array(input);
  if (!bytes) return null;
  if (bytes.length === 0) return [];

  const fields = [];
  let pos = 0;

  while (pos < bytes.length) {
    const tagRes = decodeVarint(bytes, pos);
    if (!tagRes) return null;
    pos = tagRes.nextOffset;

    const tagNum = Number(tagRes.value & 0xffffffffn);
    const field = tagNum >>> 3;
    const wireType = tagNum & 7;
    if (field === 0) return null;

    if (wireType === 0) {
      const valRes = decodeVarint(bytes, pos);
      if (!valRes) return null;
      pos = valRes.nextOffset;
      fields.push({ field, wireType, value: varintToNumber(valRes.value), raw: valRes.value });
    } else if (wireType === 1) {
      if (pos + 8 > bytes.length) return null;
      const slice = bytes.subarray(pos, pos + 8);
      pos += 8;
      fields.push({ field, wireType, bytes: slice });
    } else if (wireType === 2) {
      const lenRes = decodeVarint(bytes, pos);
      if (!lenRes) return null;
      pos = lenRes.nextOffset;
      const len = Number(lenRes.value);
      if (!Number.isSafeInteger(len) || len < 0 || pos + len > bytes.length) return null;
      const slice = bytes.subarray(pos, pos + len);
      pos += len;
      fields.push({ field, wireType, bytes: slice });
    } else if (wireType === 5) {
      if (pos + 4 > bytes.length) return null;
      const slice = bytes.subarray(pos, pos + 4);
      pos += 4;
      fields.push({ field, wireType, bytes: slice });
    } else {
      return null;
    }
  }

  return fields;
}

/**
 * Decode a packed repeated varint buffer (wireType 2) into an array of numbers.
 */
export function decodePackedVarints(input) {
  const bytes = toUint8Array(input);
  if (!bytes || bytes.length === 0) return [];
  const values = [];
  let pos = 0;
  while (pos < bytes.length) {
    const res = decodeVarint(bytes, pos);
    if (!res) break;
    values.push(varintToNumber(res.value));
    pos = res.nextOffset;
  }
  return values;
}

/**
 * Decode a `google.protobuf.Duration` message into seconds (floating-point).
 */
export function decodeDurationSec(input) {
  const fields = parseFields(input);
  if (!fields) return null;
  let seconds = 0;
  let nanos = 0;
  for (const f of fields) {
    if (f.field === 1 && f.wireType === 0) seconds = f.value;
    else if (f.field === 2 && f.wireType === 0) nanos = f.value;
  }
  const total = seconds + nanos / 1e9;
  return Number.isFinite(total) ? total : null;
}

/**
 * Decode a `google.protobuf.Timestamp` message into Unix epoch milliseconds.
 */
export function decodeTimestampMs(input) {
  const fields = parseFields(input);
  if (!fields) return null;
  let seconds = 0;
  let nanos = 0;
  let seen = false;
  for (const f of fields) {
    if (f.field === 1 && f.wireType === 0) {
      seconds = f.value;
      seen = true;
    } else if (f.field === 2 && f.wireType === 0) {
      nanos = f.value;
      seen = true;
    }
  }
  if (!seen) return null;
  const ms = seconds * 1000 + nanos / 1e6;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decode a UTF-8 byte slice to string.
 */
export function decodeUtf8(input) {
  const bytes = toUint8Array(input);
  if (!bytes || bytes.length === 0) return '';
  return utf8Decoder.decode(bytes);
}

/**
 * Find the first matching field by field number and optional wireType.
 */
export function findField(fields, fieldNum, wireType) {
  if (!fields) return null;
  for (const f of fields) {
    if (f.field === fieldNum && (wireType === undefined || f.wireType === wireType)) {
      return f;
    }
  }
  return null;
}

/**
 * Find all matching fields by field number and optional wireType.
 */
export function findAllFields(fields, fieldNum, wireType) {
  if (!fields) return [];
  const out = [];
  for (const f of fields) {
    if (f.field === fieldNum && (wireType === undefined || f.wireType === wireType)) {
      out.push(f);
    }
  }
  return out;
}
