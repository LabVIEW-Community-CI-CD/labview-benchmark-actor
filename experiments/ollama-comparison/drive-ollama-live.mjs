#!/usr/bin/env node
// MAINTAINER driver (NOT a CI gate -- needs a real ollama + GPU): drive the ollama-comparison pipeline over
// a concentrated corpus using the LIVE ollama HTTP API, proving the host-side comparison layer produces a
// real run-over-run analysis on real hardware (LBA-REQ-010 AC #3). The committed core does the deterministic
// planning; a live LLM produces the verdict, so the output is non-deterministic maintainer evidence and is
// NEVER committed as a gate receipt (see verify-ollama-comparison.mjs for the deterministic self-test).
//
// Usage:
//   node experiments/ollama-comparison/drive-ollama-live.mjs [--model llama3.1:8b] [--out <path>]
// Env: OLLAMA_HOST (default http://127.0.0.1:11434), M (model, overridden by --model).
//
// A run corpus here carries a short metric summary in `metricsRef` for the demo; in production the ref is a
// VM-local mprr store path that the host layer dereferences before prompting (the corpus is produced once the
// multi-VM topology (LBA-REQ-006) exports each VM's run data to the host, out-of-band, never over the bus).

import { writeFileSync } from 'node:fs';
import { concentrate } from '../host-concentration/hostConcentration.mjs';
import { compareOverCorpus } from './ollamaComparison.mjs';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const model = arg('--model', process.env.M || 'llama3.1:8b');
const outPath = arg('--out', null);

// One actor's own consecutive completed runs (a run-over-run regression to explain).
const corpus = concentrate([
  {
    actorId: 'vm-a',
    runs: [
      { runId: 'r1', metricsRef: 'cpuMean=42pct, ramMeanMiB=610, durationMs=1200', framesRef: 'a/r1/frames' },
      { runId: 'r2', metricsRef: 'cpuMean=58pct, ramMeanMiB=770, durationMs=1600', framesRef: 'a/r2/frames' },
    ],
  },
]);

const drive = async (prompt) => {
  const res = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { num_predict: 160 } }),
  });
  if (!res.ok) {
    throw new Error(`ollama ${res.status} at ${host} -- is 'ollama serve' running with model ${model}?`);
  }
  const j = await res.json();
  return { model, evalCount: j.eval_count ?? null, summary: (j.response || '').replace(/\s+/g, ' ').trim() };
};

const startedAt = Date.now();
const out = await compareOverCorpus(corpus, drive);
const elapsedS = (Date.now() - startedAt) / 1000;

console.log(`LIVE_OLLAMA_COMPARISON_OK model=${model} comparisons=${out.comparisonCount} in ${elapsedS.toFixed(1)}s`);
for (const r of out.results) {
  console.log(`\n[${r.actorId} ${r.baselineRunId}->${r.candidateRunId}] (${r.verdict.evalCount} tok)`);
  console.log(r.verdict.summary);
}

if (outPath) {
  const evidence = {
    schemaVersion: 'labview-benchmark-actor/ollama-comparison-live-evidence-v1',
    note: 'MAINTAINER evidence -- non-deterministic live ollama output; not a CI gate receipt.',
    host,
    model,
    elapsedSeconds: elapsedS,
    corpusDigest: corpus.corpusDigest,
    results: out.results,
  };
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nwrote evidence -> ${outPath}`);
}
