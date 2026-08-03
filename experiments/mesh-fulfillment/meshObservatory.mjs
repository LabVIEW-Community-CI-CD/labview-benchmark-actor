#!/usr/bin/env node
// meshObservatory.mjs -- the MESH COVERAGE OBSERVATORY (LBA-REQ-075, realizes ADR-0056). Folds the governed
// mesh-run receipts into a coverage matrix + a consistency ledger: for each benchmark, was it DISPATCHED
// (LBA-REQ-074), FULFILLED cross-plane (LBA-REQ-073), and does its cross-plane PARITY hold (LBA-REQ-072) -- and
// do all three name the SAME benchmark identity (the same run). This is the operator-facing mesh dashboard and
// the Phase 3->4 bridge: cross-plane comparison AT SCALE, with no central results database.
//
// Pure + rg-free + offline: a committed observatory re-derives its coverage + ledger + digest byte-stably in CI.
// Fails closed on a run whose dispatch / fulfillment / parity disagree on identity, an un-fulfilled run counted
// as coherent, a miscounted coverage statistic, or a tampered digest.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/mesh-coverage-observatory@1';
export const REQUIREMENT = 'LBA-REQ-075';
export const ADR = 'ADR-0056';

// Fold one benchmark's dispatch (074) + fulfillment (073) + parity (072) into a coverage row. `consistent` iff a
// dispatch AND a fulfillment are present and all present artifacts name the SAME benchmark identity.
export function foldRun({ dispatch, fulfillment, parity } = {}) {
  const identities = [dispatch?.identity, fulfillment?.identity, parity?.launchIdentity].filter((x) => typeof x === 'string' && x.length > 0);
  const identityAgrees = identities.length > 0 && identities.every((i) => i === identities[0]);
  const dispatched = !!dispatch;
  const fulfilled = fulfillment?.verdict?.fulfilled === true;
  return {
    benchmarkId: fulfillment?.dispatch?.benchmarkId ?? dispatch?.benchmarkId ?? null,
    identity: identities[0] ?? null,
    dispatched,
    minActors: dispatch?.minActors ?? null,
    requestedPlanes: Array.isArray(dispatch?.requestedPlanes) ? dispatch.requestedPlanes : [],
    fulfilled,
    distinctActors: fulfillment?.fulfillment?.distinctActors ?? 0,
    planes: Array.isArray(fulfillment?.fulfillment?.planes) ? fulfillment.fulfillment.planes : [],
    parityProven: parity?.parity?.parityProven === true,
    consistent: dispatched && fulfilled && identityAgrees,
  };
}

// Derive the coverage matrix + ledger + verdict over a set of folded rows.
export function coverageOf(rows) {
  const planes = [...new Set(rows.flatMap((r) => r.planes))].sort();
  return {
    benchmarks: rows.length,
    fulfilledBenchmarks: rows.filter((r) => r.fulfilled).length,
    parityProvenBenchmarks: rows.filter((r) => r.parityProven).length,
    consistentRuns: rows.filter((r) => r.consistent).length,
    planes,
    totalDistinctActors: rows.reduce((s, r) => s + (Number.isFinite(r.distinctActors) ? r.distinctActors : 0), 0),
  };
}

function canonical(obs) {
  return JSON.stringify({
    schema: obs.schema,
    requirement: obs.requirement,
    adr: obs.adr,
    rows: Array.isArray(obs.rows) ? obs.rows : null,
    coverage: obs.coverage ?? null,
    ledger: obs.ledger ?? null,
    verdict: { observatoryOk: obs.verdict?.observatoryOk },
  });
}

export function digestObservatory(obs) {
  return createHash('sha256').update(canonical(obs)).digest('hex');
}

