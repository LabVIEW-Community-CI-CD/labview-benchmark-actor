#!/usr/bin/env node
// MAINTAINER model-selection sweep for the LBA-REQ-010 ollama comparison layer (NOT a CI gate -- needs a live
// ollama + GPU). It drives EVERY locally available candidate model over the concentrated-corpus comparison
// plan and scores which model most faithfully reads the run-over-run regression DIRECTION, so the host-side
// comparison layer can pick a model on evidence instead of assumption. Also reports throughput (latency +
// tokens) per model. This is real 010 design evidence AND a genuine sustained GPU/CPU workload (small models
// run on the 8GB GPU; a >VRAM model such as qwen2.5:14b partial-offloads, exercising GPU + CPU + RAM together).
//
// Usage:
//   node experiments/ollama-comparison/model-faithfulness-sweep.mjs \
//     [--models llama3.1:8b,qwen2.5:14b,vichange8b-2shot,vichange8b-fewshot] [--repeats 3] [--out <path>]
// Env: OLLAMA_HOST (default http://127.0.0.1:11434).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { concentrateManifest, dereferenceMetrics } from '../host-concentration/ingestCorpusManifest.mjs';
import { buildComparisonPlan } from './ollamaComparison.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const models = arg('--models', 'llama3.1:8b,qwen2.5:14b,vichange8b-2shot,vichange8b-fewshot')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const repeats = Number(arg('--repeats', '3'));
const outPath = arg('--out', null);
const corpusDir = join(here, '..', 'host-concentration', 'fixtures', 'complete-corpus');
const manifestPath = join(corpusDir, 'manifest.json');

// Concentrate + dereference the corpus, then build the same-actor comparison plan and the EXPECTED cpu
// direction per comparison (ground truth from the metrics: candidate cpu vs baseline cpu).
const corpus = concentrateManifest(manifestPath, { concentratedAt: '1970-01-01T00:00:00.000Z' });
dereferenceMetrics(corpus, corpusDir);
// Ground truth per run, keyed by actorId/runId -- runIds (run-001/run-002) REPEAT across actors, so keying by
// runId alone collides and mislabels one actor's direction. Look it up per comparison with the actor scope.
const cpuOf = new Map(corpus.runs.map((r) => [`${r.actorId}/${r.runId}`, Number(/cpuMean=(\d+)pct/.exec(r.metricsRef)?.[1] ?? NaN)]));
const plan = buildComparisonPlan(corpus);
const expected = plan.comparisons.map((c) => ({
  ...c,
  expectedDir:
    cpuOf.get(`${c.actorId}/${c.candidateRunId}`) > cpuOf.get(`${c.actorId}/${c.baselineRunId}`) ? 'up' : 'down',
}));

const UP = /\b(increas\w*|higher|rose|grew|grow\w*|greater|regress\w*|worse\w*|degrad\w*|climb\w*|jump\w*)/gi;
const DOWN = /\b(decreas\w*|lower|fell|drop\w*|reduc\w*|improv\w*|better|gain\w*|declin\w*|less\b|fewer)/gi;

// Score one verdict: which direction does the model predict (majority of direction words), and is it correct?
function scoreDirection(text, expectedDir) {
  const up = (text.match(UP) || []).length;
  const down = (text.match(DOWN) || []).length;
  const predicted = up === down ? 'tie' : up > down ? 'up' : 'down';
  return { predicted, correct: predicted === expectedDir, up, down };
}

async function drive(model, prompt) {
  const startedAt = Date.now();
  const res = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { num_predict: 180, temperature: 0 } }),
  });
  if (!res.ok) {
    throw new Error(`ollama ${res.status} for ${model} at ${host}`);
  }
  const j = await res.json();
  return {
    ms: Date.now() - startedAt,
    tokens: j.eval_count ?? 0,
    text: (j.response || '').replace(/\s+/g, ' ').trim(),
  };
}

const results = [];
const sweepStart = Date.now();
for (const model of models) {
  const perModel = { model, comparisons: 0, correct: 0, totalMs: 0, totalTokens: 0, samples: [] };
  for (const c of expected) {
    for (let r = 0; r < repeats; r += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential drive = sustained back-to-back GPU load + stable receipt.
      let out;
      try {
        out = await drive(model, c.prompt);
      } catch (err) {
        perModel.samples.push({ actorId: c.actorId, repeat: r, error: String(err.message || err) });
        continue;
      }
      const s = scoreDirection(out.text, c.expectedDir);
      perModel.comparisons += 1;
      perModel.correct += s.correct ? 1 : 0;
      perModel.totalMs += out.ms;
      perModel.totalTokens += out.tokens;
      perModel.samples.push({ actorId: c.actorId, expectedDir: c.expectedDir, predicted: s.predicted, correct: s.correct, ms: out.ms, tokens: out.tokens });
      process.stdout.write(
        `${model} ${c.actorId} ${c.baselineRunId}->${c.candidateRunId} rep${r}: ` +
          `${s.correct ? 'OK ' : 'MISS'} pred=${s.predicted} exp=${c.expectedDir} ${out.ms}ms ${out.tokens}tok\n`
      );
    }
  }
  perModel.directionAccuracy = perModel.comparisons ? perModel.correct / perModel.comparisons : 0;
  perModel.avgMs = perModel.comparisons ? Math.round(perModel.totalMs / perModel.comparisons) : null;
  perModel.tokPerSec = perModel.totalMs ? Math.round((perModel.totalTokens / perModel.totalMs) * 1000) : null;
  results.push(perModel);
  process.stdout.write(
    `== ${model}: directionAccuracy ${(perModel.directionAccuracy * 100).toFixed(0)}% ` +
      `(${perModel.correct}/${perModel.comparisons}) avg ${perModel.avgMs}ms ${perModel.tokPerSec} tok/s ==\n\n`
  );
}
const elapsedS = (Date.now() - sweepStart) / 1000;

// Recommend: highest directionAccuracy, tie-break on lower avg latency.
const ranked = [...results].filter((r) => r.comparisons > 0).sort(
  (a, b) => b.directionAccuracy - a.directionAccuracy || a.avgMs - b.avgMs
);
const recommended = ranked[0]?.model ?? null;

console.log(`SWEEP DONE in ${elapsedS.toFixed(1)}s over ${models.length} models x ${expected.length} comparisons x ${repeats} repeats.`);
console.log(`RECOMMENDED model for the 010 comparison layer: ${recommended}`);
for (const r of ranked) {
  console.log(`  ${r.model.padEnd(22)} acc=${(r.directionAccuracy * 100).toFixed(0)}%  avg=${r.avgMs}ms  ${r.tokPerSec}tok/s`);
}

if (outPath) {
  const evidence = {
    schemaVersion: 'labview-benchmark-actor/model-faithfulness-sweep-v1',
    note: 'MAINTAINER evidence -- non-deterministic live ollama output; not a CI gate receipt.',
    host,
    generatedAt: new Date().toISOString(),
    models,
    repeats,
    comparisonsPerModel: expected.length,
    elapsedSeconds: elapsedS,
    recommended,
    results,
  };
  writeFileSync(resolve(process.cwd(), outPath), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nwrote evidence -> ${outPath}`);
}
