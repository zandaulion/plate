/**
 * When a photograph was taken, out of its own bytes.
 *
 * Only one tag is wanted -- DateTimeOriginal -- so this walks to it rather
 * than parsing EXIF properly. A camera roll picture carries it; a screenshot,
 * a re-saved image or a download usually does not, and the honest answer then
 * is null rather than the file's modification time, which is when it arrived
 * on the phone rather than when the meal was in front of somebody.
 *
 * No dependency: the format is a JPEG marker chain, then a TIFF header, then
 * two directories. Roughly sixty lines, against a library that would have to
 * be vendored into a service-worker-cached PWA.
 */

const SOI = 0xffd8;
const APP1 = 0xffe1;
const DATE_TIME_ORIGINAL = 0x9003;
const EXIF_IFD_POINTER = 0x8769;

export function readTakenOn(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== SOI) return null;

  // Walk the marker segments looking for APP1, which is where EXIF lives.
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    const size = view.getUint16(offset + 2);
    if ((marker & 0xff00) !== 0xff00 || size < 2) return null;
    if (marker === APP1) return readExif(view, offset + 4, size - 2);
    offset += 2 + size;
  }
  return null;
}

function readExif(view, start, length) {
  // "Exif\0\0", then a TIFF header whose byte order the rest is written in.
  if (start + 14 > view.byteLength) return null;
  for (const [i, c] of [...'Exif'].entries()) {
    if (view.getUint8(start + i) !== c.charCodeAt(0)) return null;
  }
  const tiff = start + 6;
  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const little = order === 0x4949;
  if (view.getUint16(tiff + 2, little) !== 42) return null;

  const ifd0 = tiff + view.getUint32(tiff + 4, little);
  const end = Math.min(view.byteLength, start + length);

  // The date lives in the Exif sub-directory, which IFD0 points at.
  const exifIfd = findTag(view, ifd0, tiff, little, end, EXIF_IFD_POINTER);
  if (exifIfd === null) return null;

  const value = findTag(view, tiff + exifIfd, tiff, little, end, DATE_TIME_ORIGINAL, true);
  return value ? parseExifDate(value) : null;
}

function findTag(view, dirStart, tiff, little, end, wanted, asString = false) {
  if (dirStart + 2 > end) return null;
  const count = view.getUint16(dirStart, little);
  for (let i = 0; i < count; i++) {
    const entry = dirStart + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (view.getUint16(entry, little) !== wanted) continue;

    if (!asString) return view.getUint32(entry + 8, little);

    const len = view.getUint32(entry + 4, little);
    // 19 characters plus a terminator; anything else is not a date string.
    if (len < 19) return null;
    const at = tiff + view.getUint32(entry + 8, little);
    if (at + 19 > end) return null;
    let out = '';
    for (let c = 0; c < 19; c++) out += String.fromCharCode(view.getUint8(at + c));
    return out;
  }
  return null;
}

/** "2026:09:02 13:41:07" — colons in the date, and local time, no zone. */
function parseExifDate(text) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m.map(Number);
  // Built in local time deliberately: EXIF carries no zone, and the camera
  // clock was set to wherever the person was standing.
  const date = new Date(y, mo - 1, d, h, mi, sec);
  if (Number.isNaN(date.getTime())) return null;

  // A clock that was never set, or a date in the future, is not evidence.
  const now = Date.now();
  if (date.getTime() > now + 86400000 || date.getFullYear() < 2000) return null;
  return date;
}
