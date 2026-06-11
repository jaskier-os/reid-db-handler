// IEEE-754 half-precision (binary16) decode. Node has no native float16 read.
// Layout: sign(1) exponent(5) mantissa(10), little-endian in the buffer.
export function readFloat16(buffer, offset) {
  const h = buffer.readUInt16LE(offset);
  const sign = (h & 0x8000) ? -1 : 1;
  const exponent = (h & 0x7c00) >> 10;
  const mantissa = h & 0x03ff;

  if (exponent === 0) {
    // Subnormal (or zero).
    return sign * mantissa * Math.pow(2, -24);
  }
  if (exponent === 0x1f) {
    // Inf / NaN.
    return mantissa ? NaN : sign * Infinity;
  }
  // Normalized.
  return sign * (1 + mantissa / 1024) * Math.pow(2, exponent - 15);
}
