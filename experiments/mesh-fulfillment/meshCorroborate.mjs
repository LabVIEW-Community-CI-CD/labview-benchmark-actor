#!/usr/bin/env node
// meshCorroborate.mjs -- LBA-REQ-092 / ADR-0075. The RUN-BOUND CROSS-PLANE CORROBORATE + COMPARE stage of the
// North Star mesh loop. Consumes the run-bound receipt-collection@1 (LBA-REQ-091 ingest, itself the LBA-REQ-076
// fan-out over the LIVE dispatch + the actors' returned receipts) and, for the ONE dispatched benchmark:
//
//   (a) CORROBORATES cross-plane -- the collected plane-tagged receipts must span >= 2 distinct OS-planes
//       (crossPlane), each plane's workload-trend@1 must PASS, each receipt.plane must match its collected plane,
//       and each must RE-DERIVE the dispatch identity (dispatchIdentity{metric,workload,n} === collection.identity)
//       so every plane provably ran the SAME dispatched benchmark; and
//   (b) COMPARES the planes -- REUSES benchmark-store compareRuns (the governed cross-plane compare core, pure +
//       deterministic) to report each plane's launch metrics + the candidate-WIN-vs-baseline-LINUX deltas.
//
// Produces a run-bound mesh-cross-plane-report@1 bound to the dispatchId + identity, FAIL-CLOSED unless
// corroborated. Pure + offline: no corroboration/compare gating is reimplemented -- it reuses compareRuns
// (comparison) + dispatchIdentity (identity binding). This is the "corroborate + compare the real-benchmark
// receipts" stage the agent driver runs on the ingested collection; the selftest proves it deterministically.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dispatchIdentity } from './meshDispatch.mjs';
import { compareRuns } from '../benchmark-store/benchmarkStore.mjs';

export const REPORT_SCHEMA = 'labview-benchmark-actor/mesh-cross-plane-report@1';
export const COLLECTION_SCHEMA = 'labview-benchmark-actor/receipt-collection@1';
export const TREND_SCHEMA = 'labview-benchmark-actor/workload-trend@1';
export const REQUIREMENT = 'LBA-REQ-092';
export const ADR = 'ADR-0075';

// A collected receipt is a comparable plane witness iff it is a workload-trend@1 with the identity fields
// (metric/workload/n), numeric stats, and a verdict.
export function trendOk(r) {
  return !!r && r.schema === TREND_SCHEMA
    && typeof r.metric === 'string' && r.metric.length > 0
    && typeof r.workload === 'string' && r.workload.length > 0
    && typeof r.n === 'number'
    && r.stats && typeof r.stats === 'object'
    && typeof r.verdict === 'string' && r.verdict.length > 0;
}

// The comparable numeric metric map a plane's trend contributes to the cross-plane compare (launch timings).
function trendMetrics(r) {
  return {
    latest: r.latest,
    mean: r.stats?.mean,
    median: r.stats?.median,
    min: r.stats?.min,
    max: r.stats?.max,
    spread: r.stats?.spread,
    baselineMs: r.baselineMs,
  };
}

