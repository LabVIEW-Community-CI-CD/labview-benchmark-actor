#!/usr/bin/env node
// launchParity.mjs -- cross-plane launch-benchmark PARITY builder + validator (LBA-REQ-072, realizes ADR-0053).
//
// The flagship exact-12-FPS "launch-to-ready" benchmark (`workload-trend@1`, metric launchMs) measures a
// quantity that is INHERENTLY plane-dependent -- the Linux golden VM launches LabVIEW in ~2604 ms, the Windows
// one in ~2410 ms. So unlike the mprr ring-buffer parity (LBA-REQ-014, where the deterministic memory SERIES is
// byte-identical across planes and its seriesHash is the anchor), a launch benchmark's cross-plane identity is
// NOT the measured series -- it is the benchmark SPEC: what was measured + how (the `metric` + the `workload` +
// the sample count `n`). Two planes running the SAME launch benchmark share this machine-independent identity,
// which is exactly what makes their plane-specific timings legitimately comparable.
//
// This engine takes a LINUX launch-trend receipt + a WIN launch-trend receipt and proves PARITY: both are valid
// `workload-trend@1`, they are cross-plane (one LINUX + one WIN), and their launch identity matches (the same
// benchmark). The plane-specific timing (mean/median/values) + the delta are recorded as PERFORMANCE WITNESSES,
// never part of the identity. Pure + rg-free + offline: a committed receipt re-derives its identity + verdict +
// digest byte-stably in CI. Fails closed on an identity mismatch (a different metric/workload/sample-count = a
// different benchmark), a non-cross-plane pair, an invalid trend, a forged verdict, or a tampered digest.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/cross-plane-launch-parity-receipt@1';
export const TREND_SCHEMA = 'labview-benchmark-actor/workload-trend@1';
export const REQUIREMENT = 'LBA-REQ-072';
export const ADR = 'ADR-0053';

// The machine-independent launch benchmark IDENTITY: what was measured (metric) + the workload + the sample
// count. Deliberately EXCLUDES the plane-dependent timing (values/stats), the plane, and the hypervisor.
export function launchIdentity(spec) {
  const canon = JSON.stringify({
    metric: spec?.metric ?? null,
    workload: spec?.workload ?? null,
    n: Number.isFinite(spec?.n) ? spec.n : null,
  });
  return createHash('sha256').update(canon).digest('hex');
}

// A launch-trend receipt is well-formed iff it is a workload-trend@1 with a metric + workload + a positive
// sample count + a finite mean + a verdict.
export function trendOk(t) {
  return !!t && t.schema === TREND_SCHEMA
    && typeof t.metric === 'string' && t.metric.length > 0
    && typeof t.workload === 'string' && t.workload.length > 0
    && Number.isFinite(t.n) && t.n > 0
    && !!t.stats && Number.isFinite(t.stats.mean)
    && typeof t.verdict === 'string' && t.verdict.length > 0
    && (t.plane === 'LINUX' || t.plane === 'WIN');
}

// The machine-independent identity + the plane-specific performance witnesses for one plane.
export function planeSummary(t) {
  return {
    plane: t.plane,
    hypervisor: t.hypervisor ?? null,
    n: t.n,
    meanMs: t.stats.mean,
    medianMs: Number.isFinite(t.stats.median) ? t.stats.median : null,
    verdict: t.verdict,
    identity: launchIdentity(t),
  };
}

// Round to 1 decimal (the launch trends report tenths of a ms).
const round1 = (x) => Math.round(x * 10) / 10;

// Plane-specific performance witnesses (NOT identity): the two means, their signed delta (WIN - LINUX), the
// delta as a percentage of the LINUX mean, and which plane launched faster.
export function performanceWitness(linux, win) {
  const l = linux.stats.mean;
  const w = win.stats.mean;
  const deltaMs = round1(w - l);
  return {
    linuxMeanMs: round1(l),
    winMeanMs: round1(w),
    deltaMs,
    pctOfLinux: l ? round1((deltaMs / l) * 100) : null,
    fasterPlane: w < l ? 'WIN' : (l < w ? 'LINUX' : 'tie'),
  };
}

// Decide parity over two trend receipts: both valid, cross-plane (one LINUX + one WIN), identities match.
export function decideParity({ linux, win }) {
  const reasons = [];
  const lok = trendOk(linux);
  const wok = trendOk(win);
  if (!lok) reasons.push('the LINUX receipt is not a valid workload-trend@1 (LINUX plane, metric/workload/n/stats.mean/verdict)');
  if (!wok) reasons.push('the WIN receipt is not a valid workload-trend@1 (WIN plane, metric/workload/n/stats.mean/verdict)');
  const crossPlane = linux?.plane === 'LINUX' && win?.plane === 'WIN';
  if (!crossPlane) reasons.push('need one LINUX-plane receipt and one WIN-plane receipt (cross-plane)');
  const identityMatch = lok && wok && launchIdentity(linux) === launchIdentity(win);
  if (lok && wok && !identityMatch) reasons.push('the launch identity (metric + workload + sample count) differs -- these are not the same benchmark, so their timings are not comparable');
  const parityProven = lok && wok && crossPlane && identityMatch;
  return { lok, wok, crossPlane, identityMatch, parityProven, reasons };
}

