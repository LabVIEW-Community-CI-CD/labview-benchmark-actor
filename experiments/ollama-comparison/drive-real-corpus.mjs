#!/usr/bin/env node
// MAINTAINER driver (NOT a CI gate -- needs a real ollama + GPU): drive the FULL LBA-REQ-010 pipeline
// end-to-end over the LIVE ollama HTTP API, starting from a corpus MANIFEST FILE (the run-topology.ps1
// output shape). It proves the whole host-side path with no hand editing:
//
//   manifest file --ingest--> concentrate (per-actor isolation) --dereference VM-local metrics-->
//   same-actor comparison plan --LIVE ollama--> real run-over-run verdict
//
// The committed cores do the deterministic ingestion + concentration + planning (gated by
// verify-corpus-ingestion.mjs #22 and verify-ollama-comparison.mjs); a live LLM produces the verdict, so the
// output is non-deterministic maintainer evidence and is NEVER committed as a gate receipt. This is the
// one-command runner that turns WIN's emitted multi-VM manifest into the LBA-REQ-010 Proven evidence.
//
// Usage:
//   node experiments/ollama-comparison/drive-real-corpus.mjs \
//     [--manifest experiments/host-concentration/fixtures/complete-corpus/manifest.json] \
//     [--model llama3.1:8b] [--out <path>]
// Env: OLLAMA_HOST (default http://127.0.0.1:11434), M (model, overridden by --model).
//
// metricsRef in the manifest is a VM-local path (relative to the manifest) that the HOST dereferences here
// before prompting -- exactly the out-of-band step: run data lives VM-local and reaches the host only by the
// concentration export, never over the coordination bus (ADR-0006 / ADR-0008).

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { concentrateManifest, dereferenceMetrics } from '../host-concentration/ingestCorpusManifest.mjs';
import { compareOverCorpus } from './ollamaComparison.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const model = arg('--model', process.env.M || 'llama3.1:8b');
const outPath = arg('--out', null);
// Cap the ollama context so the KV cache fits smaller-RAM planes (cross-plane finding, see
// model-faithfulness-sweep.mjs); default null = the model's own context.
const numCtx = Number(arg('--num-ctx', process.env.OLLAMA_CONTEXT_LENGTH || '')) || null;
const manifestPath = resolve(
  process.cwd(),
  arg('--manifest', join(here, '..', 'host-concentration', 'fixtures', 'complete-corpus', 'manifest.json'))
);
const manifestDir = dirname(manifestPath);

// Ingest the manifest FILE + concentrate it (per-actor isolation preserved by the committed core).
const corpus = concentrateManifest(manifestPath, { concentratedAt: new Date().toISOString() });

// Dereference each run's VM-local metrics ref into a compact metric summary the LLM can reason over. This is
// the host-side out-of-band read: the manifest carries a PATH, the host resolves + reads the run data here.
dereferenceMetrics(corpus, manifestDir);

const drive = async (prompt) => {
  const res = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { num_predict: 180, ...(numCtx ? { num_ctx: numCtx } : {}) } }),
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

console.log(
  `LIVE_REAL_CORPUS_OK manifest=${manifestPath} model=${model} ` +
    `actors=${corpus.actors.length} runs=${corpus.runCount} comparisons=${out.comparisonCount} in ${elapsedS.toFixed(1)}s`
);
for (const r of out.results) {
  console.log(`\n[${r.actorId} ${r.baselineRunId}->${r.candidateRunId}] (${r.verdict.evalCount} tok)`);
  console.log(r.verdict.summary);
}

if (outPath) {
  const evidence = {
    schemaVersion: 'labview-benchmark-actor/real-corpus-live-evidence-v1',
    note: 'MAINTAINER evidence -- non-deterministic live ollama output over a real corpus manifest; not a CI gate receipt.',
    host,
    model,
    manifest: manifestPath,
    elapsedSeconds: elapsedS,
    corpusDigest: corpus.corpusDigest,
    actors: corpus.actors,
    runCount: corpus.runCount,
    results: out.results,
  };
  writeFileSync(resolve(process.cwd(), outPath), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nwrote evidence -> ${outPath}`);
}