// Corroborate + compare a run-bound receipt-collection@1 across its planes. Returns a run-bound report + findings.
// Fail-closed: corroborated iff there are no findings (every guard below holds).
export function corroborateRun({ collection, benchmarkId } = {}) {
  const findings = [];
  if (!collection || collection.schema !== COLLECTION_SCHEMA) findings.push(`collection: schema must be ${COLLECTION_SCHEMA}`);
  const collected = Array.isArray(collection?.collected) ? collection.collected : [];
  if (collected.length === 0) findings.push('collection: no collected receipts');

  const identity = collection?.identity ?? null;
  const byPlane = new Map();
  const actorsByPlane = new Map();
  const verdicts = {};
  let identityBound = true;
  for (const c of collected) {
    const r = c?.receipt;
    if (!trendOk(r)) { findings.push(`plane ${c?.plane}: receipt is not a valid ${TREND_SCHEMA}`); continue; }
    if (r.plane !== c.plane) findings.push(`plane ${c.plane}: receipt plane (${r.plane}) does not match the collected plane`);
    if (dispatchIdentity({ metric: r.metric, workload: r.workload, n: r.n }) !== identity) {
      findings.push(`plane ${c.plane}: receipt does not re-derive the dispatch identity (ran a different benchmark)`);
      identityBound = false;
    }
    verdicts[c.plane] = r.verdict;
    if (r.verdict !== 'PASS') findings.push(`plane ${c.plane}: verdict is ${r.verdict} (not PASS)`);
    if (!byPlane.has(c.plane)) byPlane.set(c.plane, r);
    if (!actorsByPlane.has(c.plane)) actorsByPlane.set(c.plane, []);
    actorsByPlane.get(c.plane).push({ actorId: c.actorId ?? null, meanMs: r.stats?.mean ?? null });
  }

  const planes = [...byPlane.keys()].sort();
  const crossPlane = planes.length >= 2;
  if (!crossPlane) findings.push(`corroboration is not cross-plane (planes: ${planes.join(', ') || 'none'})`);
  const allPass = planes.length > 0 && planes.every((p) => verdicts[p] === 'PASS');

  // Quorum: the collection can carry REDUNDANT actors per plane (each independently ran + returned the SAME
  // dispatched benchmark). The cross-plane verdict dedups to one representative per plane for the compare, but
  // every extra actor is an INDEPENDENT corroboration -- surface the per-plane actor roster + count so N>2
  // redundant actors are VISIBLE (not silently dropped). Each rostered actor already passed the per-receipt guards
  // above (trend/plane/identity/verdict), so a plane with count>=2 is corroborated by >=2 agreeing actors.
  const quorum = { perPlane: {}, minActorsPerPlane: 0, redundant: false };
  for (const p of planes) {
    const roster = actorsByPlane.get(p) ?? [];
    quorum.perPlane[p] = { actors: roster.map((a) => a.actorId), count: roster.length, meansMs: roster.map((a) => a.meanMs) };
  }
  quorum.minActorsPerPlane = planes.length ? Math.min(...planes.map((p) => quorum.perPlane[p].count)) : 0;
  quorum.redundant = quorum.minActorsPerPlane >= 2; // every corroborated plane independently confirmed by >= 2 actors

  // Compare (REUSE compareRuns): pair LINUX (baseline) + WIN (candidate) when both are present.
  let comparison = null;
  const linux = byPlane.get('LINUX');
  const win = byPlane.get('WIN');
  if (linux && win) comparison = compareRuns(benchmarkId || linux.workload, trendMetrics(linux), trendMetrics(win));

  const corroborated = findings.length === 0;
  const report = {
    schema: REPORT_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    dispatchId: collection?.dispatchId ?? null,
    identity,
    planes,
    corroboration: { crossPlane, allPass, identityBound, verdicts, quorum },
    comparison,
    corroborated,
  };
  return { ok: corroborated, findings, planes, corroboration: report.corroboration, comparison, report };
}

// CLI: meshCorroborate.mjs --collection <receipt-collection.json> [--benchmark-id <id>] [--out <report.json>]
function main() {
  const argv = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  }
  if (typeof opt.collection !== 'string') {
    console.error('usage: meshCorroborate.mjs --collection <receipt-collection.json> [--benchmark-id <id>] [--out <report.json>]');
    process.exit(2);
  }
  const collection = JSON.parse(readFileSync(opt.collection, 'utf8'));
  const r = corroborateRun({ collection, benchmarkId: typeof opt['benchmark-id'] === 'string' ? opt['benchmark-id'] : undefined });
  if (typeof opt.out === 'string') writeFileSync(opt.out, JSON.stringify(r.report, null, 2) + '\n');
  if (!r.ok) {
    console.error(`[mesh-corroborate] FAIL (dispatch ${collection?.dispatchId})`);
    for (const f of r.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  const d = r.comparison?.deltas?.latest;
  const deltaLine = d ? ` | latest WIN-LINUX = ${d.delta}ms (${d.pctOfLinux}% of LINUX)` : '';
  console.log(`[mesh-corroborate] OK ${REQUIREMENT}: cross-plane corroborated across [${r.planes.join(', ')}] -- all PASS, identity-bound to dispatch ${collection.dispatchId}${deltaLine}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
