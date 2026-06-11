import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFloat16 } from './float16.js';

// Minimal IEEE-754 half-precision encoder, used only to feed readFloat16 in tests.
function writeFloat16(value) {
  const buf = Buffer.allocUnsafe(2);
  if (Number.isNaN(value)) {
    buf.writeUInt16LE(0x7e00, 0); // canonical quiet NaN
    return buf;
  }
  if (value === 0) {
    buf.writeUInt16LE(Object.is(value, -0) ? 0x8000 : 0x0000, 0);
    return buf;
  }
  const sign = value < 0 ? 0x8000 : 0;
  const abs = Math.abs(value);
  if (abs === Infinity) {
    buf.writeUInt16LE(sign | 0x7c00, 0);
    return buf;
  }
  let exponent = Math.floor(Math.log2(abs));
  let mantissa = abs / Math.pow(2, exponent) - 1;
  let biased = exponent + 15;
  if (biased <= 0) {
    // subnormal
    const sub = Math.round(abs / Math.pow(2, -24));
    buf.writeUInt16LE(sign | sub, 0);
    return buf;
  }
  if (biased >= 0x1f) {
    buf.writeUInt16LE(sign | 0x7c00, 0);
    return buf;
  }
  const mantBits = Math.round(mantissa * 1024);
  buf.writeUInt16LE(sign | (biased << 10) | mantBits, 0);
  return buf;
}

test('readFloat16 round-trips known values', () => {
  for (const v of [0.0, 1.0, -1.0, 0.5, -0.5, 2.0, 0.25]) {
    const buf = writeFloat16(v);
    assert.equal(readFloat16(buf, 0), v, `value ${v}`);
  }
});

test('readFloat16 decodes NaN', () => {
  const buf = writeFloat16(NaN);
  assert.ok(Number.isNaN(readFloat16(buf, 0)));
});

test('readFloat16 respects offset', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xff]), writeFloat16(1.0)]);
  assert.equal(readFloat16(buf, 2), 1.0);
});

export { writeFloat16 };
