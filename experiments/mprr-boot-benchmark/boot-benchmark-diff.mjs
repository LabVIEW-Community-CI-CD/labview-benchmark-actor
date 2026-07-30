// boot-benchmark-diff.mjs — cross-iteration diff of two SEALED boot-benchmark-v1 records (the WIN consumer
// side of the deterministic-record seam, for the boot-as-benchmark sibling).
//
// TWO layers, per the LINUX<->WIN design:
//   1. TIMING = the HARD GATE. Pairs spans by id and compares durations. A span is compared ONLY when its
//      comparison SCOPE allows it: guest-clock spans (buildMs, meshFormMs; scope 'cross-plane') are always
//      comparable; the host-clock span (bootToMeshMs; scope 'within-plane') includes hypervisor firmware, so
//      the diff REFUSES to compare it across different hypervisors ('incomparable-cross-plane'). A comparable
//      span slower than baseline beyond the tolerance is a REGRESSION -> the gate FAILS.
//   2. VISUAL = a WITNESS (not the gate). Reuses frame-diff.mjs (pairs milestone `settled` frames by caseId +
//      the shared dhash-64 Hamming + the fingerprintAlgo/spec guards), re-scored against each milestone's own
//      `visual.perMilestone.hammingTolerance`. Because raw pixels are discarded on seal, a declared `roiMask`
//      cannot be applied post-seal (the fingerprint is whole-frame); it is surfaced as declared-only.
//
// Overall verdict = the TIMING gate (visual only contributes if the record sets visual.gated=true).
//
//   import { bootBenchmarkDiff } from './boot-benchmark-diff.mjs'
//   node experiments/mprr-boot-benchmark/boot-benchmark-diff.mjs <recordA.json> <recordB.json> [timingToleranceMs]

import { readFileSync } from 'node:fs';
import { frameDiff } from '../manual-procedure-record/frame-diff.mjs';

const BOOT_SCHEMA = 'labview-benchmark-actor/boot-benchmark-v1';

function assertBootRecord(r, which) {
  if (!r || r.schema !== BOOT_SCHEMA) {
    throw new Error(`boot-benchmark-diff: ${which} is not a ${BOOT_SCHEMA} record (got ${r?.schema ?? 'null'})`);
  }
}

function spansById(record) {
  const m = new Map();
  for (const s of record.spans ?? []) m.set(s.id, s);
  return m;
}

function visualPolicyFor(record, caseId, fallback) {
  const pm = record.visual?.perMilestone?.find((p) => p.caseId === caseId);
  return { tolerance: Number.isInteger(pm?.hammingTolerance) ? pm.hammingTolerance : fallback, roiMask: pm?.roiMask ?? null };
}

/**
 * Cross-iteration diff of two sealed boot-benchmark-v1 records.
 * @param {object} recordA sealed boot-benchmark-v1 (baseline iteration)
 * @param {object} recordB sealed boot-benchmark-v1 (candidate iteration)
 * @param {{timingToleranceMs?:number, visualThreshold?:number}} [options]
 *   timingToleranceMs: max |Δ| before a comparable span is a regression/improvement (default 2000).
 *   visualThreshold: fallback Hamming tolerance when a milestone has no visual.perMilestone entry (default 10).
 * @returns {object} the diff report ({ verdict, timing, visual, crossPlane, ... }).
 */
