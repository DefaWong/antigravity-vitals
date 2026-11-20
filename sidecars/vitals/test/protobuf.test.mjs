import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeDurationSec,
  decodePackedVarints,
  decodeTimestampMs,
  decodeUtf8,
  findAllFields,
  findField,
  parseFields,
} from '../lib/protobuf.mjs';
import {
  encodeDuration,
  encodeMessage,
  encodePackedVarints,
  encodeTimestampMs,
  fieldBytes,
  fieldString,
  fieldVarint,
} from './proto-helper.mjs';

describe('protobuf wire reader', () => {
  it('parses varint, string, nested message, and fixed fields', () => {
    const inner = encodeMessage([
      fieldVarint(2, 10627),
      fieldVarint(3, 183),
      fieldVarint(5, 22412),
    ]);
    const outer = encodeMessage([
      fieldVarint(3, 1532),
      fieldBytes(4, inner),
      fieldString(19, 'gemini-4-neon'),
      fieldString(21, 'Gemini 4 Neon (XHigh)'),
    ]);

    const fields = parseFields(outer);
    assert.ok(fields);
    assert.equal(findField(fields, 3, 0)?.value, 1532);
    assert.equal(decodeUtf8(findField(fields, 19, 2)?.bytes), 'gemini-4-neon');
    assert.equal(decodeUtf8(findField(fields, 21, 2)?.bytes), 'Gemini 4 Neon (XHigh)');

    const usageFields = parseFields(findField(fields, 4, 2)?.bytes);
    assert.equal(findField(usageFields, 2, 0)?.value, 10627);
    assert.equal(findField(usageFields, 3, 0)?.value, 183);
    assert.equal(findField(usageFields, 5, 0)?.value, 22412);
  });

  it('decodes packed varints (step_indices)', () => {
    const packed = encodePackedVarints([1, 2, 3, 128, 300]);
    assert.deepEqual(decodePackedVarints(packed), [1, 2, 3, 128, 300]);
  });

  it('decodes google.protobuf.Duration accurately including sub-second nanos', () => {
    const ttftBuf = encodeDuration(5.042538167);
    assert.ok(Math.abs(decodeDurationSec(ttftBuf) - 5.042538167) < 1e-6);

    const subSecBuf = encodeDuration(0.528232375);
    assert.ok(Math.abs(decodeDurationSec(subSecBuf) - 0.528232375) < 1e-6);

    assert.equal(decodeDurationSec(Buffer.alloc(0)), 0);
  });

  it('decodes google.protobuf.Timestamp into epoch milliseconds', () => {
    const tsMs = Date.parse('2026-11-20T13:04:16.784Z');
    const buf = encodeTimestampMs(tsMs);
    assert.ok(Math.abs(decodeTimestampMs(buf) - tsMs) < 1);
    assert.equal(decodeTimestampMs(Buffer.alloc(0)), null);
  });

  it('handles repeated fields via findAllFields', () => {
    const msg = encodeMessage([
      fieldString(8, 'read_file'),
      fieldString(8, 'run_command'),
      fieldString(8, 'write_file'),
    ]);
    const fields = parseFields(msg);
    const names = findAllFields(fields, 8, 2).map((f) => decodeUtf8(f.bytes));
    assert.deepEqual(names, ['read_file', 'run_command', 'write_file']);
  });

  it('returns null safely for truncated or malformed buffers', () => {
    assert.equal(parseFields(Buffer.from([0x08, 0x80, 0x80])), null); // unterminated varint
    assert.equal(parseFields(Buffer.from([0x12, 0x50, 0x01, 0x02])), null); // length exceeds buffer
    assert.equal(parseFields(Buffer.from([0x00, 0x01])), null); // field number 0
    assert.equal(parseFields(Buffer.from([0x0b])), null); // unsupported group wireType 3
  });
});
