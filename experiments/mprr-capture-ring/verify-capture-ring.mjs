// verify-capture-ring.mjs — CI proof of the SHARED ring-ingest adapter (capture-ring.mjs) with SYNTHETIC frames
// (no VNC / no VM). Proves the agreed 24-byte contract end-to-end so WIN can wire the VMware VNC streaming source
// against a stable, gated signature and LINUX can wire the VirtualBox VNC source:
//
//   * 24-byte little-endian layout + packetVersion(=1)/reserved(=0) bytes (exact byte positions pinned).
//   * DataView-LE access survives UNALIGNED physical record offsets AND wrap-spanning (one-copy) records —
//     including a direct demonstration that a BigUint64Array view WOULD throw where DataView succeeds.
//   * dhash64 stored as u64 via the single-source fingerprint bit<->hex helpers; hammingHex still works off a
//     ring-decoded frame; a real dhash64FromRgba round-trips through the ring unchanged.
//   * OPTIONAL dhash64: milestone-only records (dhash64 == 0, milestoneId > 0) decode as pure timing markers;
//     visual-only records (dhash64 != 0, milestoneId == 0) decode with caseId == null.
//   * MILESTONE_IDS single-source id<->caseId mapping (LBABUS- prefix on BUILD-START/BUILT).
//   * Fail-closed: empty frame, caseId/milestoneId disagreement, u32/u8 range, unknown caseId, unsupported
//     packetVersion, non-record byte span, and the ring's own overwrite-blocked invariant.
//
//   node experiments/mprr-capture-ring/verify-capture-ring.mjs

import assert from 'node:assert/strict';
import { createShortRing, MIN_CAPACITY_BYTES, CLI_DEFAULT_CAPACITY_BYTES, TICKS_PER_MS } from '../mprr-ring/mprrRing.mjs';
import { dhash64FromRgba, hammingHex, dhashHexToBits, dhashBitsToHex } from '../manual-procedure-record/fingerprint.mjs';
import {
  PACKET_BYTES, PACKET_VERSION, OFFSETS, FLAG_SETTLED, MILESTONE_IDS, MILESTONE_ID_BY_CASE,
  caseIdForMilestone, milestoneIdForCase, encodeCaptureFrame, decodeCaptureFrame,
  writeCaptureFrame, readCaptureFrames,
} from './capture-ring.mjs';

let passed = 0;
function ok(label) { passed += 1; console.log(`  ok  ${label}`); }

/** Deterministic synthetic RGBA gradient (no PNG decode needed) so dhash64FromRgba has real pixels to hash. */
function synthRgba(w, h, seed) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = (y * w + x) * 4;
      rgba[p] = (x * 7 + seed) & 255;
      rgba[p + 1] = (y * 11 + seed) & 255;
      rgba[p + 2] = ((x + y) * 13 + seed) & 255;
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}

// 1) Exact 24-byte little-endian layout + packetVersion/reserved bytes.
{
  const buf = encodeCaptureFrame({
    timingTicks64: 0x0102030405060708n,
    frameIndex: 0x090a0b0c,
    dhash64: 0x1112131415161718n,
    milestoneId: 4,
    settled: true,
  });
  assert.equal(buf.byteLength, PACKET_BYTES, 'encoded record is exactly 24 bytes');
  // timingTicks64 u64 @0, little-endian => low byte first.
  assert.equal(buf[OFFSETS.timingTicks64], 0x08, 'timingTicks64 low byte @0 (LE)');
  assert.equal(buf[OFFSETS.timingTicks64 + 7], 0x01, 'timingTicks64 high byte @7 (LE)');
  // frameIndex u32 @8, LE.
  assert.equal(buf[OFFSETS.frameIndex], 0x0c, 'frameIndex low byte @8 (LE)');
  assert.equal(buf[OFFSETS.frameIndex + 3], 0x09, 'frameIndex high byte @11 (LE)');
  // dhash64 u64 @12, LE.
  assert.equal(buf[OFFSETS.dhash64], 0x18, 'dhash64 low byte @12 (LE)');
  assert.equal(buf[OFFSETS.dhash64 + 7], 0x11, 'dhash64 high byte @19 (LE)');
  assert.equal(buf[OFFSETS.milestoneId], 4, 'milestoneId @20');
  assert.equal(buf[OFFSETS.flags], FLAG_SETTLED, 'flags bit0 (settled) @21');
  assert.equal(buf[OFFSETS.packetVersion], PACKET_VERSION, 'packetVersion @22 == 1');
  assert.equal(buf[OFFSETS.reserved], 0, 'reserved @23 == 0');
  ok('24-byte little-endian layout + packetVersion/reserved bytes pinned');
}

