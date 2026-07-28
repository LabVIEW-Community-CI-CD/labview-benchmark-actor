#!/usr/bin/env node
// Multi-VM out-of-band corpus concentration THROUGH the shipped ingestion boundary (LBA-REQ-010, T-010 leg 2).
//
// Consumes the corpus MANIFEST that export-corpus.ps1 fetched from the two golden-box VMs to the host
// OUT-OF-BAND (over WinRM file-fetch, NEVER over lbabus net -- the coordination bus stays comms-only per
// ADR-0006/0008), and runs it through LINUX's SHIPPED ingestion boundary + cores, imported verbatim (no
// reimplementation):
//
//   fetched/manifest.json (corpus-manifest@v1)
//     --concentrateManifest--> concentrate (per-actor isolation)
//     --dereferenceMetrics(fetchedDir)--> each run's VM-local metrics file -> a real metric summary
//     --buildComparisonPlan--> same-actor run-over-run plan whose prompts embed the REAL values
//     --compareOverCorpus(stub)--> one same-actor verdict per comparison
//
// This is the REAL multi-VM concentrated corpus that LINUX's fixtures (sample/complete-corpus) stand in for;
// it is drive-ready for the live ollama drive (experiments/ollama-comparison/drive-real-corpus.mjs --manifest),
// which is the remaining maintainer/GPU step. This module proves the whole host-side path deterministically
// (no GPU) over REAL VM output.
//
// Usage: node concentrate-corpora.mjs --manifest <manifest.json> --out <receipt.json>
// Exit 0 iff every assertion holds.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { concentrateManifest, dereferenceMetrics, MANIFEST_SCHEMA } from '../../host-concentration/ingestCorpusManifest.mjs';
import { reviewOwnRuns, SCHEMA as CORE_SCHEMA } from '../../host-concentration/hostConcentration.mjs';
import { buildComparisonPlan, compareOverCorpus } from '../../ollama-comparison/ollamaComparison.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const manifestPath = resolve(here, argOf('--manifest', 'fetched/manifest.json'));
const manifestDir = dirname(manifestPath);
const outPath = resolve(here, argOf('--out', 'receipt.json'));

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

const FIXED_AT = '1970-01-01T00:00:00.000Z';

// The manifest must be the corpus-manifest@v1 envelope WIN emits (strip a leading UTF-8 BOM: the guest's
// PowerShell 5.1 `Set-Content -Encoding utf8` emits one, and JSON.parse rejects it).
const rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
assert(rawManifest.schema === MANIFEST_SCHEMA, `manifest schema must be ${MANIFEST_SCHEMA}, got ${rawManifest.schema}`);
assert(Array.isArray(rawManifest.corpora) && rawManifest.corpora.length >= 2, 'manifest must carry >= 2 per-actor corpora');

// Ingest + concentrate THROUGH the shipped boundary (deterministic corpusDigest; concentratedAt fixed).
const corpus = concentrateManifest(manifestPath, { concentratedAt: FIXED_AT });
const inputActors = rawManifest.corpora.map((c) => c.actorId).sort();
const inputRunTotal = rawManifest.corpora.reduce((n, c) => n + c.runs.length, 0);

// (1) Every source actor is present exactly once; runCount is the sum of the inputs.
assert(corpus.actors.length === inputActors.length, 'concentrated actor count must equal the input corpora count');
assert(corpus.actors.join(',') === [...new Set(inputActors)].sort().join(','), 'concentrated actors must be the input actors');
assert(corpus.runCount === inputRunTotal, `runCount ${corpus.runCount} must equal the input total ${inputRunTotal}`);

// (2) Per-actor isolation: reviewOwnRuns returns exactly that actor's runs, never another's (no cross-VM read);
//     each actor has >= 2 runs (a baseline + a candidate) so a real run-over-run comparison exists.
const isolation = {};
const ownRunIdsByActor = {};
for (const c of rawManifest.corpora) {
  const own = reviewOwnRuns(corpus, c.actorId);
  assert(own.length === c.runs.length, `${c.actorId} own-run count ${own.length} must equal its input ${c.runs.length}`);
  assert(own.every((r) => r.actorId === c.actorId), `${c.actorId} reviewOwnRuns leaked another actor's run (no cross-VM read)`);
  assert(own.length >= 2, `${c.actorId} needs >= 2 runs for a run-over-run comparison, got ${own.length}`);
  isolation[c.actorId] = own.length;
  ownRunIdsByActor[c.actorId] = new Set(own.map((r) => r.runId));
}
// Cross-check: the union of per-actor own-runs equals the whole corpus (no run lost or duplicated).
const ownUnion = Object.values(isolation).reduce((a, b) => a + b, 0);
assert(ownUnion === corpus.runCount, 'per-actor own-runs must partition the concentrated corpus exactly');

