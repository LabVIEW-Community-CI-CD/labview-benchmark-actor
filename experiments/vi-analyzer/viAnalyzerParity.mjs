#!/usr/bin/env node
// viAnalyzerParity.mjs -- cross-plane VI Analyzer PERFORMANCE PARITY (LBA-REQ-081, realizes ADR-0062). The second
// real benchmark family to join the cross-plane parity suite (roadmap Phase 2), after the launch benchmark
// (LBA-REQ-072). It REUSES the launch-parity engine's benchmark-generic core -- `launchIdentity` (the
// machine-independent identity over { metric, workload, n }), `trendOk`, `decideParity`, `planeSummary`,
// `performanceWitness` -- proving that engine is NOT launch-specific.
//
// It is distinct from, and complements, LBA-REQ-043 (cross-plane VI Analyzer DETERMINISM -- the resultHash is
// identical across planes, i.e. the ANSWER matches): this proves the two planes ran the SAME benchmark identity
// so their RUN TIMES are comparable performance witnesses, AND folds in the resultHash equivalence -- so a run is
// parity-proven only when the planes share both the benchmark identity and the deterministic result. Grounded in
// the real committed `vi-analyzer-trend-live-evidence@1` captures (LINUX + WIN); pure, rg-free, offline: the
// committed parity receipt re-derives byte-stably from the two evidence files. Fails closed on an identity
// mismatch, a non-cross-plane pair, a differing resultHash, an invalid trend, or a tampered digest.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { launchIdentity, trendOk, decideParity, planeSummary, performanceWitness, TREND_SCHEMA } from '../launch-parity/launchParity.mjs';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/cross-plane-vi-analyzer-parity-receipt@1';
export const EVIDENCE_SCHEMA = 'labview-benchmark-actor/vi-analyzer-trend-live-evidence@1';
export const REQUIREMENT = 'LBA-REQ-081';
export const ADR = 'ADR-0062';

// The VI Analyzer benchmark workload identity: the shipped NI LabVIEWCLIExampleProject config (3 VIs -> 69 tests),
// run through `LabVIEWCLI RunVIAnalyzer`. Both planes run this same config, so the { metric, workload, n } identity
// matches while the run time is plane-dependent.
export const VI_ANALYZER_METRIC = 'viAnalyzerMs';
export const VI_ANALYZER_WORKLOAD = 'vi-analyzer-labviewcli-example';

const round1 = (x) => Math.round(x * 10) / 10;

