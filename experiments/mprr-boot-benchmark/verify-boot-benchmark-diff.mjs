// verify-boot-benchmark-diff.mjs — CI proof of the WIN cross-iteration boot-benchmark diff (no VM).
//
// Asserts the two layers: the TIMING hard gate (guest-clock spans compared; the host-clock within-plane span
// REFUSED across hypervisors), and the VISUAL witness (per-milestone Hamming tolerance, not gated by default).
//
//   node experiments/mprr-boot-benchmark/verify-boot-benchmark-diff.mjs

import assert from 'node:assert/strict';
import { bootBenchmarkDiff } from './boot-benchmark-diff.mjs';
import { FINGERPRINT_ALGO, FINGERPRINT_SPEC_VERSION } from '../manual-procedure-record/fingerprint.mjs';

let passed = 0;
function ok(label) { passed += 1; console.log(`  ok  ${label}`); }

const ALL0 = '0000000000000000';
const FIVE = '000000000000001f'; // 5 bits set -> Hamming 5 vs ALL0
const ALLF = 'ffffffffffffffff'; // 64 bits set -> Hamming 64 vs ALL0
const MILES = ['BOOT-START', 'LBABUS-BUILD-START', 'LBABUS-BUILT', 'MESH-OK'];

function makeRecord(o = {}) {
  const fps = o.fingerprints ?? {};
  const frames = MILES.map((caseId, i) => ({
    index: i, hostMonotonicMs: 1000 + i * 1000, settled: true, caseId,
    perceptualFingerprint: fps[caseId] ?? ALL0, integrityHash: 'a'.repeat(64),
  }));
  let spans = [
    { id: 'buildMs', from: 'LBABUS-BUILD-START', to: 'LBABUS-BUILT', clock: 'guest', scope: 'cross-plane', ms: o.buildMs ?? 8000 },
    { id: 'meshFormMs', from: 'LBABUS-BUILT', to: 'MESH-OK', clock: 'guest', scope: 'cross-plane', ms: o.meshFormMs ?? 1000 },
    { id: 'bootToMeshMs', from: 'hostT0', to: 'MESH-OK', clock: 'host', scope: 'within-plane', ms: o.bootToMeshMs ?? 20000 },
  ];
  if (o.dropSpan) spans = spans.filter((s) => s.id !== o.dropSpan);
  return {
    schema: 'labview-benchmark-actor/boot-benchmark-v1',
    iteration: o.iteration ?? 'v1',
    hypervisor: o.hypervisor ?? 'vmware',
    fingerprintAlgo: o.fingerprintAlgo ?? FINGERPRINT_ALGO,
    fingerprintSpecVersion: FINGERPRINT_SPEC_VERSION,
    frames,
    spans,
    visual: {
      gated: o.gated ?? false,
      perMilestone: MILES.map((caseId) => ({ caseId, hammingTolerance: (o.tolerances?.[caseId]) ?? 8, roiMask: o.roiMask?.[caseId] ?? null })),
    },
  };
}

console.log('timing hard gate');
{
  const d = bootBenchmarkDiff(makeRecord({ iteration: 'v1' }), makeRecord({ iteration: 'v2' }));
  assert.equal(d.verdict, 'PASS'); assert.equal(d.timing.verdict, 'TIMING_OK'); ok('identical spans -> PASS / TIMING_OK');
  assert.equal(d.visual.verdict, 'WITNESS_MATCH'); ok('identical frames -> WITNESS_MATCH');
  assert.equal(d.crossPlane, false); ok('same hypervisor -> crossPlane=false');

  const reg = bootBenchmarkDiff(makeRecord({ buildMs: 8000 }), makeRecord({ buildMs: 12000 }));
  assert.equal(reg.verdict, 'REGRESSION'); assert.equal(reg.timing.verdict, 'TIMING_REGRESSION'); ok('buildMs 8000->12000 -> REGRESSION');
  assert.deepEqual(reg.timing.regressed, ['buildMs']); ok('regressed span identified (buildMs)');
  assert.equal(reg.timing.spans.find((s) => s.id === 'buildMs').deltaMs, 4000); ok('signed deltaMs surfaced (+4000)');

  const small = bootBenchmarkDiff(makeRecord({ buildMs: 8000 }), makeRecord({ buildMs: 9500 }));
  assert.equal(small.verdict, 'PASS'); ok('within-tolerance drift (1500ms < 2000) -> PASS');

  const imp = bootBenchmarkDiff(makeRecord({ buildMs: 8000 }), makeRecord({ buildMs: 4000 }));
  assert.equal(imp.verdict, 'PASS'); assert.deepEqual(imp.timing.improved, ['buildMs']); ok('improvement (8000->4000) surfaced, does NOT fail the gate');

  const tight = bootBenchmarkDiff(makeRecord({ buildMs: 8000 }), makeRecord({ buildMs: 8800 }), { timingToleranceMs: 500 });
  assert.equal(tight.verdict, 'REGRESSION'); ok('custom tighter tolerance (500ms) catches an 800ms regression');
}

