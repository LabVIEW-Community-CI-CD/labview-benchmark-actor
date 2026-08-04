// test/normalize-vsix.mjs -- proves scripts/normalize-vsix.mjs removes the .vsix timestamp non-determinism:
// two zips with byte-identical CONTENT but different entry mtimes normalize to byte-identical output, the
// normalizer is idempotent, and every entry's DOS timestamp is pinned to the fixed epoch (1980-01-01).
import assert from 'node:assert';
import yazl from 'yazl';
import { normalizeZipTimestamps } from '../scripts/normalize-vsix.mjs';

// Build a tiny zip (same content) stamped with a given mtime, matching how vsce/yazl package (no extra fields).
function buildZip(mtime) {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    z.addBuffer(Buffer.from('hello world\n'), 'extension/a.txt', { mtime, compress: false });
    z.addBuffer(Buffer.from(JSON.stringify({ x: 1, y: [2, 3] })), 'extension/dir/b.json', { mtime, compress: true });
    z.addBuffer(Buffer.from('<xml/>'), '[Content_Types].xml', { mtime, compress: true });
    const chunks = [];
    z.outputStream.on('data', (c) => chunks.push(c));
    z.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    z.outputStream.on('error', reject);
    z.end();
  });
}

const early = await buildZip(new Date('2021-03-04T05:06:08Z'));
const late = await buildZip(new Date('2026-08-04T11:22:33Z'));
assert.ok(!early.equals(late), 'precondition: same content + different mtimes => byte-different zips (the bug)');

// The 3 entries have no extended-timestamp extra fields (matches vsce output) -- otherwise DOS-only normalization
// would be insufficient. Assert that assumption holds for this yazl.
const a = Buffer.from(early);
const b = Buffer.from(late);
const nA = normalizeZipTimestamps(a);
const nB = normalizeZipTimestamps(b);
assert.strictEqual(nA, 3, 'normalized all 3 entries (a)');
assert.strictEqual(nB, 3, 'normalized all 3 entries (b)');
assert.ok(a.equals(b), 'after normalize: two same-content zips with different mtimes are BYTE-IDENTICAL (reproducible)');

// Idempotent: normalizing an already-normalized zip changes nothing.
const c = Buffer.from(a);
normalizeZipTimestamps(c);
assert.ok(a.equals(c), 'normalize is idempotent');

// The pinned value is the DOS epoch: local header mod time @+10 = 0x0000, mod date @+12 = 0x0021.
const firstLocal = a.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
assert.notStrictEqual(firstLocal, -1, 'has a local file header');
assert.strictEqual(a.readUInt16LE(firstLocal + 10), 0x0000, 'DOS mod time pinned to 0x0000');
assert.strictEqual(a.readUInt16LE(firstLocal + 12), 0x0021, 'DOS mod date pinned to 0x0021 (1980-01-01)');

// Fail-closed: a non-zip buffer throws (no silent no-op).
assert.throws(() => normalizeZipTimestamps(Buffer.from('not a zip at all')), /End-of-Central-Directory/, 'non-zip fails closed');

console.log('normalize-vsix: PASS -- same-content zips with different mtimes normalize byte-identical + idempotent + DOS-epoch pinned + fail-closed on non-zip');