// 2) encode -> decode round-trip (visual + milestone + settled).
{
  const frame = { timingTicks64: 123456789n, frameIndex: 42, dhash64: 0xdeadbeefcafef00dn, milestoneId: 3, settled: true };
  const d = decodeCaptureFrame(encodeCaptureFrame(frame));
  assert.equal(d.timingTicks64, 123456789n, 'timingTicks64 round-trips');
  assert.equal(d.frameIndex, 42, 'frameIndex round-trips');
  assert.equal(d.dhash64, 0xdeadbeefcafef00dn, 'dhash64 round-trips');
  assert.equal(d.dhashHex, 'deadbeefcafef00d', 'dhashHex derives from the u64');
  assert.equal(d.milestoneId, 3, 'milestoneId round-trips');
  assert.equal(d.caseId, 'LBABUS-BUILT', 'caseId reconstructed from milestoneId (LBABUS- prefix)');
  assert.equal(d.settled, true, 'settled flag round-trips');
  assert.equal(d.hasFrame, true, 'hasFrame true when dhash64 != 0');
  assert.equal(d.packetVersion, PACKET_VERSION, 'packetVersion decoded');
  ok('encode/decode round-trip (visual + milestone + settled)');
}

// 3) Round-trip THROUGH the ring: write several frames, read them all back in order.
{
  const ring = createShortRing(CLI_DEFAULT_CAPACITY_BYTES);
  const inputs = [
    { timingTicks64: 10n * TICKS_PER_MS, frameIndex: 0, caseId: 'BOOT-START' },
    { timingTicks64: 20n * TICKS_PER_MS, frameIndex: 1, dhash64: 0x00000000000000ffn, caseId: 'LBABUS-BUILD-START', settled: true },
    { timingTicks64: 30n * TICKS_PER_MS, frameIndex: 2, dhashHex: 'ffffffffffffffff' },
  ];
  const start = ring.state().headPublished;
  let end = start;
  for (const f of inputs) { end = writeCaptureFrame(ring, f).absoluteEndOffset; }
  const out = readCaptureFrames(ring, start, end);
  assert.equal(out.length, 3, 'read back all three records');
  assert.equal(out[0].caseId, 'BOOT-START', 'record 0 caseId');
  assert.equal(out[0].hasFrame, false, 'record 0 is a milestone-only marker (no dhash)');
  assert.equal(out[1].frameIndex, 1, 'record 1 frameIndex');
  assert.equal(out[1].dhash64, 0xffn, 'record 1 dhash64');
  assert.equal(out[1].settled, true, 'record 1 settled');
  assert.equal(out[2].dhashHex, 'ffffffffffffffff', 'record 2 dhashHex (from dhashHex input)');
  assert.equal(out[2].caseId, null, 'record 2 is visual-only (milestoneId 0 => caseId null)');
  ok('round-trip through the ring (write N, read N, in order)');
}

// 4) OPTIONAL dhash64 — milestone-only marker vs visual-only frame.
{
  const marker = decodeCaptureFrame(encodeCaptureFrame({ timingTicks64: 1n, milestoneId: 2 }));
  assert.equal(marker.dhash64, 0n, 'milestone-only: dhash64 == 0');
  assert.equal(marker.hasFrame, false, 'milestone-only: hasFrame false (pure timing marker, no frame)');
  assert.equal(marker.caseId, 'LBABUS-BUILD-START', 'milestone-only: caseId set');
  const visual = decodeCaptureFrame(encodeCaptureFrame({ timingTicks64: 2n, dhash64: 0x1n }));
  assert.equal(visual.hasFrame, true, 'visual-only: hasFrame true');
  assert.equal(visual.milestoneId, 0, 'visual-only: milestoneId 0');
  assert.equal(visual.caseId, null, 'visual-only: caseId null');
  ok('optional dhash64: milestone-only marker AND visual-only frame both valid');
}

// 5) MILESTONE_IDS single-source id<->caseId mapping (LBABUS- prefix on BUILD-START/BUILT).
{
  assert.equal(MILESTONE_IDS[0], null, '0 => none');
  assert.equal(MILESTONE_IDS[1], 'BOOT-START', '1 => BOOT-START');
  assert.equal(MILESTONE_IDS[2], 'LBABUS-BUILD-START', '2 => LBABUS-BUILD-START');
  assert.equal(MILESTONE_IDS[3], 'LBABUS-BUILT', '3 => LBABUS-BUILT');
  assert.equal(MILESTONE_IDS[4], 'MESH-OK', '4 => MESH-OK');
  assert.equal(milestoneIdForCase('MESH-OK'), 4, 'caseId -> id reverse map');
  assert.equal(MILESTONE_ID_BY_CASE['LBABUS-BUILT'], 3, 'reverse map derived from MILESTONE_IDS');
  assert.equal(caseIdForMilestone(0), null, 'caseIdForMilestone(0) => null');
  assert.equal(caseIdForMilestone(99), null, 'caseIdForMilestone(workload marker) => null (not pinned)');
  // Encoding via caseId must equal encoding via the numeric id.
  const viaCase = encodeCaptureFrame({ timingTicks64: 5n, caseId: 'MESH-OK' });
  const viaId = encodeCaptureFrame({ timingTicks64: 5n, milestoneId: 4 });
  assert.deepEqual(Array.from(viaCase), Array.from(viaId), 'caseId encode path == milestoneId encode path');
  ok('MILESTONE_IDS single-source id<->caseId mapping');
}