console.log('cross-plane scope refusal (the key rule)');
{
  // A=VBox, B=VMware. bootToMeshMs (host/within-plane) differs wildly but MUST be refused, not gated.
  const d = bootBenchmarkDiff(
    makeRecord({ hypervisor: 'virtualbox', bootToMeshMs: 20000, buildMs: 8000 }),
    makeRecord({ hypervisor: 'vmware', bootToMeshMs: 35000, buildMs: 8000 }),
  );
  assert.equal(d.crossPlane, true); ok('different hypervisors -> crossPlane=true');
  const btm = d.timing.spans.find((s) => s.id === 'bootToMeshMs');
  assert.equal(btm.status, 'incomparable-cross-plane'); ok('bootToMeshMs (within-plane) -> incomparable-cross-plane');
  assert.deepEqual(d.timing.incomparable, ['bootToMeshMs']); ok('incomparable list carries the within-plane span');
  assert.ok(!d.timing.regressed.includes('bootToMeshMs')); ok('a 15s host-span gap does NOT fail the cross-plane gate');
  assert.equal(d.verdict, 'PASS'); ok('cross-plane guest spans equal -> PASS (firmware span refused)');

  // but a guest-clock (cross-plane) regression across hypervisors STILL fails
  const gr = bootBenchmarkDiff(
    makeRecord({ hypervisor: 'virtualbox', buildMs: 8000 }),
    makeRecord({ hypervisor: 'vmware', buildMs: 13000 }),
  );
  assert.equal(gr.verdict, 'REGRESSION'); assert.deepEqual(gr.timing.regressed, ['buildMs']); ok('cross-plane buildMs regression still gates (guest clock is comparable)');
}

console.log('visual witness (not gated by default) + per-milestone tolerance');
{
  const d = bootBenchmarkDiff(makeRecord({}), makeRecord({ fingerprints: { 'MESH-OK': ALLF } }));
  assert.equal(d.visual.verdict, 'WITNESS_DELTA'); assert.deepEqual(d.visual.deltas, ['MESH-OK']); ok('MESH-OK Hamming 64 > tol -> witness-delta');
  assert.equal(d.verdict, 'PASS'); ok('visual delta with gated=false does NOT fail the gate (timing is the gate)');

  // per-milestone tolerance: 5-bit delta passes tol=8 but fails tol=2
  const permissive = bootBenchmarkDiff(makeRecord({}), makeRecord({ fingerprints: { 'MESH-OK': FIVE }, tolerances: { 'MESH-OK': 8 } }));
  assert.equal(permissive.visual.perMilestone.find((p) => p.caseId === 'MESH-OK').status, 'witness-match'); ok('5-bit delta <= tol 8 -> witness-match');
  const strict = bootBenchmarkDiff(makeRecord({}), makeRecord({ fingerprints: { 'MESH-OK': FIVE }, tolerances: { 'MESH-OK': 2 } }));
  assert.equal(strict.visual.perMilestone.find((p) => p.caseId === 'MESH-OK').status, 'witness-delta'); ok('5-bit delta > tol 2 -> witness-delta (per-milestone tolerance honored)');

  // visual.gated=true makes the witness bite
  const gated = bootBenchmarkDiff(makeRecord({ gated: true }), makeRecord({ gated: true, fingerprints: { 'MESH-OK': ALLF } }));
  assert.equal(gated.verdict, 'REGRESSION'); ok('visual.gated=true + witness-delta + timing OK -> REGRESSION');

  // roiMask declared -> surfaced (cannot be applied post-seal; raw discarded)
  const roi = bootBenchmarkDiff(makeRecord({}), makeRecord({ roiMask: { 'MESH-OK': { x: 0, y: 0, w: 8, h: 8 } } }));
  assert.match(roi.visual.note ?? '', /roiMask is declared/); ok('declared roiMask surfaced as seal-time-only (whole-frame witness)');
  assert.equal(roi.visual.perMilestone.find((p) => p.caseId === 'MESH-OK').roiMaskDeclared, true); ok('roiMaskDeclared flagged per milestone');
}

console.log('fail-closed guards');
{
  const missing = bootBenchmarkDiff(makeRecord({}), makeRecord({ dropSpan: 'meshFormMs' }));
  assert.equal(missing.timing.verdict, 'TIMING_REGRESSION'); assert.deepEqual(missing.timing.structural, ['meshFormMs']); ok('a vanished span fails the timing gate (structural)');

  assert.throws(() => bootBenchmarkDiff(makeRecord({}), { schema: 'not-a-boot-record' }), /not a labview-benchmark-actor\/boot-benchmark-v1/); ok('non-boot record -> throws');
  assert.throws(() => bootBenchmarkDiff(makeRecord({}), makeRecord({ fingerprintAlgo: 'phash-not-real' })), /fingerprintAlgo/); ok('fingerprintAlgo mismatch -> throws (reuses frame-diff guard)');
}

console.log(`\nboot-benchmark diff verify: ${passed}/${passed} checks passed`);
