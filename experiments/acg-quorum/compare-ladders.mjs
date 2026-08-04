#!/usr/bin/env node
// compare-ladders.mjs -- ACG benchmark-VARIATION corroboration (LBA-REQ-024 lineage; the best-effort successor
// to the deterministic screenshot-hash quorum in compare-witnesses.mjs). Ingests N throughput-ladder-receipt@v1
// (one per witness), aligns the rungs, and emits a corroboration verdict: the witnesses CORROBORATE when they
// span DISTINCT enrolled environments (ADR-0017) AND every shared rung's cross-witness throughput agrees within
// a tolerance band (default 20% coefficient-of-variation). It ALWAYS reports the measured variation (per-rung
// cross-witness mean / stddev / CoV) -- real disk benchmarks VARY run-to-run and box-to-box, so the value is the
// quantified spread, best-effort, NOT byte-identity. Dependency-free (Node builtins only).

import { readFileSync } from 'node:fs';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/throughput-ladder-receipt@v1';
export const VERDICT_SCHEMA = 'labview-benchmark-actor/acg-throughput-corroboration-v1';
export const DEFAULT_TOLERANCE_PCT = 20;

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const stddev = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(a.length - 1, 1)); };
const round = (x, n = 2) => Math.round(x * 10 ** n) / 10 ** n;

// Ingest N ladder receipts -> the corroboration verdict over the rungs common to ALL witnesses.
export function compareLadders(receipts, { tolerancePct = DEFAULT_TOLERANCE_PCT } = {}) {
  if (!Array.isArray(receipts) || receipts.length < 2) {
    return { schema: VERDICT_SCHEMA, verdict: 'error', reason: 'a corroboration needs at least two witness ladders', witnesses: receipts?.length ?? 0 };
  }
  const rungSets = receipts.map((r) => new Set((r.rungs || []).map((x) => x.bytes)));
  const common = [...rungSets[0]].filter((b) => rungSets.every((s) => s.has(b)));
  const planes = receipts.map((r) => `${r.plane}/${r.os ?? '?'}`);
  const distinctEnvironments = new Set(planes).size >= 2;

  const rungs = common.map((bytes) => {
    const perWitness = receipts.map((r) => ({ plane: r.plane, mbps: (r.rungs.find((x) => x.bytes === bytes) || {}).meanMbps }));
    const vals = perWitness.map((w) => w.mbps).filter((v) => typeof v === 'number');
    const m = mean(vals), sd = stddev(vals), cov = m ? (sd / m) * 100 : 0;
    return {
      bytes,
      witnessMbps: Object.fromEntries(perWitness.map((w) => [w.plane, w.mbps])),
      crossMeanMbps: round(m, 1),
      crossStddevMbps: round(sd, 2),
      crossCovPct: round(cov),
      spreadPct: round(vals.length ? ((Math.max(...vals) - Math.min(...vals)) / m) * 100 : 0),
      corroborated: cov <= tolerancePct,
    };
  });

  const allCorroborate = rungs.length > 0 && rungs.every((r) => r.corroborated);
  const pass = distinctEnvironments && allCorroborate;
  return {
    schema: VERDICT_SCHEMA,
    verdict: pass ? 'pass' : 'fail',
    tolerancePct,
    witnesses: receipts.length,
    planes,
    distinctEnvironments,
    commonRungs: common,
    rungs,
    maxCrossCovPct: rungs.length ? round(Math.max(...rungs.map((r) => r.crossCovPct))) : null,
    reason: pass
      ? `all ${rungs.length} rung(s) corroborate within ${tolerancePct}% across ${receipts.length} distinct witnesses`
      : !distinctEnvironments ? 'the witnesses are not distinct enrolled environments (no N-of-a-kind, ADR-0017)'
        : rungs.length === 0 ? 'no rungs are common to all witnesses'
          : `${rungs.filter((r) => !r.corroborated).length} rung(s) exceed the ${tolerancePct}% tolerance`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let tol = DEFAULT_TOLERANCE_PCT;
  const paths = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--tolerance') tol = Number(args[(i += 1)]);
    else paths.push(args[i]);
  }
  if (paths.length < 2) { console.error('usage: compare-ladders.mjs [--tolerance 20] <ladder.json> <ladder.json> [...]'); process.exit(2); }
  const receipts = paths.map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const out = compareLadders(receipts, { tolerancePct: tol });
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.verdict === 'pass' ? 0 : 1);
}
