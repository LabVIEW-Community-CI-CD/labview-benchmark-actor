#!/usr/bin/env node
// stressDiscountedComparison.mjs -- the STRESS-DISCOUNTED cross-plane comparison (LBA-REQ-084, realizes ADR-0065).
// The roadmap Phase-4 capability: "the mesh-stress-signature calibration lets a run DISCOUNT a result captured on
// a stressed actor." A benchmark captured on an actor under heavy CPU contention is not a fair sample -- its
// timing is inflated by the contention -- so a fair cross-plane comparison must weight it DOWN. This engine turns
// the governed mesh-stress calibration (LBA-REQ-032) into a stress-QUALITY weight per measured actor: the
// calibration independently RECOVERS each actor's stress level from its resource signature, and each measurement
// is assigned a monotonic quality weight (idle = full confidence 1.0 ... saturate = 0.0) and flagged DISCOUNTED
// when its inferred stress is heavy or above.
//
// This is a confidence/quality weight, NOT a fabricated millisecond correction -- it expresses how much a
// cross-plane comparison should trust each actor's result, grounded in the real committed calibration + concurrent
// captures. Pure + rg-free + offline: the committed comparison re-derives byte-stably from the two committed
// mesh-stress receipts. Fails closed on an invalid calibration, an actor the calibration could not recover, a
// weight/flag that does not match the rule, a miscounted coverage statistic, or a tampered digest.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/stress-discounted-comparison@1';
export const LADDER_SCHEMA = 'labview-benchmark-actor/mesh-stress-live-ladder@1';
export const CONCURRENT_SCHEMA = 'labview-benchmark-actor/mesh-concurrent-actors@1';
export const REQUIREMENT = 'LBA-REQ-084';
export const ADR = 'ADR-0065';

// The commanded stress ladder (idle .. saturate) -> level 0..4.
export const STRESS_LEVELS = Object.freeze({ idle: 0, light: 1, medium: 2, heavy: 3, saturate: 4 });
export const MAX_LEVEL = 4;
// At/above this inferred level a measurement is DISCOUNTED (the actor was too contended for a fair benchmark).
export const DISCOUNT_THRESHOLD = STRESS_LEVELS.heavy; // 3

const round2 = (x) => Math.round(x * 100) / 100;

// The stress-QUALITY weight for an inferred stress level: full confidence at idle, none at saturate (linear).
export function qualityWeight(level) {
  if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL) return null;
  return round2(1 - level / MAX_LEVEL);
}

export function isDiscounted(level) {
  return Number.isInteger(level) && level >= DISCOUNT_THRESHOLD;
}

// A calibration (the committed ladder) is TRUSTWORTHY when its stress ladder is monotone, separable, and
// repeatable -- the invariants the LBA-REQ-032 calibrator proves.
export function calibrationTrustworthy(ladder) {
  const inv = ladder?.invariants;
  return !!inv && inv.monotone === 1 && inv.separable === true && inv.repeatable === true;
}

