#!/usr/bin/env node
// Multi-VM out-of-band corpus concentration (LBA-REQ-010, T-010 leg 2).
//
// Consumes the per-actor run corpora that export-corpus.ps1 fetched from the two golden-box VMs to the
// host OUT-OF-BAND (over WinRM file-fetch, NEVER over lbabus net -- the coordination bus stays comms-only
// per ADR-0006/0008), and runs the SHIPPED host-concentration core over them. It imports LINUX's actual
// experiments/host-concentration/hostConcentration.mjs concentrate() + reviewOwnRuns() verbatim (no
// reimplementation) so this is a real WIN-topology + LINUX-core integration proof: the real multi-VM
// export feeds concentrate() with per-actor isolation and the run-data-only invariant intact.
//
// Usage: node concentrate-corpora.mjs --fetched-dir <dir> --out <receipt.json>
// Exit 0 iff every assertion holds.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { concentrate, reviewOwnRuns, SCHEMA } from '../../host-concentration/hostConcentration.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const fetchedDir = resolve(here, argOf('--fetched-dir', 'fetched'));
const outPath = resolve(here, argOf('--out', 'receipt.json'));

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

// Load every per-actor corpus the driver fetched out-of-band. Strip a leading UTF-8 BOM: the guest's
// PowerShell 5.1 `Set-Content -Encoding utf8` emits one, and JSON.parse rejects it.
const corpusFiles = readdirSync(fetchedDir).filter((n) => n.toLowerCase().endsWith('.json')).sort();
assert(corpusFiles.length >= 2, `expected >= 2 fetched per-actor corpora in ${fetchedDir}, found ${corpusFiles.length}`);
const corpora = corpusFiles.map((n) => JSON.parse(readFileSync(join(fetchedDir, n), 'utf8').replace(/^\uFEFF/, '')));

// Concentrate through the SHIPPED core (deterministic corpusDigest; concentratedAt fixed for a stable digest input).
const concentrated = concentrate(corpora, { concentratedAt: '1970-01-01T00:00:00.000Z' });

// (1) Every source actor is present, exactly once, and the run count is the sum of the inputs.
const inputActors = corpora.map((c) => c.actorId).sort();
const inputRunTotal = corpora.reduce((n, c) => n + c.runs.length, 0);
assert(concentrated.actors.length === inputActors.length, 'concentrated actor count must equal the input corpora count');
assert(concentrated.actors.join(',') === [...new Set(inputActors)].sort().join(','), 'concentrated actors must be the input actors');
assert(concentrated.runCount === inputRunTotal, `runCount ${concentrated.runCount} must equal the input total ${inputRunTotal}`);

// (2) Per-actor isolation: reviewOwnRuns returns exactly that actor's runs, and never another actor's.
const isolation = {};
for (const corpus of corpora) {
  const own = reviewOwnRuns(concentrated, corpus.actorId);
  assert(own.length === corpus.runs.length, `${corpus.actorId} own-run count ${own.length} must equal its input ${corpus.runs.length}`);
  assert(own.every((r) => r.actorId === corpus.actorId), `${corpus.actorId} reviewOwnRuns leaked another actor's run (no cross-VM read)`);
  const ownRunIds = own.map((r) => r.runId).sort();
  const srcRunIds = corpus.runs.map((r) => r.runId).sort();
  assert(ownRunIds.join(',') === srcRunIds.join(','), `${corpus.actorId} own runIds must match its source corpus`);
  isolation[corpus.actorId] = ownRunIds.length;
}
// Cross-check: the union of per-actor own-runs equals the whole corpus (no run lost or duplicated).
const ownUnion = Object.values(isolation).reduce((a, b) => a + b, 0);
assert(ownUnion === concentrated.runCount, 'per-actor own-runs must partition the concentrated corpus exactly');

// (3) Run-data-only invariant: a bus-shaped corpus (carrying a coordination-envelope marker) MUST be rejected,
//     proving the concentration step refuses anything that smells like bus traffic (ADR-0006/0008).
let busRejected = false;
let busRejectionMessage = null;
try {
  concentrate([{ actorId: 'ACTOR-A', runs: [], senderId: 'ACTOR-A', ackOf: 1 }]);
} catch (error) {
  busRejected = true;
  busRejectionMessage = String(error && error.message ? error.message : error);
}
assert(busRejected, 'concentrate() must reject a bus-shaped corpus (run data only, never bus traffic)');

// (4) Determinism: re-concentrating the same inputs reproduces the same corpusDigest.
const again = concentrate(corpora, { concentratedAt: '1970-01-01T00:00:00.000Z' });
assert(again.corpusDigest === concentrated.corpusDigest, 'corpusDigest must be deterministic across runs');

const receipt = {
  schema: 'labview-benchmark-actor/multi-vm-corpus-export-receipt-v1',
  requirement: 'LBA-REQ-010',
  test: 'T-010',
  ranAt: new Date().toISOString(),
  transport: 'out-of-band WinRM file-fetch (vagrant winrm Get-Content) -- NOT lbabus net; the coordination bus stays comms-only (ADR-0006/0008)',
  core: 'experiments/host-concentration/hostConcentration.mjs concentrate()/reviewOwnRuns() (shipped, imported verbatim)',
  coreSchema: SCHEMA,
  actors: concentrated.actors,
  runCount: concentrated.runCount,
  corpusDigest: concentrated.corpusDigest,
  perActorIsolation: isolation,
  busShapedRejected: busRejected,
  busRejectionMessage,
  deterministicDigest: true,
  pass: true,
  concentratedCorpus: concentrated,
};
writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`[corpus] concentrated ${concentrated.actors.length} actors / ${concentrated.runCount} runs; digest ${concentrated.corpusDigest}; isolation ${JSON.stringify(isolation)}; bus-shaped rejected=${busRejected}\n`);
process.stdout.write(`[corpus] receipt -> ${outPath}  (pass=true)\n`);
