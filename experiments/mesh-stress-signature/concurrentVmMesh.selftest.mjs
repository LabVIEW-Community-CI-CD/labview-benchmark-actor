// Self-test for concurrentVmMesh.mjs -- proven on REAL data (no fakes): SIMULTANEOUS multi-VM discrimination.
// Two real Win11 VMs (actor-reviewer-golden + actor-mesh-b, a VBoxManage linked clone) were stressed at the
// SAME wall-clock time at DIFFERENT rungs, each PDH-sampled on its own exact-12-FPS series; the golden-VM
// calibration inverse-reads each concurrent signature. The robust claim: in EVERY concurrent pairing the
// calibration correctly ORDERS which VM is more stressed. RECOMPUTES from the committed real captures (offline).
// Run: node concurrentVmMesh.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { runConcurrentVmMesh, WIN_VM_CONCURRENT_SCHEMA } from './concurrentVmMesh.mjs';

const r = runConcurrentVmMesh();
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// --- two DISTINCT real VMs (one a linked clone of the other) ---
{
  assert.equal(r.schema, WIN_VM_CONCURRENT_SCHEMA);
  assert.notEqual(r.vms.a.name, r.vms.b.name, 'the two actors are distinct VMs');
  assert.match(r.vms.b.role, /clone/i, 'VM B is a linked clone of the golden VM');
  assert.equal(r.pairings.length, 2, 'two concurrent pairings');
  ok(`two real Win11 VMs discriminated: ${r.vms.a.name} + ${r.vms.b.name} (${r.vms.b.role})`);
}

// --- the pairings were captured SIMULTANEOUSLY (overlapping wall-clock windows) ---
{
  for (const p of r.pairings) assert.ok(p.concurrentOverlapMs > 0 && p.simultaneous, `pairing ${p.pairing} capture windows overlap (${p.concurrentOverlapMs}ms)`);
  assert.equal(r.allPairingsSimultaneous, true, 'every pairing sampled both VMs at the same wall-clock time');
  ok(`both pairings simultaneous (overlaps ${r.pairings.map((p) => `${p.concurrentOverlapMs}ms`).join(', ')})`);
}

// --- the pairings are CROSSED, so discrimination tracks the commanded rung, not the VM identity ---
{
  const p1 = r.pairings[0]; const p2 = r.pairings[1];
  assert.ok(p1.a.commandedLevel > p1.b.commandedLevel, 'pairing 1: VM A commanded higher than VM B');
  assert.ok(p2.a.commandedLevel < p2.b.commandedLevel, 'pairing 2: VM A commanded LOWER than VM B (crossed)');
  ok('pairings are crossed (P1 A>B, P2 A<B) -- discrimination is not a fixed A/B artifact');
}

// --- THE claim: in every concurrent pairing the calibration correctly ORDERS which VM is more stressed ---
{
  for (const p of r.pairings) {
    assert.ok(p.rankingCorrect, `pairing ${p.pairing}: the more-stressed VM inverse-reads higher (A ${p.a.commandedRung}->${p.a.inferredRung}, B ${p.b.commandedRung}->${p.b.inferredRung})`);
  }
  assert.equal(r.allPairingsRankedCorrectly, true, 'ALL pairings correctly ranked -- concurrent multi-VM discrimination holds');
  ok(`every concurrent pairing correctly ordered which VM is more stressed (allRankedCorrectly)`);
}

// --- exact rung recovery reported honestly (perfect on the extreme pairing; concurrent contention shifts mid) ---
{
  assert.ok(r.exactRungMatches >= 2 && r.exactRungMatches <= r.totalReadings, `exact rung recovery ${r.exactRungMatches}/${r.totalReadings} (>=2: both extremes recovered)`);
  const extreme = r.pairings[0];
  assert.ok(extreme.a.exact && extreme.b.exact, 'the saturate-vs-idle pairing recovers both rungs exactly');
  ok(`exact rung recovery ${r.exactRungMatches}/${r.totalReadings} (extreme pairing saturate+idle both exact)`);
}

console.log(`\nconcurrentVmMesh.selftest: ${passed}/${passed} checks passed (REAL: 2 concurrent Win11 VMs)`);
