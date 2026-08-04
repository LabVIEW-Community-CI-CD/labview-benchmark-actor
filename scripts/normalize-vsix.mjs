#!/usr/bin/env node
// normalize-vsix.mjs -- make the packaged .vsix byte-reproducible by pinning the per-entry DOS timestamps
// (mod time/date) in every local file header + central-directory record to a fixed constant.
//
// WHY: vsce (via yazl) stamps each zip entry's mtime with the PACKAGE time (`new Date()`) and does not honor
// SOURCE_DATE_EPOCH, so two `vsce package` runs of the SAME commit produce byte-different .vsix files -- the
// entry names/order/content are identical, only ~72 timestamp bytes differ. That breaks the release-review
// invariant (ADR-0066 / LBA-REQ-085): the vsixSha256 a human reviewed can never equal the vsixSha256 CI ships,
// because the hash is a moving target. Pinning every entry timestamp to 1980-01-01 (the DOS-zip epoch) makes
// the SAME committed tree always package to the SAME sha256 -> reviewed artifact == shipped artifact.
//
// Pure Node (no deps): walks End-of-Central-Directory -> central directory -> each local header, patching only
// the 2-byte mod-time + 2-byte mod-date fields; all content, entry order, names, and compression are untouched.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
// 1980-01-01 00:00:00 -- year 1980 encodes as 0, the minimum/canonical reproducible-zip DOS timestamp.
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021;

/** Pin every entry's DOS mod-time/date (central dir + local headers) in a .vsix/.zip buffer. Returns the count. */
export function normalizeZipTimestamps(buf) {
  // Find the EOCD by scanning backward from the minimum EOCD position (handles an optional trailing comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('normalize-vsix: no End-of-Central-Directory record found (not a zip?)');
  const totalEntries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central-directory offset
  let patched = 0;
  for (let n = 0; n < totalEntries; n += 1) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`normalize-vsix: bad central-dir signature at offset ${p}`);
    // Central-directory record: mod time @ +12, mod date @ +14.
    buf.writeUInt16LE(FIXED_DOS_TIME, p + 12);
    buf.writeUInt16LE(FIXED_DOS_DATE, p + 14);
    // Follow the local-header offset (@ +42) and patch its mod time @ +10 / mod date @ +12.
    const lho = buf.readUInt32LE(p + 42);
    if (buf.readUInt32LE(lho) !== SIG_LOCAL) throw new Error(`normalize-vsix: bad local-header signature at offset ${lho}`);
    buf.writeUInt16LE(FIXED_DOS_TIME, lho + 10);
    buf.writeUInt16LE(FIXED_DOS_DATE, lho + 12);
    patched += 1;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return patched;
}

/** Normalize a .vsix file in place. Returns the entry count. */
export function normalizeVsix(path) {
  const buf = readFileSync(path);
  const n = normalizeZipTimestamps(buf);
  writeFileSync(path, buf);
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2] || 'labview-benchmark-actor.vsix';
  const n = normalizeVsix(path);
  console.log(`normalize-vsix: pinned ${n} entry timestamps in ${path} (byte-reproducible)`);
}
