/**
 * Since macOS Ventura, many rows in chat.db have `text = NULL` and keep the message in `attributedBody`,
 * an NSAttributedString serialized with NSArchiver's "typedstream" format. The plain string sits right
 * after the `NSString` class name: a few type bytes, a `+` (0x2B), then a length-prefixed UTF-8 string.
 * Lengths < 0x80 are a single byte; 0x81 / 0x82 introduce a little-endian int16 / int32.
 */
export function decodeAttributedBody(blob: Uint8Array | null | undefined): string | null {
  if (!blob || !blob.length) return null;
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const marker = buf.indexOf('NSString');
  if (marker < 0) return null;
  const start = marker + 'NSString'.length;
  const plus = buf.indexOf(0x2b, start);
  if (plus < 0 || plus - start > 16) return null;

  let i = plus + 1;
  if (i >= buf.length) return null;
  let len = buf[i];
  i += 1;
  if (len === 0x81) {
    if (i + 2 > buf.length) return null;
    len = buf.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    if (i + 4 > buf.length) return null;
    len = buf.readUInt32LE(i);
    i += 4;
  } else if (len >= 0x80) {
    return null;
  }
  if (i + len > buf.length) return null;
  return buf.subarray(i, i + len).toString('utf8');
}

/** Removes attachment placeholders (U+FFFC) and trims. */
export function cleanMessageText(text: string | null): string {
  return (text ?? '').replace(/\uFFFC/g, '').trim();
}