function canonical(receipt) {
  return JSON.stringify({
    schema: receipt.schema, requirement: receipt.requirement, adr: receipt.adr,
    calibration: receipt.calibration ?? null,
    measurements: Array.isArray(receipt.measurements) ? receipt.measurements : null,
    coverage: receipt.coverage ?? null,
    verdict: { discountingApplied: receipt.verdict?.discountingApplied },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build a stress-discounted comparison from the committed ladder (the calibration authority) + the committed
// concurrent-actors capture (the independently-recovered per-actor stress). Each actor becomes a measurement with
// a stress-quality weight; stressed actors are discounted.
export function buildComparison({ ladder, concurrent } = {}) {
  const recovered = Array.isArray(concurrent?.perActorInverseRead) ? concurrent.perActorInverseRead : [];
  const byActorCpu = new Map((concurrent?.actors ?? []).map((a) => [a.actor, a.cpuPoolPctMean]));
  const measurements = recovered.map((r) => {
    const level = STRESS_LEVELS[r.inferredRung];
    return {
      actor: r.actor,
      commandedRung: r.commandedRung,
      inferredRung: r.inferredRung,
      inferredLevel: level ?? null,
      recovered: r.correct === true,
      observedCpuPoolPct: byActorCpu.has(r.actor) ? byActorCpu.get(r.actor) : null,
      qualityWeight: qualityWeight(level),
      discounted: isDiscounted(level),
    };
  }).sort((a, b) => String(a.actor).localeCompare(String(b.actor)));

  const cleanCount = measurements.filter((m) => !m.discounted).length;
  const discountedCount = measurements.filter((m) => m.discounted).length;
  const weights = measurements.map((m) => m.qualityWeight).filter((w) => Number.isFinite(w));
  const coverage = {
    measurements: measurements.length,
    recoveredCount: measurements.filter((m) => m.recovered).length,
    cleanCount,
    discountedCount,
    meanWeight: weights.length ? round2(weights.reduce((s, w) => s + w, 0) / weights.length) : null,
  };

  const calibration = {
    ladderSchema: ladder?.schema ?? null,
    trustworthy: calibrationTrustworthy(ladder),
    invariants: ladder?.invariants ?? null,
    allActorsRecovered: concurrent?.allActorsRecovered === true,
  };

  // Discounting is APPLIED when the calibration is trustworthy, every actor's stress was recovered, at least one
  // stressed (>= heavy) actor is discounted, and at least one low-stress actor is kept at full confidence.
  const applied = calibration.trustworthy
    && calibration.allActorsRecovered
    && measurements.length > 0
    && measurements.every((m) => m.recovered)
    && discountedCount >= 1
    && measurements.some((m) => m.qualityWeight === 1);

  const receipt = {
    schema: RECEIPT_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    calibration,
    measurements,
    coverage,
    verdict: {
      discountingApplied: applied,
      reason: applied
        ? `calibration recovered ${coverage.recoveredCount}/${coverage.measurements} actors; ${discountedCount} stressed measurement(s) discounted (weight <= ${qualityWeight(DISCOUNT_THRESHOLD)}), ${cleanCount} kept for a fair cross-plane comparison`
        : 'discounting not applied: calibration untrustworthy, an actor was not recovered, or no stressed/clean split',
    },
  };
  receipt.digest = digestReceipt(receipt);
  return receipt;
}

// Validate a committed comparison: it re-derives byte-stably from the committed ladder + concurrent receipts
// (currency + grounding), every weight/flag matches the rule, the coverage re-derives, and the digest re-derives.
// Fail-closed.
export function validateComparison(receipt, ctx = {}) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (receipt?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (receipt?.adr !== ADR) findings.push(`adr must be ${ADR}`);

  const measurements = Array.isArray(receipt?.measurements) ? receipt.measurements : [];
  if (measurements.length === 0) findings.push('the comparison has no measurements');
  measurements.forEach((m, i) => {
    if (m.qualityWeight !== qualityWeight(m.inferredLevel)) findings.push(`measurement[${i}] (${m.actor}) weight does not match its inferred stress level`);
    if (m.discounted !== isDiscounted(m.inferredLevel)) findings.push(`measurement[${i}] (${m.actor}) discounted flag does not match its inferred stress level`);
  });

  if (ctx.ladder && ctx.concurrent) {
    if (ctx.ladder.schema !== LADDER_SCHEMA) findings.push(`ladder must be ${LADDER_SCHEMA}`);
    if (ctx.concurrent.schema !== CONCURRENT_SCHEMA) findings.push(`concurrent capture must be ${CONCURRENT_SCHEMA}`);
    const rebuilt = buildComparison(ctx);
    if (JSON.stringify(receipt) !== JSON.stringify(rebuilt)) findings.push('comparison is stale vs the committed mesh-stress receipts (re-derive mismatch)');
  }

  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match (tampered)');
  return { ok: findings.length === 0, proofOk: receipt?.verdict?.discountingApplied === true && findings.length === 0, findings };
}

// Read the two committed mesh-stress receipts (offline) into a build context.
export function committedContext(here) {
  const read = (p) => JSON.parse(readFileSync(join(here, 'fixtures', p), 'utf8'));
  return {
    ladder: read('mesh-live-ladder-receipt.json'),
    concurrent: read('mesh-concurrent-actors-receipt.json'),
  };
}

// CLI: validate the committed stress-discounted comparison against the committed mesh-stress receipts.
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const ctx = committedContext(here);
  const receipt = JSON.parse(readFileSync(join(here, 'stress-discounted-comparison-receipt.json'), 'utf8'));
  const r = validateComparison(receipt, ctx);
  if (!r.ok || !r.proofOk) {
    console.error('[stress-discounted-comparison] FAIL');
    for (const f of r.findings) console.error(`  - ${f}`);
    if (r.ok && !r.proofOk) console.error(`  - discounting not applied: ${receipt.verdict?.reason}`);
    process.exit(1);
  }
  const c = receipt.coverage;
  console.log(`[stress-discounted-comparison] OK ${REQUIREMENT}: ${c.discountedCount}/${c.measurements} measurement(s) discounted for stress, ${c.cleanCount} kept (mean weight ${c.meanWeight}); calibration recovered ${c.recoveredCount}/${c.measurements}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