// 6) dhash64 as u64 via the single-source fingerprint helpers; hammingHex works off a ring-decoded frame; a REAL
//    dhash64FromRgba round-trips through the ring unchanged.
{
  const fpA = dhash64FromRgba(synthRgba(16, 16, 0), 16, 16);
  const fpB = dhash64FromRgba(synthRgba(16, 16, 90), 16, 16);
  assert.equal(dhashBitsToHex(dhashHexToBits(fpA)), fpA, 'dhash hex<->bits round-trips (single source)');
  const ring = createShortRing(MIN_CAPACITY_BYTES);
  const s = ring.state().headPublished;
  const e1 = writeCaptureFrame(ring, { timingTicks64: 1n, frameIndex: 0, dhashHex: fpA, caseId: 'MESH-OK', settled: true }).absoluteEndOffset;
  const e2 = writeCaptureFrame(ring, { timingTicks64: 2n, frameIndex: 1, dhashHex: fpB, caseId: 'MESH-OK', settled: true }).absoluteEndOffset;
  const [a, b] = readCaptureFrames(ring, s, e2);
  assert.equal(a.dhashHex, fpA, 'real dhash A survives the ring round-trip');
  assert.equal(b.dhashHex, fpB, 'real dhash B survives the ring round-trip');
  assert.equal(hammingHex(a.dhashHex, b.dhashHex), hammingHex(fpA, fpB), 'hammingHex off ring-decoded frames == direct');
  assert.equal(e1 <= e2, true, 'monotonic offsets');
  ok('dhash64 as u64 via single-source helpers; hammingHex works off ring-decoded frames');
}

// 7) DataView-LE survives UNALIGNED physical record offsets AND wrap. Capacity 4099 is NOT a multiple of
//    PACKET_BYTES (or of 8), so with gcd(24, 4099) == 1 the physical record start walks every residue —
//    hitting odd/non-8-aligned contiguous records (a subarray VIEW) and wrap-spanning records (a one-copy).
{
  const CAP = 4099;
  const ring = createShortRing(CAP);
  let sawUnaligned8 = false;
  let sawOdd = false;
  let sawWrap = false;
  let bigUintThrowProven = false;
  const N = 400; // 400 * 24 = 9600 bytes > 2 * CAP => guaranteed multiple wraps
  for (let k = 0; k < N; k += 1) {
    const frame = { timingTicks64: BigInt(k) * 100n + 7n, frameIndex: k, dhash64: (BigInt(k) << 40n) ^ 0x0123456789abn, milestoneId: (k % 4) + 1 };
    const w = writeCaptureFrame(ring, frame);
    const physStart = w.absoluteStartOffset % CAP;
    if (physStart % 8 !== 0) sawUnaligned8 = true;
    if (physStart % 2 === 1) sawOdd = true;
    if (w.wrapOccurred) sawWrap = true;
    // Read this single record back (before releasing it) and assert a full round-trip at this offset.
    const [d] = readCaptureFrames(ring, w.absoluteStartOffset, w.absoluteEndOffset);
    assert.equal(d.frameIndex, k, `frameIndex round-trips at physical offset ${physStart}`);
    assert.equal(d.timingTicks64, BigInt(k) * 100n + 7n, `timingTicks64 round-trips at physical offset ${physStart}`);
    assert.equal(d.dhash64, (BigInt(k) << 40n) ^ 0x0123456789abn, `dhash64 round-trips at physical offset ${physStart}`);
    assert.equal(d.milestoneId, (k % 4) + 1, 'milestoneId round-trips across the seam');
    // On the first ODD contiguous (view) record, prove the DataView necessity: a BigUint64Array at this
    // unaligned byteOffset THROWS, while the DataView the adapter uses reads it fine.
    if (!bigUintThrowProven && !w.wrapOccurred && physStart % 8 !== 0) {
      const slice = ring.copyAbsoluteRange(w.absoluteStartOffset, PACKET_BYTES); // subarray VIEW into the ring buffer
      assert.equal(slice.byteOffset % 8 !== 0, true, 'ring slice starts at a non-8-aligned physical offset');
      assert.throws(() => new BigUint64Array(slice.buffer, slice.byteOffset + OFFSETS.timingTicks64, 1), RangeError,
        'BigUint64Array THROWS at the unaligned record offset (the reason DataView access is mandatory)');
      const dv = new DataView(slice.buffer, slice.byteOffset, PACKET_BYTES);
      assert.doesNotThrow(() => dv.getBigUint64(OFFSETS.timingTicks64, true), 'DataView reads the u64 at the same unaligned offset');
      bigUintThrowProven = true;
    }
    ring.advanceTail(w.absoluteEndOffset); // steady SPSC consumption so the ring never overwrite-blocks
  }
  assert.equal(sawUnaligned8, true, 'exercised >= 1 non-8-aligned record start');
  assert.equal(sawOdd, true, 'exercised an odd (fully unaligned) record start');
  assert.equal(sawWrap, true, 'exercised a wrap-spanning (one-copy) record');
  assert.equal(bigUintThrowProven, true, 'proved BigUint64Array would throw where DataView succeeds');
  ok('DataView-LE survives unaligned physical offsets + wrap (BigUint64Array would throw)');
}

