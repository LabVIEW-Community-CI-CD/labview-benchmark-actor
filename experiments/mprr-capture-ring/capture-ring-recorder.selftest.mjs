// Self-test for capture-ring-recorder.mjs. Writes a full capture sequence (BOOT-START, visual frames, the four
// milestone markers) into a REAL mprr ring, drains it, and reconstructs a boot-benchmark-v1 record — asserting
// guest-clock spans, per-milestone settled visual pins, a clean self-diff through bootBenchmarkDiff, AND the
// container milestone-only path (markers, no dhash -> spans only) from the SAME builder. Run: node <this file>.

import assert from 'node:assert/strict';
import { createShortRing, CLI_DEFAULT_CAPACITY_BYTES } from '../mprr-ring/mprrRing.mjs';
import { writeCaptureFrame } from './capture-ring.mjs';
import { recordFromRing } from './capture-ring-recorder.mjs';
import { bootBenchmarkDiff } from '../mprr-boot-benchmark/boot-benchmark-diff.mjs';

const MS = 10_000; // ticks per ms
let passed = 0;
const ok = (m) => { console.log(`  ok - ${m}`); passed += 1; };

// ---- 1) VM VISUAL ring: milestone markers + settled visual pins ----
const ring = createShortRing(CLI_DEFAULT_CAPACITY_BYTES);
const w = [];
const put = (f) => w.push(writeCaptureFrame(ring, f));
put({ timingTicks64: 0, frameIndex: 0, caseId: 'BOOT-START' });
put({ timingTicks64: 50 * MS, frameIndex: 1, dhashHex: '1111111111111111', settled: false });   // unsettled
put({ timingTicks64: 100 * MS, frameIndex: 2, caseId: 'LBABUS-BUILD-START' });
put({ timingTicks64: 100 * MS, frameIndex: 3, dhashHex: '2222222222222222', settled: true });
put({ timingTicks64: 5000 * MS, frameIndex: 4, dhashHex: '3333333333333333', settled: true });
put({ timingTicks64: 5000 * MS, frameIndex: 5, caseId: 'LBABUS-BUILT' });
put({ timingTicks64: 7000 * MS, frameIndex: 6, dhashHex: '4444444444444444', settled: true });
put({ timingTicks64: 7000 * MS, frameIndex: 7, caseId: 'MESH-OK' });

const rec = recordFromRing(ring, w[0].absoluteStartOffset, w.at(-1).absoluteEndOffset, { iteration: 'win-ring-test', plane: 'WIN', hypervisor: 'docker-wsl2' });
assert.equal(rec.schema, 'labview-benchmark-actor/boot-benchmark-v1');
const span = (id) => rec.spans.find((s) => s.id === id);
assert.equal(span('buildMs').ms, 4900); assert.equal(span('buildMs').scope, 'cross-plane'); assert.equal(span('buildMs').clock, 'guest');
assert.equal(span('meshFormMs').ms, 2000); assert.equal(span('meshFormMs').scope, 'cross-plane');
assert.equal(span('bootToMeshMs').ms, 7000); assert.equal(span('bootToMeshMs').scope, 'within-plane');
ok('spans buildMs=4900 + meshFormMs=2000 (guest, cross-plane) + bootToMeshMs=7000 (within-plane)');

const pin = (caseId) => rec.frames.find((f) => f.caseId === caseId);
assert.equal(pin('LBABUS-BUILT').perceptualFingerprint, '3333333333333333');
assert.equal(pin('MESH-OK').perceptualFingerprint, '4444444444444444');
assert.equal(pin('LBABUS-BUILD-START').perceptualFingerprint, '2222222222222222');
assert.ok(rec.frames.every((f) => f.settled === true));
ok('per-milestone SETTLED visual pins reconstructed (unsettled frame ignored)');

const self = bootBenchmarkDiff(rec, rec);
assert.equal(self.verdict, 'PASS');
assert.equal(self.timing.verdict, 'TIMING_OK');
ok('record feeds bootBenchmarkDiff -> self-diff PASS / TIMING_OK');

// ---- 2) CONTAINER milestone-only path: markers, NO visual — same builder ----
const ring2 = createShortRing(CLI_DEFAULT_CAPACITY_BYTES);
const w2 = [];
const put2 = (f) => w2.push(writeCaptureFrame(ring2, f));
put2({ timingTicks64: 0, caseId: 'BOOT-START' });
put2({ timingTicks64: 10 * MS, caseId: 'LBABUS-BUILD-START' });
put2({ timingTicks64: 3010 * MS, caseId: 'LBABUS-BUILT' });
put2({ timingTicks64: 5390 * MS, caseId: 'MESH-OK' });
const rec2 = recordFromRing(ring2, w2[0].absoluteStartOffset, w2.at(-1).absoluteEndOffset, { plane: 'WIN', substrate: 'docker-container' });
assert.equal(rec2.spans.find((s) => s.id === 'buildMs').ms, 3000);    // 3010 - 10
assert.equal(rec2.spans.find((s) => s.id === 'meshFormMs').ms, 2380); // 5390 - 3010
assert.equal(rec2.frames.length, 0);
assert.equal(rec2.visual.perMilestone.length, 0);
assert.equal(rec2.counts.visual, 0);
ok('container milestone-only path -> spans only, no visual pins (one builder, both paths)');

console.log(`\ncapture-ring-recorder self-test: ${passed}/4 PASS`);
