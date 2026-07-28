#!/usr/bin/env node
// Deterministic self-test for the corpus-manifest ingestion contract (LBA-REQ-010, T-010). Dependency-free,
// no GPU / no live ollama. Proves the run-topology.ps1 -> host-concentration BOUNDARY is robust: it reads
// the sample manifest fixture (the exact shape WIN emits from the 2 golden-box VMs), concentrates it while
// preserving strict per-actor isolation, builds the same-actor-only ollama comparison plan over it, and
// REJECTS malformed manifests with clear, entry-scoped messages (the validation has teeth). Writes a
// re-runnable corpus-ingestion-receipt.json.
//
// Usage: node experiments/host-concentration/verify-corpus-ingestion.mjs [--json]
// Exit 0 when every check passes, 1 otherwise.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MANIFEST_SCHEMA,
  normalizeManifest,
  ingestFile,
  concentrateManifest,
} from './ingestCorpusManifest.mjs';
import { reviewOwnRuns } from './hostConcentration.mjs';
import { buildComparisonPlan } from '../ollama-comparison/ollamaComparison.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.slice(2).includes('--json');
const fixture = join(here, 'fixtures', 'sample-corpus-manifest.json');

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

// 1: the sample manifest FILE ingests + concentrates into a per-actor-isolated corpus (2 actors, 4 runs).
check('sample-manifest-file-ingests-preserving-isolation', () => {
  const corpus = concentrateManifest(fixture, { concentratedAt: '2026-07-28T12:00:00.000Z' });
  assert(corpus.actors.length === 2, `expected 2 actors, got ${corpus.actors.length}`);
  assert(corpus.runCount === 4, `expected 4 runs, got ${corpus.runCount}`);
  for (const actorId of corpus.actors) {
    const own = reviewOwnRuns(corpus, actorId);
    assert(own.length === 2, `actor ${actorId} should own 2 runs, got ${own.length}`);
    assert(own.every((r) => r.actorId === actorId), `actor ${actorId} review leaked another actor's run`);
  }
  return { actors: corpus.actors.length, runs: corpus.runCount, digest: corpus.corpusDigest };
});

// 2: the ingested corpus drives a same-actor-only ollama comparison plan (no cross-VM pairing).
check('ingested-corpus-yields-same-actor-comparison-pairs', () => {
  const corpus = concentrateManifest(fixture, { concentratedAt: '2026-07-28T12:00:00.000Z' });
  const plan = buildComparisonPlan(corpus);
  assert(plan.comparisonCount === 2, `expected 2 comparisons (1 per 2-run actor), got ${plan.comparisonCount}`);
  assert(plan.comparisons.every((c) => c.baselineRunId !== c.candidateRunId), 'a comparison paired a run with itself');
  assert(
    plan.comparisons.every((c) => corpus.actors.includes(c.actorId)),
    'every comparison must be scoped to a known actor (isolation)'
  );
  return { comparisons: plan.comparisonCount };
});

// 3: a bare-array manifest (no envelope) normalizes identically to the { corpora: [...] } envelope form.
check('bare-array-manifest-normalizes-like-the-envelope', () => {
  const bare = [{ actorId: 'a', runs: [{ runId: 'r1' }, { runId: 'r2' }] }];
  const corpora = normalizeManifest(bare);
  assert(corpora.length === 1 && corpora[0].actorId === 'a', 'bare array did not pass through');
  return { corpora: corpora.length };
});

// 4 (teeth): a manifest whose run has no runId is REJECTED with a runId-naming message.
check('malformed-manifest-missing-runId-is-rejected', () => {
  let threw = null;
  try {
    normalizeManifest([{ actorId: 'a', runs: [{ completedAt: 'x' }] }]);
  } catch (e) {
    threw = e;
  }
  assert(threw, 'a run with no runId must be rejected');
  assert(/runId/.test(threw.message), `error must name the missing runId, got: ${threw && threw.message}`);
  return { rejected: true };
});

// 5 (teeth): a non-manifest object (no corpora array) is REJECTED.
check('non-manifest-object-is-rejected', () => {
  let threw = null;
  try {
    normalizeManifest({ nope: true });
  } catch (e) {
    threw = e;
  }
  assert(threw, 'an object without a corpora array must be rejected');
  return { rejected: true };
});

// 6: ingestFile surfaces a read/parse failure with the offending path (operator diagnosability).
check('missing-manifest-file-fails-with-the-path', () => {
  let threw = null;
  try {
    ingestFile(join(here, 'fixtures', 'does-not-exist.json'));
  } catch (e) {
    threw = e;
  }
  assert(threw, 'a missing manifest file must throw');
  assert(/does-not-exist\.json/.test(threw.message), 'error must name the offending path');
  return { rejected: true };
});

const total = results.length;
const passed = results.filter((r) => r.pass).length;
const failed = total - passed;
const corpus = concentrateManifest(fixture, { concentratedAt: '2026-07-28T12:00:00.000Z' });
const plan = buildComparisonPlan(corpus);
const receipt = {
  schemaVersion: 'labview-benchmark-actor/corpus-ingestion-receipt-v1',
  manifestSchema: MANIFEST_SCHEMA,
  total,
  passed,
  failed,
  concentrated: { actors: corpus.actors.length, runCount: corpus.runCount, comparisonCount: plan.comparisonCount },
  results,
};
writeFileSync(join(here, 'corpus-ingestion-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);

if (asJson) {
  console.log(JSON.stringify(receipt, null, 2));
} else {
  console.log(`corpus-ingestion: ${passed}/${total} checks passed (LBA-REQ-010 boundary)`);
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ' -- ' + r.error}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
