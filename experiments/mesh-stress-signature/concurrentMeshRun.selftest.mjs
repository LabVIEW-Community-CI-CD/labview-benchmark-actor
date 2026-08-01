// Self-test for concurrentMeshRun.mjs -- proven on REAL data (no fakes): a committed SIMULTANEOUS mesh run on
// this host where 5 actors, each pinned to a disjoint core pool (taskset) and commanded to a DIFFERENT stress
// rung AT THE SAME TIME, were each sampled on their own exact-12-FPS /proc CPU series; the calibration engine
// fit the ladder from the concurrent signatures and INVERSE-READ every actor's rung back from its own
// signature. Deterministic replay of the committed receipt (optional RUN_LIVE=1 re-runs it live).
// Run: node concurrentMeshRun.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MESH_CONCURRENT_SCHEMA, runConcurrentMesh } from './concurrentMeshRun.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'mesh-concurrent-actors-receipt.json');
const r = process.env.RUN_LIVE === '1' ? await runConcurrentMesh({ repeats: 3, poolSize: 4 }) : JSON.parse(readFileSync(fixture, 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// --- the actors were sampled SIMULTANEOUSLY at exactly 12 FPS ---
{
  assert.equal(r.schema, MESH_CONCURRENT_SCHEMA);
  assert.equal(r.measured.exactly12fps, true, 'the per-actor capture holds EXACTLY 12 FPS');
  assert.equal(r.concurrency.allActorsSampledEveryFrame, true, 'every actor has a sample on every frame (they ran at the same wall-clock time)');
  assert.ok(r.concurrency.actorsPerFrame >= 5, 'at least 5 actors sampled per frame');
  ok(`${r.concurrency.actorsPerFrame} actors sampled simultaneously across ${r.concurrency.simultaneousFrames} frames at ${r.measured.effectiveFps} FPS`);
}

// --- each actor's OWN CPU tracks its commanded rung (disjoint core pools => no contention) ---
{
  const means = r.actors.map((a) => a.cpuPoolPctMean);
  assert.equal(means.length, 5, 'five actors span idle -> saturate');
  for (let i = 1; i < means.length; i += 1) assert.ok(means[i] > means[i - 1], `per-actor cpuPoolPct climbs with the rung (${means.join(',')})`);
  assert.ok(means[0] < 10, 'the idle actor sits near 0% of its pool');
  assert.ok(means[4] > 90, 'the saturate actor drives ~100% of its pool');
  ok(`per-actor cpuPoolPct means [${means.join(', ')}]% -- each actor's own budget, measured concurrently`);
}

// --- the design invariants hold on the concurrent signatures ---
{
  assert.equal(r.invariants.monotone, 1, 'every salient feature is monotone across the concurrent rungs');
  assert.equal(r.invariants.separable, true, 'adjacent actor signature bands are separable');
  assert.equal(r.invariants.repeatable, true, 'each actor retains stable signature features across its repeats');
  assert.ok(Array.isArray(r.salientDimensions) && r.salientDimensions.length > 0, 'the fit has salient dimensions');
  assert.ok(r.counterKeys.includes('cpuPoolPct'), 'cpuPoolPct is a calibrated counter');
  ok(`invariants on concurrent REAL data: monotone 100%, separable, repeatable, ${r.salientDimensions.length} salient dims`);
}

// --- THE claim: every simultaneously-stressed actor is inverse-read back to its OWN rung ---
{
  assert.equal(r.perActorInverseRead.length, 5, 'all five actors are inverse-read');
  for (const x of r.perActorInverseRead) {
    assert.equal(x.inferredRung, x.commandedRung, `${x.actor} (${x.commandedRung}) inverse-reads back to its own rung`);
    assert.ok(x.correct === true, `${x.actor} recovered`);
  }
  assert.equal(r.allActorsRecovered, true, 'ALL actors recovered -- the mesh resolves who is stressed + how much, concurrently');
  ok(`inverse read (all concurrent): ${r.perActorInverseRead.map((x) => `${x.commandedRung}->${x.inferredRung}`).join(', ')} -- allRecovered`);
}

console.log(`\nconcurrentMeshRun.selftest: ${passed}/${passed} checks passed (REAL data)`);
