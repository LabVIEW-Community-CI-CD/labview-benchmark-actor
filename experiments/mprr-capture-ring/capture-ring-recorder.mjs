// capture-ring-recorder.mjs — RECORDER-AS-CONSUMER: reconstruct a boot-benchmark-v1-shaped record from the
// DECODED capture-ring frames (readCaptureFrames output). The milestone markers give guest-clock spans; the
// settled visual frame nearest each milestone gives a per-milestone visual pin. ONE builder serves BOTH the
// VM visual ring (dhash frames + markers) AND the container milestone-only stream (markers, no dhash -> spans
// only) — buildMs/meshFormMs stay guest-clock in both. The output feeds bootBenchmarkDiff (+ the #173
// per-span/witness tolerance) so a ring capture is diffable cross-plane like the bootbench record.

import { TICKS_PER_MS } from '../mprr-ring/mprrRing.mjs';
import { readCaptureFrames } from './capture-ring.mjs';
import { FINGERPRINT_ALGO, FINGERPRINT_SPEC_VERSION } from '../manual-procedure-record/fingerprint.mjs';

const BOOT_SCHEMA = 'labview-benchmark-actor/boot-benchmark-v1';
const TICKS_PER_MS_NUM = Number(TICKS_PER_MS);
const ticksToMs = (ticks) => Number(ticks) / TICKS_PER_MS_NUM;

// Guest-clock spans from milestone ticks. Durations (differences) are clock-offset-independent, so buildMs +
// meshFormMs are cross-plane comparable; bootToMeshMs is the full-boot span kept within-plane (not diffed
// across substrates), matching the boot-benchmark convention.
const SPAN_DEFS = [
  { id: 'buildMs', from: 'LBABUS-BUILD-START', to: 'LBABUS-BUILT', scope: 'cross-plane' },
  { id: 'meshFormMs', from: 'LBABUS-BUILT', to: 'MESH-OK', scope: 'cross-plane' },
  { id: 'bootToMeshMs', from: 'BOOT-START', to: 'MESH-OK', scope: 'within-plane' },
];

/**
 * Reconstruct a boot-benchmark-v1 record from decoded capture-ring frames.
 * @param {Array<object>} frames decoded frames: { timingTicks64:bigint, frameIndex, dhash64, dhashHex, milestoneId, caseId, settled, hasFrame }
 * @param {{iteration?:string, plane?:string, hypervisor?:string, substrate?:string, visualToleranceHamming?:number}} [meta]
 * @returns {object} an (unsealed) boot-benchmark-v1 record — spans + per-milestone visual pins.
 */
export function buildCaptureRecord(frames, meta = {}) {
  if (!Array.isArray(frames)) { throw new Error('capture-ring-recorder: frames array required'); }

  const milestoneTicks = new Map(); // caseId -> bigint ticks (FIRST occurrence; boot milestones fire once)
  const visualFrames = []; // { frameIndex, dhashHex, settled, ticks:bigint }
  for (const f of frames) {
    if (f.milestoneId > 0 && f.caseId && !milestoneTicks.has(f.caseId)) {
      milestoneTicks.set(f.caseId, f.timingTicks64);
    }
    if (f.hasFrame) {
      visualFrames.push({ frameIndex: f.frameIndex, dhashHex: f.dhashHex, settled: f.settled === true, ticks: f.timingTicks64 });
    }
  }

  const milestones = [...milestoneTicks.entries()]
    .map(([caseId, ticks]) => ({ caseId, ticks: ticks.toString(), ms: ticksToMs(ticks) }))
    .sort((a, b) => a.ms - b.ms);

  const spans = [];
  for (const def of SPAN_DEFS) {
    const a = milestoneTicks.get(def.from);
    const b = milestoneTicks.get(def.to);
    if (a === undefined || b === undefined) { continue; }
    spans.push({ id: def.id, ms: Math.round(ticksToMs(b) - ticksToMs(a)), clock: 'guest', scope: def.scope });
  }

  // Per-milestone visual pin: prefer a SETTLED visual frame, then the one nearest the milestone tick. Absent on
  // the container milestone-only path (no visual frames) -> frames[] empty, visual layer is a clean witness-match.
  const recordFrames = [];
  const perMilestone = [];
  if (visualFrames.length) {
    for (const [caseId, ticks] of milestoneTicks) {
      let best = null; let bestScore = Infinity;
      for (const v of visualFrames) {
        const score = (v.settled ? 0 : Number.MAX_SAFE_INTEGER) + Math.abs(Number(v.ticks - ticks));
        if (score < bestScore) { bestScore = score; best = v; }
      }
      if (best) {
        recordFrames.push({ caseId, counter: best.frameIndex, settled: true, perceptualFingerprint: best.dhashHex, fingerprintAlgo: FINGERPRINT_ALGO });
        perMilestone.push({ caseId, hammingTolerance: meta.visualToleranceHamming ?? 10 });
      }
    }
  }

  return {
    schema: BOOT_SCHEMA,
    source: 'capture-ring',
    iteration: meta.iteration ?? 'capture-ring',
    plane: meta.plane ?? null,
    hypervisor: meta.hypervisor ?? 'capture-ring',
    substrate: meta.substrate ?? null,
    fingerprintAlgo: FINGERPRINT_ALGO,
    fingerprintSpecVersion: FINGERPRINT_SPEC_VERSION,
    milestones,
    spans,
    frames: recordFrames,
    visual: { gated: false, perMilestone },
    counts: { frames: frames.length, visual: visualFrames.length, milestones: milestoneTicks.size },
  };
}

/** Convenience: drain [fromOffset, toOffset) off the ring and build the record. */
export function recordFromRing(ring, fromOffset, toOffset, meta = {}) {
  return buildCaptureRecord(readCaptureFrames(ring, fromOffset, toOffset), meta);
}