// (3) Run-data-only invariant: a bus-shaped corpus (carrying a coordination-envelope marker) MUST be rejected
//     by the SAME boundary, proving it refuses anything that smells like bus traffic (ADR-0006/0008).
let busRejected = false;
let busRejectionMessage = null;
try {
  concentrateManifest([{ actorId: 'ACTOR-A', runs: [], senderId: 'ACTOR-A', ackOf: 1 }]);
} catch (error) {
  busRejected = true;
  busRejectionMessage = String(error && error.message ? error.message : error);
}
assert(busRejected, 'concentrateManifest() must reject a bus-shaped corpus (run data only, never bus traffic)');

// (4) Determinism: re-ingesting the same manifest reproduces the same corpusDigest.
const again = concentrateManifest(manifestPath, { concentratedAt: FIXED_AT });
assert(again.corpusDigest === corpus.corpusDigest, 'corpusDigest must be deterministic across ingests');

// (5) Out-of-band host read: dereference each run's VM-local metrics file (a PATH relative to the manifest)
//     into a real metric summary. This is the explicit out-of-band step -- the manifest carries a path, the
//     host resolves + reads the run data here, never over the bus.
dereferenceMetrics(corpus, manifestDir);
for (const run of corpus.runs) {
  assert(!/metrics\.json/.test(run.metricsRef), `run ${run.actorId}/${run.runId} metricsRef still a path: ${run.metricsRef}`);
  assert(
    /cpuMean=\d+pct, ramMeanMiB=\d+, durationMs=\d+/.test(run.metricsRef),
    `run ${run.actorId}/${run.runId} metricsRef not a real metric summary: ${run.metricsRef}`
  );
}

// (6) The comparison plan pairs same-actor runs only (no cross-VM) and its prompts embed the REAL dereferenced
//     values -- the out-of-band host read reached the LLM path.
const plan = buildComparisonPlan(corpus);
assert(plan.comparisonCount >= corpus.actors.length, `expected >= ${corpus.actors.length} comparisons, got ${plan.comparisonCount}`);
for (const cmp of plan.comparisons) {
  const runsForActor = ownRunIdsByActor[cmp.actorId];
  assert(runsForActor, `comparison actor ${cmp.actorId} not in the corpus (isolation)`);
  assert(runsForActor.has(cmp.baselineRunId) && runsForActor.has(cmp.candidateRunId), `comparison for ${cmp.actorId} must pair its OWN runs (no cross-VM)`);
}
const promptBlob = plan.comparisons.map((c) => c.prompt).join('\n');
assert(/cpuMean=\d+pct/.test(promptBlob), 'the plan prompts must embed the real dereferenced cpuMean values');

// (7) A MOCK drive over the corpus yields exactly one same-actor-scoped verdict per comparison (drive contract).
const out = await compareOverCorpus(corpus, async (prompt) => ({ echoedActor: /actor ([\w-]+)/i.exec(prompt)?.[1] ?? null }));
assert(out.comparisonCount === plan.comparisonCount, `mock drive must yield ${plan.comparisonCount} verdicts, got ${out.comparisonCount}`);
for (const r of out.results) {
  assert(corpus.actors.includes(r.actorId), `result actor ${r.actorId} not in the corpus (isolation)`);
  const runsForActor = ownRunIdsByActor[r.actorId];
  assert(runsForActor.has(r.baselineRunId) && runsForActor.has(r.candidateRunId), `verdict for ${r.actorId} must pair its OWN runs`);
}

const receipt = {
  schema: 'labview-benchmark-actor/multi-vm-corpus-export-receipt-v1',
  requirement: 'LBA-REQ-010',
  test: 'T-010',
  ranAt: new Date().toISOString(),
  transport: 'out-of-band WinRM file-fetch (vagrant winrm -> base64) -- NOT lbabus net; the coordination bus stays comms-only (ADR-0006/0008)',
  boundary: 'experiments/host-concentration/ingestCorpusManifest.mjs concentrateManifest()/dereferenceMetrics() (shipped, imported verbatim)',
  manifestSchema: rawManifest.schema,
  coreSchema: CORE_SCHEMA,
  actors: corpus.actors,
  runCount: corpus.runCount,
  corpusDigest: corpus.corpusDigest,
  perActorIsolation: isolation,
  busShapedRejected: busRejected,
  busRejectionMessage,
  deterministicDigest: true,
  dereferencedMetrics: true,
  metricSummarySample: corpus.runs[0].metricsRef,
  comparisonPlan: { comparisonCount: plan.comparisonCount, sameActorOnly: true },
  driveReady: true,
  driveCommand: 'node experiments/ollama-comparison/drive-real-corpus.mjs --manifest experiments/multi-vm-topology/corpus-export/fetched/manifest.json',
  pass: true,
  concentratedCorpus: corpus,
};
writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(
  `[corpus] ${corpus.actors.length} actors / ${corpus.runCount} runs through ingestCorpusManifest; digest ${corpus.corpusDigest}; ` +
    `isolation ${JSON.stringify(isolation)}; bus-shaped rejected=${busRejected}; comparisons=${plan.comparisonCount}; dereferenced=true\n`
);
process.stdout.write(`[corpus] receipt -> ${outPath}  (pass=true, drive-ready)\n`);
