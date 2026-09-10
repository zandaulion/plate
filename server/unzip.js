// A deliberately small ZIP reader for Plate backups.
//
// Exports use ordinary ZIP files and Android's ZipOutputStream uses deflate,
// so accepting both stored and deflated entries keeps the PWA/Android contract
// portable without taking a general archive-extraction dependency. Callers
// still validate the allowed names and data schema.

import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const u16 = (buffer, offset) => buffer.readUInt16LE(offset);
const u32 = (buffer, offset) => buffer.readUInt32LE(offset);

/**
 * Returns every non-directory entry as a Map of UTF-8 name -> Buffer.
 * ZIP64, encryption, data larger than the caller's bounds and duplicate names
 * are rejected rather than being guessed at.
 */
export function unzip(buffer, { maxEntries = 2048, maxEntryBytes = 16 * 1024 * 1024, maxTotalBytes = 250 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('The backup is not a ZIP file.');

  let eocd = -1;
  const start = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= start; offset--) {
    if (u32(buffer, offset) === EOCD) { eocd = offset; break; }
  }
  if (eocd < 0 || eocd + 22 > buffer.length) throw new Error('The backup ZIP is incomplete.');

  const entries = u16(buffer, eocd + 10);
  const centralSize = u32(buffer, eocd + 12);
  const centralOffset = u32(buffer, eocd + 16);
  if (entries > maxEntries || centralOffset + centralSize > eocd) throw new Error('The backup ZIP is not supported.');

  const files = new Map();
  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > buffer.length || u32(buffer, offset) !== CENTRAL) throw new Error('The backup ZIP directory is invalid.');
    const flags = u16(buffer, offset + 8);
    const method = u16(buffer, offset + 10);
    const compressed = u32(buffer, offset + 20);
    const uncompressed = u32(buffer, offset + 24);
    const nameLength = u16(buffer, offset + 28);
    const extraLength = u16(buffer, offset + 30);
    const commentLength = u16(buffer, offset + 32);
    const localOffset = u32(buffer, offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > buffer.length) throw new Error('The backup ZIP directory is incomplete.');
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset = next;

    if (name.endsWith('/')) continue;
    if ((flags & 1) !== 0 || ![0, 8].includes(method)) throw new Error('The backup ZIP uses an unsupported entry format.');
    if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some((part) => part === '..')) {
      throw new Error('The backup ZIP contains an unsafe file path.');
    }
    if (uncompressed > maxEntryBytes || total + uncompressed > maxTotalBytes) throw new Error('The backup is too large.');
    if (localOffset + 30 > buffer.length || u32(buffer, localOffset) !== LOCAL) throw new Error('The backup ZIP has an invalid entry.');
    const localName = u16(buffer, localOffset + 26);
    const localExtra = u16(buffer, localOffset + 28);
    const dataStart = localOffset + 30 + localName + localExtra;
    const dataEnd = dataStart + compressed;
    if (dataEnd > buffer.length || files.has(name)) throw new Error('The backup ZIP has an invalid entry.');

    const stored = buffer.subarray(dataStart, dataEnd);
    const data = method === 0 ? Buffer.from(stored) : inflateRawSync(stored, { maxOutputLength: maxEntryBytes });
    if (data.length !== uncompressed) throw new Error('The backup ZIP has an incomplete entry.');
    total += data.length;
    files.set(name, data);
  }
  return files;
}
