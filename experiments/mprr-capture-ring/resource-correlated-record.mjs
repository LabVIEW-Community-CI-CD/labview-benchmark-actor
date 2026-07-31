// resource-correlated-record.mjs — seal a REAL LabVIEW-launch benchmark together with its LIVE CPU/RAM/disk
// resource correlation (LBA-REQ-011 live). Composes the visual-ring workload record (launchMs + the UI-READY
// settle instant) with the resource-usage correlation core: the settle instant is the TRIGGER, so the pre/post
// windows read the machine load WHILE LAUNCHING (pre) vs ONCE THE IDE IS READY / SETTLED (post) — the launch's
// resource cost, on the same epoch-ms/frame axis as the captured frames.
//
// Pure + deterministic (the live sampling + capture live in the orchestrator): same samples + params -> same
// record, so the sealed record is a re-runnable local-gate artifact (the gate re-derives the windows).

import { buildResourceUsageCorrelation } from '../resource-usage-correlation/resourceUsageCorrelation.mjs';

export const RESOURCE_CORRELATED_LAUNCH_SCHEMA = 'labview-benchmark-actor/resource-correlated-launch@1';

const round2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

/**
 * Convert guest-clock samples to the HOST epoch-ms axis the frame timeline uses.
 * offsetMs = guestEpochMs - hostEpochMs (measured once at capture start), so hostEpochMs = guestEpochMs - offset.
 * @param {Array<{epochMs:number}>} guestSamples samples stamped with the GUEST wall clock
 * @param {number} offsetMs guest-minus-host epoch offset
 * @returns {Array<object>} the same samples on the host epoch-ms axis
 */
export function guestSamplesToHostEpoch(guestSamples, offsetMs) {
  if (!Array.isArray(guestSamples)) {
    throw new Error('guestSamplesToHostEpoch requires a samples array');
  }
  if (!Number.isFinite(offsetMs)) {
    throw new Error('guestSamplesToHostEpoch requires a finite offsetMs');
  }
  return guestSamples.map((s) => ({ ...s, epochMs: s.epochMs - offsetMs }));
}

/**
 * Seal a resource-correlated launch record.
 * @param {object} input
 * @param {object} input.record the boot-benchmark-v1 workload record (launchMs span + sourceDetail.settleMs)
 * @param {Array<{epochMs:number, cpuPct?:number|null, ramMb?:number|null, diskPct?:number|null}>} input.hostSamples
 *   resource samples ALREADY on the host epoch-ms axis (guestSamplesToHostEpoch applied).
 * @param {number} input.epochMsAtFrameZero host epoch-ms of capture frame 0.
 * @param {number} [input.frameRateHz=12] capture frame rate.
 * @param {number} [input.hostGuestOffsetMs=0] provenance: the guest-minus-host offset used.
 * @param {number} [input.triggerEpochMs] override the trigger instant (defaults to the record's UI-READY settle).
 * @param {string} [input.trigger='UI-READY'] trigger label.
 * @returns {object} a resource-correlated-launch@1 record.
 */
export function buildResourceCorrelatedLaunch(input) {
  const record = input && input.record;
  if (!record || !Array.isArray(record.spans)) {
    throw new Error('buildResourceCorrelatedLaunch requires a workload record with spans[]');
  }
  const launch = record.spans.find((s) => s && s.id === 'launchMs') || null;
  const triggerEpochMs = Number.isFinite(input.triggerEpochMs)
    ? input.triggerEpochMs
    : record.sourceDetail && record.sourceDetail.settleMs;
  if (!Number.isFinite(triggerEpochMs)) {
    throw new Error('buildResourceCorrelatedLaunch needs a trigger instant (record.sourceDetail.settleMs or triggerEpochMs)');
  }
  const frameRateHz = input.frameRateHz != null ? input.frameRateHz : 12;
  const hostSamples = Array.isArray(input.hostSamples) ? input.hostSamples : [];

  const correlation = buildResourceUsageCorrelation({
    frameRateHz,
    epochMsAtFrameZero: input.epochMsAtFrameZero,
    triggerEpochMs,
    samples: hostSamples,
  });

  const headline = {};
  for (const metric of ['cpu', 'ram', 'disk']) {
    const w = correlation.windows[metric];
    headline[`${metric}PreMean`] = round2(w.pre.mean);
    headline[`${metric}PostMean`] = round2(w.post.mean);
    headline[`${metric}DeltaMean`] = round2(w.deltaMean);
  }

  return {
    schema: RESOURCE_CORRELATED_LAUNCH_SCHEMA,
    workload: record.workload ?? 'unknown',
    plane: record.plane ?? null,
    hypervisor: record.hypervisor ?? null,
    trigger: input.trigger ?? 'UI-READY',
    launchMs: launch ? launch.ms : null,
    frameRateHz,
    epochMsAtFrameZero: input.epochMsAtFrameZero,
    triggerEpochMs,
    triggerFrameIndex: correlation.triggerFrameIndex,
    hostGuestOffsetMs: input.hostGuestOffsetMs ?? 0,
    sampleCount: correlation.sampleCount,
    preSampleCount: correlation.preSampleCount,
    postSampleCount: correlation.postSampleCount,
    // the host-epoch samples are the gate's re-derivation input; windows are the derived pre/post summary.
    samples: hostSamples,
    windows: correlation.windows,
    headline,
  };
}
