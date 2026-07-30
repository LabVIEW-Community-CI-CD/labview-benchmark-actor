// Self-test for workload-cross-plane.mjs — synthetic sealed workload records (no VM). Proves the cross-plane
// launch diff: the launch span is a WITNESS (a cross-hypervisor launch time carries substrate bias, so a large
// delta is REPORTED, never hard-failed), guest/cross-plane, WIN vs LINUX. Ready to swap in the real WIN + LINUX
// LabVIEW-launch records when they land. Run: node experiments/mprr-capture-ring/workload-cross-plane.selftest.mjs

import assert from 'node:assert/strict';
import { workloadCrossPlaneReceipt } from './workload-cross-plane.mjs';

/** A synthetic sealed workload record (boot-benchmark-v1 shape: a guest-clock launchMs span + a settle pin). */
function rec({ plane, hypervisor, launchMs, settleDhash = 'a1b2c3d4e5f60718' }) {
  return {
    schema: 'labview-benchmark-actor/boot-benchmark-v1',
    iteration: `${plane.toLowerCase()}-labview-launch`,
    plane,
    hypervisor,
    workload: 'labview-ide-launch',
    fingerprintAlgo: 'dhash-64',
    frames: [{ caseId: 'READY', counter: 0, settled: true, perceptualFingerprint: settleDhash, fingerprintAlgo: 'dhash-64' }],
    spans: [{ id: 'launchMs', ms: launchMs, clock: 'guest', scope: 'cross-plane' }],
  };
}

let passed = 0;
const ok = (m) => { console.log(`  ok - ${m}`); passed += 1; };

// 1) modest cross-plane launch delta -> PASS, launch witness within tolerance (status 'match').
{
  const r = workloadCrossPlaneReceipt(rec({ plane: 'WIN', hypervisor: 'vmware', launchMs: 8200 }), rec({ plane: 'LINUX', hypervisor: 'virtualbox', launchMs: 6100 }));
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.launchSpanId, 'launchMs');
  assert.equal(r.launch.witness, true);
  assert.equal(r.launch.msA, 6100); assert.equal(r.launch.msB, 8200); assert.equal(r.launch.deltaMs, 2100);
  assert.equal(r.launch.status, 'match');
  assert.equal(r.win.launchMs, 8200); assert.equal(r.linux.launchMs, 6100);
  ok('WIN vs LINUX launchMs diffed (LINUX 6100 -> WIN 8200, Δ2100) — witness within tolerance, PASS');
}

// 2) large cross-plane launch delta -> STILL PASS (witness, never gates) but REPORTED as a witness delta.
{
  const r = workloadCrossPlaneReceipt(rec({ plane: 'WIN', hypervisor: 'vmware', launchMs: 20000 }), rec({ plane: 'LINUX', hypervisor: 'virtualbox', launchMs: 6100 }));
  assert.equal(r.verdict, 'PASS', 'a big launch delta does NOT fail the gate (launch is a witness span)');
  assert.equal(r.launch.status, 'witness-regressed');
  assert.ok(r.timing.witnessDeltas.includes('launchMs'), 'the launch delta is reported as a witness delta');
  assert.equal(r.timing.regressed.length, 0, 'no GATED span regressed');
  ok('a large cross-hypervisor launch delta is REPORTED (witness-regressed) but never fails the gate');
}

console.log(`\nworkload-cross-plane self-test: ${passed}/2 PASS`);
