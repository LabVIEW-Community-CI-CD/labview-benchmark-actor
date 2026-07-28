#!/usr/bin/env node
// Deterministic self-test for the host-concentration core (LBA-REQ-010, T-010). Dependency-free, no GPU /
// no live ollama. Proves: deterministic concentration, strict per-actor isolation (own-run review with no
// cross-VM leakage), the comms-only invariant (a bus-shaped input is rejected), and the ollama-comparison
// input contract shape. Writes a re-runnable receipt.json.
//
// Usage: node experiments/host-concentration/verify-host-concentration.mjs [--json]
// Exit 0 when every check passes, 1 otherwise.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SCHEMA, concentrate, reviewOwnRuns } from './hostConcentration.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.slice(2).includes('--json');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, pass: true, detail: detail ?? null });
  } catch (e) {
    results.push({ name, pass: false, error: String(e && e.message ? e.message : e) });
  }
}
function assert(c, m) {
  if (!c) {
    throw new Error(m);
  }
}

// Canonical two-actor corpora: each actor's OWN completed runs (VM-local run data), deliberately
// unsorted so the deterministic-ordering assertion is meaningful.
const CORPORA = [
  { actorId: 'vm-a', runs: [
    { runId: 'r2', completedAt: '2026-07-28T10:00:02Z', metricsRef: 'a/r2/metrics.tdms', framesRef: 'a/r2/frames' },
    { runId: 'r1', completedAt: '2026-07-28T10:00:01Z', metricsRef: 'a/r1/metrics.tdms', framesRef: 'a/r1/frames' },
  ] },
  { actorId: 'vm-b', runs: [
    { runId: 'r1', completedAt: '2026-07-28T10:00:03Z', metricsRef: 'b/r1/metrics.tdms', framesRef: 'b/r1/frames' },
  ] },
];
const FIXED_AT = '2026-07-28T11:00:00.000Z';

check('deterministic-concentration', () => {
  const c1 = concentrate(CORPORA, { concentratedAt: FIXED_AT });
  const c2 = concentrate(CORPORA, { concentratedAt: FIXED_AT });
  assert(c1.corpusDigest === c2.corpusDigest, 'same inputs must yield the same corpusDigest');
  assert(c1.runCount === 3, `expected 3 runs, got ${c1.runCount}`);
  assert(
    c1.runs.map((r) => `${r.actorId}/${r.runId}`).join(',') === 'vm-a/r1,vm-a/r2,vm-b/r1',
    'runs must be deterministically ordered by (actorId, runId)'
  );
  return { corpusDigest: c1.corpusDigest, runCount: c1.runCount };
});

check('per-actor-isolation-own-run-review', () => {
  const c = concentrate(CORPORA, { concentratedAt: FIXED_AT });
  const a = reviewOwnRuns(c, 'vm-a');
  const b = reviewOwnRuns(c, 'vm-b');
  assert(a.length === 2 && a.every((r) => r.actorId === 'vm-a'), 'vm-a must review exactly its own 2 runs');
  assert(b.length === 1 && b.every((r) => r.actorId === 'vm-b'), 'vm-b must review exactly its own 1 run');
  assert(
    !a.some((r) => r.actorId === 'vm-b') && !b.some((r) => r.actorId === 'vm-a'),
    'no cross-VM run leakage between actors'
  );
  return { vmA: a.length, vmB: b.length };
});

check('comms-only-invariant-rejects-bus-input', () => {
  // A bus-shaped envelope must NEVER be concentrated as run data (the bus is not a run-data channel).
  const busShaped = [{ actorId: 'vm-a', runs: [{ runId: 'r1', schema: 'vihs-collab-msg@v1', type: 'DONE', ackOf: 7 }] }];
  let threw = false;
  try {
    concentrate(busShaped);
  } catch {
    threw = true;
  }
  assert(threw, 'a bus-shaped corpus must be rejected (run data only, never bus traffic)');
  return { rejected: true };
});

check('rejects-duplicate-actor-concentration', () => {
  let threw = false;
  try {
    concentrate([
      { actorId: 'vm-a', runs: [{ runId: 'r1' }] },
      { actorId: 'vm-a', runs: [{ runId: 'r2' }] },
    ]);
  } catch {
    threw = true;
  }
  assert(threw, 'duplicate actorId must be rejected (each actor concentrates once)');
  return { rejected: true };
});

check('ollama-comparison-input-contract', () => {
  const c = concentrate(CORPORA, { concentratedAt: FIXED_AT });
  assert(c.schema === SCHEMA, 'corpus must carry the schema the host ollama layer keys on');
  assert(typeof c.corpusDigest === 'string' && /^[0-9a-f]{8}$/.test(c.corpusDigest), 'corpusDigest must be 8 hex chars');
  assert(
    c.runs.every((r) => 'actorId' in r && 'metricsRef' in r && 'framesRef' in r),
    'each run must expose actorId + metricsRef + framesRef for the ollama comparison layer'
  );
  return { schema: c.schema, actors: c.actors };
});

const total = results.length;
const passed = results.filter((r) => r.pass).length;
const failed = total - passed;
const receipt = {
  schemaVersion: 'labview-benchmark-actor/host-concentration-receipt-v1',
  total,
  passed,
  failed,
  corpus: concentrate(CORPORA, { concentratedAt: FIXED_AT }),
  results,
};
writeFileSync(join(here, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);

if (asJson) {
  console.log(JSON.stringify(receipt, null, 2));
} else {
  console.log(`host-concentration: ${passed}/${total} checks passed (LBA-REQ-010 core)`);
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ' -- ' + r.error}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