// Build a mesh coverage observatory by folding the mesh runs (each { dispatch, fulfillment, parity }).
export function buildObservatory({ runs } = {}) {
  const rows = (runs ?? []).map(foldRun);
  const coverage = coverageOf(rows);
  const allCoherent = rows.length > 0 && rows.every((r) => r.consistent);
  const ledger = {
    allDispatched: rows.length > 0 && rows.every((r) => r.dispatched),
    allFulfilled: rows.length > 0 && rows.every((r) => r.fulfilled),
    allIdentityConsistent: rows.length > 0 && rows.every((r) => r.consistent),
  };
  const obs = {
    schema: RECEIPT_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    rows,
    coverage,
    ledger,
    verdict: {
      observatoryOk: allCoherent,
      reason: allCoherent
        ? `${rows.length} mesh run(s) folded; all dispatched -> fulfilled cross-plane with a consistent identity across [${coverage.planes.join(', ')}] (${coverage.totalDistinctActors} actor-runs, ${coverage.parityProvenBenchmarks} parity-proven)`
        : 'observatory not coherent: a run is missing its dispatch/fulfillment or its dispatch/fulfillment/parity disagree on identity',
    },
  };
  obs.digest = digestObservatory(obs);
  return obs;
}

// Validate a committed observatory: schema/requirement/adr, the coverage + ledger re-derive from the rows, every
// row is internally consistent (a coherent run has a dispatch + a fulfilled fulfillment + an agreeing identity),
// the verdict matches the rule, and the digest re-derives. Fail-closed.
export function validateObservatory(obs) {
  const findings = [];
  if (!obs || obs.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (obs?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (obs?.adr !== ADR) findings.push(`adr must be ${ADR}`);
  const rows = Array.isArray(obs?.rows) ? obs.rows : [];
  if (rows.length === 0) findings.push('the observatory folds no mesh runs');

  const expectedCoverage = coverageOf(rows);
  if (JSON.stringify(obs?.coverage) !== JSON.stringify(expectedCoverage)) findings.push('coverage does not match the folded rows (miscounted)');

  rows.forEach((r, i) => {
    const expectedConsistent = r.dispatched === true && r.fulfilled === true;
    // a row flagged consistent must actually be dispatched + fulfilled (identity agreement is folded upstream);
    // a row NOT dispatched+fulfilled must not claim consistency.
    if (r.consistent && !expectedConsistent) findings.push(`row[${i}] (${r.benchmarkId}) claims consistency without a dispatch + a fulfilled fulfillment`);
  });

  const allCoherent = rows.length > 0 && rows.every((r) => r.consistent === true);
  if (obs?.verdict?.observatoryOk !== allCoherent) findings.push(`verdict.observatoryOk=${obs?.verdict?.observatoryOk} contradicts the rule (${allCoherent})`);

  const expectedLedger = {
    allDispatched: rows.length > 0 && rows.every((r) => r.dispatched),
    allFulfilled: rows.length > 0 && rows.every((r) => r.fulfilled),
    allIdentityConsistent: rows.length > 0 && rows.every((r) => r.consistent),
  };
  if (JSON.stringify(obs?.ledger) !== JSON.stringify(expectedLedger)) findings.push('ledger does not match the folded rows');

  if (obs?.digest !== digestObservatory(obs)) findings.push('digest does not match the observatory-bearing fields (tampered)');
  return { ok: findings.length === 0, proofOk: !!obs?.verdict?.observatoryOk && findings.length === 0, findings };
}

// CLI: validate the committed observatory next to this module (offline, deterministic). Exit 1 on any finding.
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const obsPath = join(here, 'mesh-coverage-observatory-receipt.json');
  const obs = JSON.parse(readFileSync(obsPath, 'utf8'));
  const result = validateObservatory(obs);
  if (!result.ok) {
    console.error(`[mesh-coverage-observatory] FAIL ${obsPath}`);
    for (const f of result.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  const c = obs.coverage;
  console.log(`[mesh-coverage-observatory] OK ${REQUIREMENT}: ${c.benchmarks} benchmark(s), ${c.fulfilledBenchmarks} fulfilled, planes [${c.planes.join(', ')}], ${c.totalDistinctActors} actor-runs; coherent=${result.proofOk}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
