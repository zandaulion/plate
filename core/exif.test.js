import test from 'node:test';
import assert from 'node:assert/strict';
import { readTakenOn } from './exif.js';

/** A JPEG that is nothing but a valid EXIF block carrying one date. */
function jpegWithDate(text, { order = 'little' } = {}) {
  const little = order === 'little';
  const body = new ArrayBuffer(200);
  const v = new DataView(body);
  const put16 = (o, n) => v.setUint16(o, n, little);
  const put32 = (o, n) => v.setUint32(o, n, little);

  // TIFF header at 0, so every offset below is from there.
  v.setUint16(0, little ? 0x4949 : 0x4d4d);
  put16(2, 42);
  put32(4, 8);            // IFD0 at 8

  put16(8, 1);            // one entry
  put16(10, 0x8769);      // Exif IFD pointer
  put16(12, 4); put32(14, 1);
  put32(18, 30);          // the sub-directory sits at 30
  put32(22, 0);           // no next IFD

  put16(30, 1);           // one entry
  put16(32, 0x9003);      // DateTimeOriginal
  put16(34, 2); put32(36, 20);
  put32(40, 60);          // the string sits at 60
  put32(44, 0);
  for (let i = 0; i < text.length; i++) v.setUint8(60 + i, text.charCodeAt(i));

  const exif = new Uint8Array(body);
  const out = new Uint8Array(2 + 4 + 6 + exif.length);
  const o = new DataView(out.buffer);
  o.setUint16(0, 0xffd8);                 // SOI
  o.setUint16(2, 0xffe1);                 // APP1
  o.setUint16(4, 2 + 6 + exif.length);    // segment length
  out.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6);
  out.set(exif, 12);
  return out.buffer;
}

test('reads the date the picture was taken', () => {
  const d = readTakenOn(jpegWithDate('2026:09:02 13:41:07'));
  assert.ok(d instanceof Date);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 2);
  assert.equal(d.getHours(), 13, 'local time — EXIF carries no zone');
});

test('reads both byte orders, since cameras disagree', () => {
  const d = readTakenOn(jpegWithDate('2026:09:02 13:41:07', { order: 'big' }));
  assert.ok(d instanceof Date);
  assert.equal(d.getDate(), 2);
});

test('a file with no EXIF gives null, not a guess', () => {
  // A screenshot or a re-saved image. Falling back to the file's own
  // modification time would report when it arrived on the phone, not when the
  // meal was in front of anybody.
  const plain = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x02, 0x00, 0x00]).buffer;
  assert.equal(readTakenOn(plain), null);
  assert.equal(readTakenOn(new Uint8Array([1, 2, 3]).buffer), null);
});

test('an unset or impossible clock is refused', () => {
  assert.equal(readTakenOn(jpegWithDate('1980:01:01 00:00:00')), null);
  // The whole future date, not just its year: "2026:01:01" taken from a date
  // five days from now is still in the past, which is what the first version
  // of this test asserted about.
  const f = new Date(Date.now() + 5 * 86400000);
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${f.getFullYear()}:${two(f.getMonth() + 1)}:${two(f.getDate())} 12:00:00`;
  assert.equal(readTakenOn(jpegWithDate(stamp)), null, `a camera clock set to ${stamp} is not evidence`);
  assert.equal(readTakenOn(jpegWithDate('not a date at all!!')), null);
});
