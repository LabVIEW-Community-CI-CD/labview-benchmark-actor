// Self-test for winVmLadderRun.mjs -- proven on REAL data (no fakes): a REAL golden-box Win11 VM calibrated as a
// mesh actor. winMeshActorCapture.ps1 drove the running golden VM through busy=0..4 via VBoxManage guestcontrol,
// each an exact-12-FPS winPdhSampler capture (committed as fixtures/win-vm-ladder-b*.json); runWinVmLadder
// deterministically builds the per-rung signatures, fits the calibration curve, and inverse-reads every rung.
// This test RECOMPUTES from the committed real captures, so it runs OFFLINE in CI with no VM.
// Run: node winVmLadderRun.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { runWinVmLadder, WIN_VM_LADDER_SCHEMA } from './winVmLadderRun.mjs';

const r = runWinVmLadder();
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// --- a real Win11 VM, PDH-sampled at ~12 FPS through the ladder ---
{
  assert.equal(r.schema, WIN_VM_LADDER_SCHEMA);
  assert.equal(r.vm.plane, 'WIN', 'the actor is a Windows VM');
  assert.equal(r.ladder.levels.length, 5, 'five rungs idle -> saturate');
  for (const f of r.measuredFpsByRung) assert.ok(Math.abs(f.effectiveFps - 12) < 0.5, `${f.rung} sampled at ~12 FPS (${f.effectiveFps})`);
  ok(`golden VM ${r.vm.name} PDH-sampled through 5 rungs, all ~12 FPS (${r.measuredFpsByRung.map((f) => f.effectiveFps).join(', ')})`);
}

// --- the VM's own cpuTotalPct signature tracks the commanded rung monotonically ---
{
  const curve = r.cpuTotalPctMeanCurve;
  assert.equal(curve.length, 5, 'the cpuTotalPct.mean curve spans the ladder');
  for (let i = 1; i < curve.length; i += 1) assert.ok(curve[i].expected > curve[i - 1].expected, `cpuTotalPct climbs with the rung (${curve.map((c) => c.expected).join(',')})`);
  assert.ok(curve[0].expected < 20, 'idle sits low');
  assert.ok(curve[4].expected > 85, 'saturate drives the VM CPU high');
  ok(`VM cpuTotalPct calibration curve [${curve.map((c) => c.expected).join(', ')}]% tracks idle -> saturate`);
}

// --- the design invariants hold on the real VM signatures ---
{
  assert.equal(r.invariants.monotone, 1, 'every salient feature is monotone on the VM ladder');
  assert.equal(r.invariants.separable, true, 'adjacent rung bands are separable on the VM');
  assert.equal(r.invariants.repeatable, true, 'each rung retains stable signature features across repeats');
  assert.ok(r.salientDimensions.length > 0 && r.counterKeys.includes('cpuTotalPct'), 'the VM fit has salient dims incl cpuTotalPct');
  ok(`invariants on the REAL VM: monotone 100%, separable, repeatable, ${r.salientDimensions.length} salient dims`);
}

// --- every rung inverse-reads back to itself: the VM is a calibratable mesh actor ---
{
  assert.equal(r.perRungInverseRead.length, 5, 'all five rungs are inverse-read');
  for (const x of r.perRungInverseRead) assert.equal(x.inferredRung, x.rung, `${x.rung} inverse-reads back to itself`);
  assert.equal(r.allRungsRecovered, true, 'ALL rungs recovered -- the golden VM is a calibratable mesh actor');
  ok(`inverse read (real VM): ${r.perRungInverseRead.map((x) => `${x.rung}->${x.inferredRung}`).join(', ')} -- allRecovered`);
}

console.log(`\nwinVmLadderRun.selftest: ${passed}/${passed} checks passed (REAL golden-box Win11 VM)`);
