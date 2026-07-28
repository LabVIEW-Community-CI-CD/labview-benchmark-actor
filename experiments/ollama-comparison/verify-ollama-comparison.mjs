#!/usr/bin/env node
// Deterministic self-test for the ollama-comparison core (LBA-REQ-010 AC #3, T-010). Dependency-free, no
// GPU / no live ollama -- the ollama driver is a deterministic MOCK. Proves: plan determinism, same-actor
// pairing scope (no cross-VM comparison), the output contract, and the comms-only invariant (the driver
// only ever sees run-derived prompts, never bus traffic). Writes a re-runnable receipt.json.
//
// Usage: node experiments/ollama-comparison/verify-ollama-comparison.mjs [--json]
// Exit 0 when every check passes, 1 otherwise.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { concentrate } from '../host-concentration/hostConcentration.mjs';
import { SCHEMA, buildComparisonPlan, compareOverCorpus } from './ollamaComparison.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.slice(2).includes('--json');

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
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

// A concentrated corpus with one multi-run actor (vm-a: r1, r2) and one single-run actor (vm-b: r1), so the
// pairing scope + single-run-no-comparison behaviour is exercised.
const CORPUS = concentrate(
  [
    { actorId: 'vm-a', runs: [
      { runId: 'r1', metricsRef: 'a/r1/metrics.tdms', framesRef: 'a/r1/frames' },
      { runId: 'r2', metricsRef: 'a/r2/metrics.tdms', framesRef: 'a/r2/frames' },
    ] },
    { actorId: 'vm-b', runs: [
      { runId: 'r1', metricsRef: 'b/r1/metrics.tdms', framesRef: 'b/r1/frames' },
    ] },
  ],
  { concentratedAt: '2026-07-28T11:00:00.000Z' }
);

// A deterministic mock ollama driver: records every prompt it is handed and returns a canned verdict.
const seenPrompts = [];
const mockDrive = (prompt) => {
  seenPrompts.push(prompt);
  return { model: 'mock', summary: 'no-regression', ok: true };
};

await check('plan-determinism', () => {
  const p1 = buildComparisonPlan(CORPUS);
  const p2 = buildComparisonPlan(CORPUS);
  assert(JSON.stringify(p1) === JSON.stringify(p2), 'same corpus must yield an identical plan');
  assert(p1.comparisonCount === 1, `expected 1 comparison (vm-a r1->r2), got ${p1.comparisonCount}`);
  return { comparisonCount: p1.comparisonCount };
});

await check('same-actor-pairing-no-cross-vm', () => {
  const plan = buildComparisonPlan(CORPUS);
  const only = plan.comparisons[0];
  assert(
    only.actorId === 'vm-a' && only.baselineRunId === 'r1' && only.candidateRunId === 'r2',
    'the sole pair must be vm-a r1->r2 (consecutive same-actor runs)'
  );
  assert(!plan.comparisons.some((c) => c.actorId === 'vm-b'), 'a single-run actor yields no comparison');
  return { pairs: plan.comparisons.map((c) => `${c.actorId}:${c.baselineRunId}->${c.candidateRunId}`) };
});

await check('output-contract', async () => {
  seenPrompts.length = 0;
  const out = await compareOverCorpus(CORPUS, mockDrive);
  assert(out.schema === SCHEMA, 'result must carry the schema');
  assert(out.comparisonCount === 1 && out.results.length === 1, 'exactly one comparison executed');
  const r = out.results[0];
  assert(
    r.actorId === 'vm-a' && r.baselineRunId === 'r1' && r.candidateRunId === 'r2',
    'result must identify the compared runs'
  );
  assert(r.verdict && r.verdict.ok === true, 'result must carry the driver verdict');
  return { comparisonCount: out.comparisonCount };
});

await check('comms-only-driver-sees-run-data-only', async () => {
  seenPrompts.length = 0;
  await compareOverCorpus(CORPUS, mockDrive);
  assert(seenPrompts.length === 1, 'the driver must be handed exactly one prompt');
  const busMarkers = ['vihs-collab-msg', 'ackOf', 'senderId'];
  for (const prompt of seenPrompts) {
    assert(typeof prompt === 'string' && prompt.includes('actor vm-a'), 'prompt must be derived from run data');
    assert(!busMarkers.some((m) => prompt.includes(m)), 'no coordination-bus field may reach the ollama driver');
  }
  return { prompts: seenPrompts.length };
});

const total = results.length;
const passed = results.filter((r) => r.pass).length;
const failed = total - passed;
const receipt = {
  schemaVersion: 'labview-benchmark-actor/ollama-comparison-receipt-v1',
  total,
  passed,
  failed,
  plan: buildComparisonPlan(CORPUS),
  results,
};
writeFileSync(join(here, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);

if (asJson) {
  console.log(JSON.stringify(receipt, null, 2));
} else {
  console.log(`ollama-comparison: ${passed}/${total} checks passed (LBA-REQ-010 AC #3 core)`);
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ' -- ' + r.error}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