export function bootBenchmarkDiff(recordA, recordB, options = {}) {
  assertBootRecord(recordA, 'recordA');
  assertBootRecord(recordB, 'recordB');

  const timingToleranceMs = Number.isFinite(options.timingToleranceMs) ? options.timingToleranceMs : 2000;
  const visualFallback = Number.isInteger(options.visualThreshold) ? options.visualThreshold : 10;
  const crossPlane = recordA.hypervisor !== recordB.hypervisor;

  // ---- 1) TIMING — the hard gate (scope decides comparability) ----
  const spansA = spansById(recordA);
  const spansB = spansById(recordB);
  const spanIds = [...new Set([...spansA.keys(), ...spansB.keys()])].sort();
  const spans = [];
  for (const id of spanIds) {
    const sa = spansA.get(id);
    const sb = spansB.get(id);
    if (!sa || !sb) { spans.push({ id, status: sa ? 'only-in-A' : 'only-in-B', deltaMs: null }); continue; }
    // A within-plane (host-clock) span across DIFFERENT hypervisors is comparing firmware, not the build.
    if (crossPlane && (sa.scope === 'within-plane' || sb.scope === 'within-plane')) {
      spans.push({ id, clock: sa.clock, scope: sa.scope, msA: sa.ms, msB: sb.ms, deltaMs: null, status: 'incomparable-cross-plane' });
      continue;
    }
    const deltaMs = sb.ms - sa.ms;
    const status = deltaMs > timingToleranceMs ? 'regressed' : deltaMs < -timingToleranceMs ? 'improved' : 'match';
    spans.push({ id, clock: sa.clock, scope: sa.scope, msA: sa.ms, msB: sb.ms, deltaMs, toleranceMs: timingToleranceMs, status });
  }
  const regressed = spans.filter((s) => s.status === 'regressed').map((s) => s.id);
  const improved = spans.filter((s) => s.status === 'improved').map((s) => s.id);
  const structural = spans.filter((s) => s.status === 'only-in-A' || s.status === 'only-in-B').map((s) => s.id);
  // A regression OR a vanished span fails the gate (can't confirm no regression if a span disappeared).
  const timingVerdict = regressed.length === 0 && structural.length === 0 ? 'TIMING_OK' : 'TIMING_REGRESSION';

  // ---- 2) VISUAL — witness only (reuse frame-diff pairing + Hamming + algo/spec guards) ----
  // A huge base threshold means frame-diff just hands back the raw per-case Hamming; we re-score per milestone.
  const visualBase = frameDiff(recordA, recordB, { threshold: Number.MAX_SAFE_INTEGER });
  let roiMaskDeclared = false;
  const perMilestone = visualBase.perCase.map((c) => {
    if (c.hamming === null) return { caseId: c.caseId, status: c.status, hamming: null };
    const { tolerance, roiMask } = visualPolicyFor(recordB, c.caseId, visualFallback);
    if (roiMask) roiMaskDeclared = true;
    return {
      caseId: c.caseId,
      hamming: c.hamming,
      tolerance,
      status: c.hamming > tolerance ? 'witness-delta' : 'witness-match',
      roiMaskDeclared: Boolean(roiMask),
    };
  });
  const visualDeltas = perMilestone.filter((p) => p.status === 'witness-delta').map((p) => p.caseId);
  const visualStructural = perMilestone.some((p) => p.status === 'only-in-A' || p.status === 'only-in-B');
  const visualVerdict = visualDeltas.length === 0 && !visualStructural ? 'WITNESS_MATCH' : 'WITNESS_DELTA';

  // ---- overall = the TIMING hard gate; visual only bites if the record opts in (visual.gated) ----
  const gated = Boolean(recordA.visual?.gated && recordB.visual?.gated);
  const verdict = timingVerdict === 'TIMING_OK' && (!gated || visualVerdict === 'WITNESS_MATCH') ? 'PASS' : 'REGRESSION';

  return {
    schema: 'labview-benchmark-actor/boot-benchmark-diff@1',
    iterationA: recordA.iteration ?? null,
    iterationB: recordB.iteration ?? null,
    crossPlane,
    hypervisorA: recordA.hypervisor ?? null,
    hypervisorB: recordB.hypervisor ?? null,
    timing: { toleranceMs: timingToleranceMs, spans, regressed, improved, incomparable: spans.filter((s) => s.status === 'incomparable-cross-plane').map((s) => s.id), structural, verdict: timingVerdict },
    visual: {
      gated,
      perMilestone,
      deltas: visualDeltas,
      verdict: visualVerdict,
      ...(roiMaskDeclared ? { note: 'roiMask is declared but applied at SEAL time (raw pixels discarded); this witness Hamming is whole-frame.' } : {}),
    },
    verdict,
  };
}

// CLI: node boot-benchmark-diff.mjs a.json b.json [timingToleranceMs]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const [a, b, t] = process.argv.slice(2);
  if (!a || !b) {
    console.error('usage: node boot-benchmark-diff.mjs <recordA.json> <recordB.json> [timingToleranceMs]');
    process.exit(2);
  }
  const report = bootBenchmarkDiff(
    JSON.parse(readFileSync(a, 'utf8')),
    JSON.parse(readFileSync(b, 'utf8')),
    { timingToleranceMs: t ? Number.parseInt(t, 10) : undefined },
  );
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === 'PASS' ? 0 : 1);
}
