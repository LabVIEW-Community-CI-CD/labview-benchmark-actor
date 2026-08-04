#!/usr/bin/env node
// normalize-vsix.mjs -- make the packaged .vsix byte-reproducible by pinning the per-entry DOS timestamps
// (mod time/date) in every local file header + central-directory record to a fixed constant.
//
// WHY: vsce (via yazl) writes OS-DEPENDENT metadata into every zip entry, so two builds of the SAME commit -- and
// especially a Windows build vs a Linux build -- produce byte-different .vsix files even though the entry
// names/order/content are identical:
//   * mod time/date  -- stamped with the PACKAGE wall-clock time (`new Date()`; SOURCE_DATE_EPOCH is ignored);
//   * external file attributes -- the unix mode from `fs.stat` (0664 on Linux w/ umask 002; a FAKED mode on Windows);
//   * version made by -- the host byte.
// That breaks the release-review invariant (ADR-0066 / LBA-REQ-085): the vsixSha256 a human reviewed can never
// equal the vsixSha256 CI ships. It also blocks CROSS-PLANE corroboration (ADR-0067 / LBA-REQ-086): a windows-plane
// and a linux-plane witness cannot agree on ONE identical artifact. Pinning every entry's timestamp (1980-01-01),
// mode (regular file 0644), and version-made-by (Unix) makes the SAME committed tree package to the SAME sha256 on
// EVERY plane -> reviewed == shipped, and the two planes corroborate identical bytes. (Content must also be LF on
// every plane -- enforced by .gitattributes for the packaged files; this normalizer handles the zip METADATA.)
//
// Pure Node (no deps): walks End-of-Central-Directory -> central directory -> each local header, patching only the
// metadata fields above; all content, entry order, names, and compression are untouched.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
// 1980-01-01 00:00:00 -- year 1980 encodes as 0, the minimum/canonical reproducible-zip DOS timestamp.
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021;
// External file attributes = (unix mode << 16). 0o100644 = regular file, rw-r--r-- -> a single canonical mode on
// every plane (removes the 0664-vs-faked-Windows-mode drift). Low 16 bits (DOS attrs) = 0 (normal file).
const FIXED_EXTERNAL_ATTRS = 0x81a40000;
// "version made by": host = Unix (3), zip spec 6.3 (0x3F) -> (3 << 8) | 0x3F. Pins the host byte so it never
// varies by the build platform.
const FIXED_VERSION_MADE_BY = 0x033f;

/**
 * Pin every entry's OS-dependent zip metadata (DOS mod-time/date + version-made-by + external file attributes)
 * so the same committed tree packages byte-identically on every plane (windows == linux). Returns the count.
 */
export function normalizeZipEntries(buf) {
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
    // Central-directory record -- pin the OS-dependent metadata so a Windows build equals a Linux build:
    buf.writeUInt16LE(FIXED_VERSION_MADE_BY, p + 4); // version made by (host byte)
    buf.writeUInt16LE(FIXED_DOS_TIME, p + 12); // mod time
    buf.writeUInt16LE(FIXED_DOS_DATE, p + 14); // mod date
    buf.writeUInt32LE(FIXED_EXTERNAL_ATTRS, p + 38); // external file attributes (unix mode -> 0644)
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

/** Back-compat alias -- the normalizer now pins timestamps AND mode AND version-made-by. */
export const normalizeZipTimestamps = normalizeZipEntries;

/** Normalize a .vsix file in place. Returns the entry count. */
export function normalizeVsix(path) {
  const buf = readFileSync(path);
  const n = normalizeZipEntries(buf);
  writeFileSync(path, buf);
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2] || 'labview-benchmark-actor.vsix';
  const n = normalizeVsix(path);
  console.log(`normalize-vsix: normalized ${n} entries in ${path} (timestamps + mode + version -> cross-plane reproducible)`);
}
