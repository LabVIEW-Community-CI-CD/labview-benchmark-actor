#!/usr/bin/env node
// Gate: mprr short-packet ring model has TEETH. Exercises the zero-copy ring (write/wrap/copy views), the
// block/boundary/admission authority, and the deterministic short-packet ingest projection. Exit 0 = pass.
//
// Run: node experiments/mprr-ring/verify-mprr-ring.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MPRR_RING_SCHEMA,
  DEFAULT_BLOCK_DURATION_TICKS,
  MIN_CAPACITY_BYTES,
  createShortRing,
  blockIdForTicks,
  boundaryVariationPct,
  requiredThreeBlockCapacityBytes,
  checkAdmission,
  ingestShortPackets,
} from './mprrRing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, pass: true });
  } catch (err) {
    checks.push({ name, pass: false, err: err.message });
  }
}
function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg || 'assertion failed');
  }
}

// 1. Ring: contiguous write + published state + zero-copy VIEW read.
check('ring-write-and-zero-copy-view', () => {
  const ring = createShortRing(MIN_CAPACITY_BYTES);
  const a = ring.write(Uint8Array.from([1, 2, 3, 4]));
  assert(a.absoluteStartOffset === 0 && a.absoluteEndOffset === 4 && !a.wrapOccurred, 'first write offsets');
  const b = ring.write(Uint8Array.from([5, 6]));
  assert(b.absoluteStartOffset === 4 && b.absoluteEndOffset === 6, 'second write offsets');
  const st = ring.state();
  assert(st.headPublished === 6 && st.tailConsumed === 0 && st.used === 6, 'published state');
  const view = ring.copyAbsoluteRange(0, 4);
  assert(view.length === 4 && view[0] === 1 && view[3] === 4, 'view bytes');
  // A contiguous read is a subarray VIEW over the ring's own buffer (zero-copy), not a fresh allocation.
  assert(view.buffer === ring.copyAbsoluteRange(4, 2).buffer, 'contiguous reads share the ring buffer (view)');
});

// 2. Ring: wrap-around write + reassembling wrap-spanning copy.
check('ring-wrap-and-copy', () => {
  const cap = MIN_CAPACITY_BYTES;
  const ring = createShortRing(cap);
  // Position the head near the physical end (consume as we go), so the next write crosses the wrap boundary.
  const filler = ring.write(new Uint8Array(cap - 100).fill(9));
  ring.advanceTail(filler.absoluteEndOffset);
  // Now a 200-byte write at physical offset (cap-100) crosses the wrap boundary.
  const spanning = Uint8Array.from(Array.from({ length: 200 }, (_, i) => i & 0xff));
  const w = ring.write(spanning);
  assert(w.wrapOccurred, 'expected wrap to occur');
  const got = ring.copyAbsoluteRange(w.absoluteStartOffset, 200);
  assert(got.length === 200 && got[0] === 0 && got[199] === (199 & 0xff), 'wrap-spanning copy reassembles');
});

// 3. Short-packet continuity is protected: an overwrite that would clobber unconsumed bytes fails closed.
check('ring-overwrite-fails-closed', () => {
  const ring = createShortRing(MIN_CAPACITY_BYTES);
  ring.write(new Uint8Array(MIN_CAPACITY_BYTES - 10)); // fill almost full, do NOT advance tail
  let threw = false;
  try {
    ring.write(new Uint8Array(50));
  } catch (err) {
    threw = err.message === 'short-ring-overwrite-blocked';
  }
  assert(threw, 'expected short-ring-overwrite-blocked');
});

// 4. blockId + boundary variation authority.
check('block-id-and-boundary-variation', () => {
  assert(blockIdForTicks(2_999_999n, 3_000_000n) === 0n, 'block 0 upper edge');
  assert(blockIdForTicks(3_000_000n, 3_000_000n) === 1n, 'block 1 lower edge');
  assert(blockIdForTicks(0) === 0n, 'default block duration, tick 0');
  assert(boundaryVariationPct(0, 3_000_000, 3_000_000) === 0, 'aligned boundary = 0 pct');
  const v = boundaryVariationPct(0, 3_333_332, 3_000_000);
  assert(Math.abs(v - 11.11106) < 0.001, `expected ~11.111 pct, got ${v}`);
});

// 5. Admission control fails closed when the ring cannot hold the worst 3-block horizon.
check('admission-control-fails-closed', () => {
  const req = requiredThreeBlockCapacityBytes([10_000, 20_000, 30_000, 5_000]);
  assert(req === Math.ceil(1.1 * 60_000), `required = ceil(1.1*60000), got ${req}`);
  assert(checkAdmission(MIN_CAPACITY_BYTES, [30_000, 30_000, 30_000]).outcome === 'admission-control-blocked',
    'too-small ring is blocked');
  assert(checkAdmission(70_000, [10_000, 10_000, 10_000]).admitted === true, 'ample ring is admitted');
});

// 6. Deterministic ingest of the fixture: byte-identical output twice, expected authoritative structure.
check('ingest-fixture-deterministic-and-authoritative', () => {
  const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'short-packet-run.json'), 'utf8'));
  const opts = { blockDurationTicks: fixture.blockDurationTicks, capacityBytes: fixture.capacityBytes };
  const a = ingestShortPackets(fixture.packets, opts);
  const b = ingestShortPackets(fixture.packets, opts);
  assert(JSON.stringify(a) === JSON.stringify(b), 'ingest is deterministic (byte-identical)');
  assert(a.schema === MPRR_RING_SCHEMA, 'schema');
  assert(a.series.length === fixture.packets.length, 'series covers every packet');
  assert(a.blockCount === 4, `expected 4 blocks, got ${a.blockCount}`);
  assert(a.worstBoundaryVariationPct === 0, `block-aligned run => 0 boundary variation, got ${a.worstBoundaryVariationPct}`);
  assert(a.authoritative === true, 'aligned + admitted => authoritative');
  assert(a.totalBytes === fixture.packets.reduce((s, p) => s + p.bytes, 0), 'totalBytes');
  assert(a.series[0].cumulativeBytes === fixture.packets[0].bytes, 'cumulative bytes start');
});

// 7. A jittered (misaligned) run is characterized as NON-authoritative (the gate has teeth both ways).
check('ingest-jittered-not-authoritative', () => {
  const packets = [];
  let t = 0;
  for (let i = 0; i < 12; i += 1) {
    packets.push({ timingTicks64: t, bytes: 100 });
    t += i % 2 === 0 ? 700_000 : 1_300_000; // jitter around the 1_000_000 cadence
  }
  const r = ingestShortPackets(packets, { blockDurationTicks: 3_000_000, capacityBytes: 58_000 });
  assert(r.worstBoundaryVariationPct > 5, `jitter should exceed 5 pct, got ${r.worstBoundaryVariationPct}`);
  assert(r.authoritative === false, 'jittered run is not authoritative');
});

// 8. Monotonicity is enforced (out-of-order short packets are rejected).
check('ingest-rejects-nonmonotonic', () => {
  let threw = false;
  try {
    ingestShortPackets([{ timingTicks64: 10, bytes: 4 }, { timingTicks64: 5, bytes: 4 }]);
  } catch (err) {
    threw = /not monotonic/.test(err.message);
  }
  assert(threw, 'expected non-monotonic rejection');
});

const passed = checks.filter((c) => c.pass).length;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.err ? `  -- ${c.err}` : ''}`);
}
console.log(`\n${passed}/${checks.length} mprr-ring checks passed`);
process.exit(passed === checks.length ? 0 : 1);