// Digest over the verdict-bearing fields (the spec, the identity, both plane identities + verdicts, the parity
// flags, and the aggregate verdict) -- NOT the descriptive prose. The performance witnesses are included because
// they are a claim the receipt makes about the two planes.
function canonical(receipt) {
  return JSON.stringify({
    schema: receipt.schema,
    requirement: receipt.requirement,
    adr: receipt.adr,
    benchmark: receipt.benchmark ?? null,
    launchIdentity: receipt.launchIdentity ?? null,
    planes: {
      LINUX: receipt.planes?.LINUX ?? null,
      WIN: receipt.planes?.WIN ?? null,
    },
    parity: receipt.parity ?? null,
    performance: receipt.performance ?? null,
    verdict: { parityProven: receipt.verdict?.parityProven },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build a cross-plane launch-parity receipt from a LINUX + a WIN launch-trend receipt.
export function buildReceipt({ linux, win } = {}) {
  const d = decideParity({ linux, win });
  const benchmark = d.lok ? { metric: linux.metric, workload: linux.workload, n: linux.n } : { metric: linux?.metric ?? null, workload: linux?.workload ?? null, n: linux?.n ?? null };
  const receipt = {
    schema: RECEIPT_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    benchmark,
    launchIdentity: launchIdentity(benchmark),
    planes: {
      LINUX: d.lok ? planeSummary(linux) : null,
      WIN: d.wok ? planeSummary(win) : null,
    },
    parity: { crossPlane: d.crossPlane, identityMatch: d.identityMatch, parityProven: d.parityProven },
    performance: d.lok && d.wok ? performanceWitness(linux, win) : null,
    verdict: {
      parityProven: d.parityProven,
      reason: d.parityProven
        ? `LINUX and WIN measured the same launch benchmark (${benchmark.metric} / ${benchmark.workload} / n=${benchmark.n}); timings are comparable (LINUX ${round1(linux.stats.mean)} ms vs WIN ${round1(win.stats.mean)} ms)`
        : ('parity not proven: ' + d.reasons.join('; ')),
    },
  };
  receipt.digest = digestReceipt(receipt);
  return receipt;
}

// Validate a committed receipt: schema/requirement/adr, the launch identity re-derives + both planes carry it,
// the parity decision is consistent, the performance witnesses are self-consistent, the verdict matches the
// rule, and the digest re-derives. Fail-closed.
export function validateReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (receipt?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (receipt?.adr !== ADR) findings.push(`adr must be ${ADR}`);

  const expectedIdentity = launchIdentity(receipt?.benchmark);
  if (receipt?.launchIdentity !== expectedIdentity) findings.push('launchIdentity does not match the benchmark spec (metric + workload + n)');

  const l = receipt?.planes?.LINUX;
  const w = receipt?.planes?.WIN;
  if (!l || l.plane !== 'LINUX') findings.push('planes.LINUX must be a LINUX plane summary');
  if (!w || w.plane !== 'WIN') findings.push('planes.WIN must be a WIN plane summary');
  if (l && l.identity !== expectedIdentity) findings.push('planes.LINUX.identity does not match the launch identity');
  if (w && w.identity !== expectedIdentity) findings.push('planes.WIN.identity does not match the launch identity');

  const crossPlane = l?.plane === 'LINUX' && w?.plane === 'WIN';
  const identityMatch = !!l && !!w && l.identity === expectedIdentity && w.identity === expectedIdentity;
  const parityProven = crossPlane && identityMatch && findings.length === 0;
  if (receipt?.parity?.crossPlane !== crossPlane) findings.push(`parity.crossPlane=${receipt?.parity?.crossPlane} contradicts the receipt (${crossPlane})`);
  if (receipt?.parity?.identityMatch !== identityMatch) findings.push(`parity.identityMatch=${receipt?.parity?.identityMatch} contradicts the receipt (${identityMatch})`);

  // the performance witnesses must be self-consistent with the plane means
  if (l && w && receipt?.performance) {
    const p = receipt.performance;
    const expectedDelta = round1(w.meanMs - l.meanMs);
    if (round1(p.linuxMeanMs) !== round1(l.meanMs)) findings.push('performance.linuxMeanMs does not match planes.LINUX.meanMs');
    if (round1(p.winMeanMs) !== round1(w.meanMs)) findings.push('performance.winMeanMs does not match planes.WIN.meanMs');
    if (round1(p.deltaMs) !== expectedDelta) findings.push('performance.deltaMs is not WIN mean - LINUX mean');
  }

  if (receipt?.verdict?.parityProven !== (crossPlane && identityMatch)) {
    findings.push(`verdict.parityProven=${receipt?.verdict?.parityProven} contradicts the rule (${crossPlane && identityMatch})`);
  }
  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, proofOk: !!receipt?.verdict?.parityProven && findings.length === 0, findings };
}

// CLI: validate the committed receipt next to this module (offline, deterministic). Exit 1 on any finding.
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const receiptPath = join(here, 'cross-plane-launch-parity-receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const result = validateReceipt(receipt);
  if (!result.ok) {
    console.error(`[cross-plane-launch-parity] FAIL ${receiptPath}`);
    for (const f of result.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  const p = receipt.performance;
  console.log(`[cross-plane-launch-parity] OK ${REQUIREMENT}: ${receipt.benchmark.metric}/${receipt.benchmark.workload} n=${receipt.benchmark.n} -- LINUX ${p.linuxMeanMs} ms vs WIN ${p.winMeanMs} ms (${p.fasterPlane} faster by ${Math.abs(p.deltaMs)} ms); parity proven=${result.proofOk}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
