#!/usr/bin/env node
// Deterministic self-test for the REAL-corpus wiring (LBA-REQ-010, T-010). Dependency-free, no GPU / no live
// ollama. It proves the host-side pipeline that drive-real-corpus.mjs runs live is correctly wired end-to-end
// WITHOUT an LLM: ingest the complete-corpus manifest FILE -> concentrate (per-actor isolation) ->
// dereference each run's VM-local metrics file into a real metric summary -> build the same-actor comparison
// plan whose prompts embed the REAL values -> drive it through a MOCK ollama. The live-GPU verdict is proven
// separately by the maintainer driver; this gate keeps the fixture + dereference wiring regression-proof.
//
// Usage: node experiments/ollama-comparison/verify-real-corpus-wiring.mjs [--json]
// Exit 0 when every check passes, 1 otherwise.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { concentrateManifest, dereferenceMetrics } from '../host-concentration/ingestCorpusManifest.mjs';
import { buildComparisonPlan, compareOverCorpus } from './ollamaComparison.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.slice(2).includes('--json');
const corpusDir = join(here, '..', 'host-concentration', 'fixtures', 'complete-corpus');
const manifestPath = join(corpusDir, 'manifest.json');
const FIXED_AT = '2026-07-28T12:00:00.000Z';

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

function loadDereferenced() {
  const corpus = concentrateManifest(manifestPath, { concentratedAt: FIXED_AT });
  dereferenceMetrics(corpus, corpusDir);
  return corpus;
}

// 1: the complete-corpus manifest ingests + concentrates into a 2-actor / 4-run isolated corpus.
await check('complete-manifest-ingests-2-actors-4-runs', () => {
  const corpus = loadDereferenced();
  assert(corpus.actors.length === 2, `expected 2 actors, got ${corpus.actors.length}`);
  assert(corpus.runCount === 4, `expected 4 runs, got ${corpus.runCount}`);
  return { actors: corpus.actors.length, runs: corpus.runCount };
});

// 2: dereference replaces each metricsRef PATH with a real metric summary (cpuMean/ramMeanMiB/durationMs).
await check('dereference-replaces-path-with-real-metric-summary', () => {
  const corpus = loadDereferenced();
  for (const run of corpus.runs) {
    assert(!/metrics\.json/.test(run.metricsRef), `run ${run.runId} metricsRef still a path: ${run.metricsRef}`);
    assert(
      /cpuMean=\d+pct, ramMeanMiB=\d+, durationMs=\d+/.test(run.metricsRef),
      `run ${run.runId} metricsRef not a metric summary: ${run.metricsRef}`
    );
  }
  return { sample: corpus.runs[0].metricsRef };
});

// 3: the comparison plan embeds the REAL dereferenced values in each prompt (host read reached the LLM path).
await check('comparison-plan-prompts-embed-real-values', () => {
  const corpus = loadDereferenced();
  const plan = buildComparisonPlan(corpus);
  assert(plan.comparisonCount === 2, `expected 2 comparisons, got ${plan.comparisonCount}`);
  // actor-1 regressed 40->57pct; actor-2 improved 55->44pct -- both baselines must appear verbatim in a prompt.
  const joined = plan.comparisons.map((c) => c.prompt).join('\n');
  assert(/cpuMean=40pct/.test(joined), 'actor-1 baseline cpuMean=40pct must appear in a prompt');
  assert(/cpuMean=57pct/.test(joined), 'actor-1 candidate cpuMean=57pct must appear in a prompt');
  assert(/cpuMean=55pct/.test(joined), 'actor-2 baseline cpuMean=55pct must appear in a prompt');
  assert(/cpuMean=44pct/.test(joined), 'actor-2 candidate cpuMean=44pct must appear in a prompt');
  return { comparisons: plan.comparisonCount };
});

// 4: a MOCK drive over the corpus yields one same-actor-scoped verdict per comparison (drive contract).
await check('mock-drive-yields-same-actor-verdicts', async () => {
  const corpus = loadDereferenced();
  const out = await compareOverCorpus(corpus, async (prompt) => ({ echoedActor: /actor ([\w-]+)/.exec(prompt)?.[1] }));
  assert(out.comparisonCount === 2, `expected 2 results, got ${out.comparisonCount}`);
  for (const r of out.results) {
    assert(corpus.actors.includes(r.actorId), `result actor ${r.actorId} not in the corpus (isolation)`);
    assert(r.verdict.echoedActor === r.actorId, `prompt actor ${r.verdict.echoedActor} must match result actor ${r.actorId}`);
  }
  return { results: out.comparisonCount };
});

// 5 (teeth): dereference over a manifest whose metrics file is missing throws with the offending run/path.
await check('dereference-missing-metrics-file-is-rejected', () => {
  const corpus = concentrateManifest(
    [{ actorId: 'ghost', runs: [{ runId: 'r1', metricsRef: 'nope/missing-metrics.json' }] }],
    { concentratedAt: FIXED_AT }
  );
  let threw = null;
  try {
    dereferenceMetrics(corpus, corpusDir);
  } catch (e) {
    threw = e;
  }
  assert(threw, 'a missing metrics file must throw');
  assert(/ghost\/r1/.test(threw.message) && /missing-metrics\.json/.test(threw.message), `error must name the run + path, got: ${threw && threw.message}`);
  return { rejected: true };
});

const total = results.length;
const passed = results.filter((r) => r.pass).length;
const failed = total - passed;
const receipt = {
  schemaVersion: 'labview-benchmark-actor/real-corpus-wiring-receipt-v1',
  manifest: 'experiments/host-concentration/fixtures/complete-corpus/manifest.json',
  total,
  passed,
  failed,
  results,
};
writeFileSync(join(here, 'real-corpus-wiring-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);

if (asJson) {
  console.log(JSON.stringify(receipt, null, 2));
} else {
  console.log(`real-corpus-wiring: ${passed}/${total} checks passed (LBA-REQ-010 full pipeline, mock drive)`);
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ' -- ' + r.error}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