// 8) Fail-closed encode/decode/read invariants.
{
  assert.throws(() => encodeCaptureFrame({ timingTicks64: 1n }), /empty frame/, 'empty frame (no dhash, no milestone) rejected');
  assert.throws(() => encodeCaptureFrame({ timingTicks64: 1n, caseId: 'MESH-OK', milestoneId: 2 }), /disagrees with caseId/, 'milestoneId vs caseId disagreement rejected');
  assert.throws(() => encodeCaptureFrame({ timingTicks64: 1n, dhashHex: '0000000000000001', dhash64: 2n }), /dhashHex and dhash64 disagree/, 'dhashHex vs dhash64 disagreement rejected');
  assert.throws(() => encodeCaptureFrame({ timingTicks64: 1n, milestoneId: 1, frameIndex: 0x1_0000_0000 }), /frameIndex must be a u32/, 'frameIndex > u32 rejected');
  assert.throws(() => encodeCaptureFrame({ timingTicks64: 1n, milestoneId: 300 }), /milestoneId must be a u8/, 'milestoneId > u8 rejected');
  assert.throws(() => milestoneIdForCase('NOT-A-CASE'), /unknown milestone caseId/, 'unknown caseId rejected');
  // Unsupported packetVersion on decode (tamper the version byte).
  const tampered = encodeCaptureFrame({ timingTicks64: 1n, milestoneId: 4 });
  tampered[OFFSETS.packetVersion] = 2;
  assert.throws(() => decodeCaptureFrame(tampered), /unsupported packetVersion 2/, 'unsupported packetVersion rejected (fail closed, not misparsed)');
  // readCaptureFrames requires a whole number of records.
  const ring = createShortRing(MIN_CAPACITY_BYTES);
  writeCaptureFrame(ring, { timingTicks64: 1n, milestoneId: 4 });
  assert.throws(() => readCaptureFrames(ring, 0, 10), /not a whole number of 24-byte records/, 'non-record byte span rejected');
  ok('fail-closed encode/decode/read invariants');
}

// 9) The ring's own overwrite-blocked invariant surfaces through writeCaptureFrame (fail closed, no silent drop).
{
  const small = createShortRing(MIN_CAPACITY_BYTES); // 4096 bytes => floor(4096/24) = 170 records fit
  let written = 0;
  assert.throws(() => {
    for (;;) { writeCaptureFrame(small, { timingTicks64: BigInt(written), milestoneId: 4 }); written += 1; }
  }, /short-ring-overwrite-blocked/, 'writeCaptureFrame fails closed when the ring would overwrite unconsumed bytes');
  assert.equal(written, Math.floor(MIN_CAPACITY_BYTES / PACKET_BYTES), 'exactly floor(cap/24) records fit before the block');
  ok('overwrite-blocked invariant surfaces through writeCaptureFrame (no silent drop)');
}

// 10) settled flag semantics (bit0), independent of milestone.
{
  const on = decodeCaptureFrame(encodeCaptureFrame({ timingTicks64: 1n, dhash64: 0x5n, settled: true }));
  const off = decodeCaptureFrame(encodeCaptureFrame({ timingTicks64: 1n, dhash64: 0x5n, settled: false }));
  assert.equal(on.settled, true, 'settled:true sets flags bit0');
  assert.equal(on.flags & FLAG_SETTLED, FLAG_SETTLED, 'flags bit0 set');
  assert.equal(off.settled, false, 'settled:false clears flags bit0');
  assert.equal(off.flags & FLAG_SETTLED, 0, 'flags bit0 clear');
  ok('settled flag semantics (bit0)');
}

console.log(`\ncapture-ring verify: ${passed}/${passed} checks passed`);