// Descriptive stats over the per-run wall times (population stddev, matching the launch-trend fixtures' shape).
export function computeStats(values) {
  const n = values.length;
  if (n === 0) return { min: null, max: null, mean: NaN, median: null, stddev: null, spread: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return { min: sorted[0], max: sorted[n - 1], mean: round1(mean), median: round1(median), stddev: round1(Math.sqrt(variance)), spread: sorted[n - 1] - sorted[0] };
}

// Adapt a committed vi-analyzer-trend-live-evidence@1 capture into a workload-trend@1 (the shape the launch-parity
// engine consumes): the per-run wall times become the trend values, PASS iff every run exited 0 with no
// failed/errored tests. Carries the evidence's deterministic resultHash for the determinism cross-check.
export function trendFromEvidence(evidence) {
  const runs = Array.isArray(evidence?.runs) ? evidence.runs : [];
  const values = runs.map((r) => r.wallMs);
  const allPass = runs.length > 0 && runs.every((r) => r.exit === 0 && r?.summary?.failed === 0 && r?.summary?.error === 0);
  return {
    schema: TREND_SCHEMA,
    metric: VI_ANALYZER_METRIC,
    workload: VI_ANALYZER_WORKLOAD,
    plane: evidence?.cleanroom?.plane,
    hypervisor: evidence?.cleanroom?.hypervisor ?? null,
    n: values.length,
    values,
    stats: computeStats(values),
    resultHash: evidence?.determinism?.resultHash ?? null,
    verdict: allPass ? 'PASS' : 'FAIL',
  };
}

function canonical(receipt) {
  return JSON.stringify({
    schema: receipt.schema, requirement: receipt.requirement, adr: receipt.adr,
    benchmark: receipt.benchmark ?? null,
    benchmarkIdentity: receipt.benchmarkIdentity ?? null,
    planes: { LINUX: receipt.planes?.LINUX ?? null, WIN: receipt.planes?.WIN ?? null },
    determinism: receipt.determinism ?? null,
    parity: receipt.parity ?? null,
    performance: receipt.performance ?? null,
    verdict: { parityProven: receipt.verdict?.parityProven },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build a cross-plane VI Analyzer parity receipt from a LINUX + a WIN vi-analyzer-trend-live-evidence@1 capture.
export function buildReceipt({ linuxEvidence, winEvidence } = {}) {
  const linux = trendFromEvidence(linuxEvidence);
  const win = trendFromEvidence(winEvidence);
  const d = decideParity({ linux, win });
  const benchmark = { metric: VI_ANALYZER_METRIC, workload: VI_ANALYZER_WORKLOAD, n: linux.n };
  const resultHashMatch = typeof linux.resultHash === 'string' && linux.resultHash.length > 0 && linux.resultHash === win.resultHash;
  const parityProven = d.parityProven && resultHashMatch;
  const receipt = {
    schema: RECEIPT_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    benchmark,
    benchmarkIdentity: launchIdentity(benchmark),
    planes: { LINUX: d.lok ? planeSummary(linux) : null, WIN: d.wok ? planeSummary(win) : null },
    determinism: { linuxResultHash: linux.resultHash ?? null, winResultHash: win.resultHash ?? null, resultHashMatch },
    parity: { crossPlane: d.crossPlane, identityMatch: d.identityMatch, resultHashMatch, parityProven },
    performance: d.lok && d.wok ? performanceWitness(linux, win) : null,
    verdict: {
      parityProven,
      reason: parityProven
        ? `LINUX and WIN ran the same VI Analyzer benchmark (${benchmark.metric} / ${benchmark.workload} / n=${benchmark.n}; identical resultHash ${String(linux.resultHash).slice(0, 12)}); run times are comparable performance witnesses (LINUX median ${planeSummary(linux).medianMs} ms vs WIN median ${planeSummary(win).medianMs} ms)`
        : (!d.parityProven
          ? 'parity not proven: ' + d.reasons.join('; ')
          : 'the planes produced different VI Analyzer resultHashes -- not the same deterministic analysis'),
    },
  };
  receipt.digest = digestReceipt(receipt);
  return receipt;
}

// Validate a committed parity receipt against the committed evidence: schema/requirement/adr, it re-derives
// byte-stably from the two evidence files (currency), and the digest re-derives. Fail-closed.
export function validateReceipt(receipt, ctx = {}) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (receipt?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (receipt?.adr !== ADR) findings.push(`adr must be ${ADR}`);
  if (ctx.linuxEvidence && ctx.winEvidence) {
    if (ctx.linuxEvidence.schema !== EVIDENCE_SCHEMA || ctx.winEvidence.schema !== EVIDENCE_SCHEMA) findings.push(`evidence must be ${EVIDENCE_SCHEMA}`);
    else {
      const rebuilt = buildReceipt(ctx);
      if (JSON.stringify(receipt) !== JSON.stringify(rebuilt)) findings.push('receipt is stale vs the committed evidence (re-derive mismatch)');
    }
  }
  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match (tampered)');
  return { ok: findings.length === 0, proofOk: receipt?.verdict?.parityProven === true && findings.length === 0, findings };
}

// Read the two committed vi-analyzer-trend-live-evidence@1 captures (offline) into a decision context.
export function committedContext(here) {
  const read = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
  return {
    linuxEvidence: read('vi-analyzer-trend-live-evidence.json'),
    winEvidence: read('vi-analyzer-trend-live-evidence-WIN.json'),
  };
}

// CLI: validate the committed VI Analyzer parity receipt against the committed evidence (offline, deterministic).
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const ctx = committedContext(here);
  const receipt = JSON.parse(readFileSync(join(here, 'cross-plane-vi-analyzer-parity-receipt.json'), 'utf8'));
  const r = validateReceipt(receipt, ctx);
  if (!r.ok || !r.proofOk) {
    console.error('[cross-plane-vi-analyzer-parity] FAIL');
    for (const f of r.findings) console.error(`  - ${f}`);
    if (r.ok && !r.proofOk) console.error(`  - not parity-proven: ${receipt.verdict?.reason}`);
    process.exit(1);
  }
  const p = receipt.performance;
  console.log(`[cross-plane-vi-analyzer-parity] OK ${REQUIREMENT}: same VI Analyzer benchmark ${String(receipt.benchmarkIdentity).slice(0, 12)} across LINUX+WIN (resultHash ${String(receipt.determinism.linuxResultHash).slice(0, 12)}); LINUX ${p.linuxMeanMs} ms vs WIN ${p.winMeanMs} ms mean`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
