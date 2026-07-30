// workload-benchmark.mjs — assemble a VISUAL-RING WORKLOAD benchmark record. A real workload (e.g. a LabVIEW
// IDE launch) is captured through the visual ring (VBox VNC source -> { ms, dhashHex } frame stream); WIN's
// settle detector (settle-detect.mjs) finds the "UI READY" pin = the first frame of the maximal stable dhash
// tail; launchMs = settleMs - workloadStartMs. This shapes that into a boot-benchmark-v1 record (a launchMs
// span + the settled-UI visual pin) so a LabVIEW-launch benchmark feeds bootBenchmarkDiff (+ #173) like the
// boot-benchmark record does. The reusable capability: benchmark ANY visual workload through the ring.
//
// launchMs is HOST-observed (workload-trigger -> the host visually detects UI-ready). It is marked
// scope:'cross-plane' and carried as a WITNESS by the cross-plane receipt: launch DURATIONS are comparable
// across hypervisors (unlike firmware-inclusive bootToMeshMs), but a cross-hypervisor launch time carries real
// substrate + capture-path bias, so the delta is REPORTED, never hard-gated. A true guest-clock launch would
// need the visual dual-clock (#188) bridge; the guest WORKLOAD-START monotonic time rides along for provenance.

import { createHash } from 'node:crypto';
import { launchMs as computeLaunchMs } from './settle-detect.mjs';
import { FINGERPRINT_ALGO, FINGERPRINT_SPEC_VERSION } from '../manual-procedure-record/fingerprint.mjs';

const BOOT_SCHEMA = 'labview-benchmark-actor/boot-benchmark-v1';

/**
 * Build a boot-benchmark-v1-shaped record for a visual-ring workload.
 * @param {{frames:Array<{ms:number,dhashHex:string}>, workloadStartMs:number,
 *          meta?:object, settle?:{window?:number, toleranceHamming?:number}}} args
 *   frames: the capture stream (host-clock ms + frame dhash); workloadStartMs: host time the workload was
 *   triggered (SAME clock as frames.ms). meta: { workload, iteration, plane, hypervisor, substrate,
 *   readyCaseId, startCaseId, hammingTolerance, workloadStartGuestMonoNs }.
 * @returns {object} a boot-benchmark-v1 record: a launchMs span (host/within-plane) + the settled-UI visual pin.
 * Fails closed if the UI never settles (still changing at capture end).
 */
export function buildWorkloadRecord({ frames, workloadStartMs, meta = {}, settle = {} }) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('workload-benchmark: a non-empty frames array is required');
  }
  if (!Number.isFinite(workloadStartMs)) {
    throw new Error('workload-benchmark: a numeric workloadStartMs (frames-clock) is required');
  }
  const window = settle.window ?? 8;
  const toleranceHamming = settle.toleranceHamming ?? 2;
  const res = computeLaunchMs(frames, workloadStartMs, { window, toleranceHamming });
  if (!res.settled) {
    throw new Error(`workload-benchmark: the workload UI never settled (${res.reason})`);
  }
  const readyCaseId = meta.readyCaseId ?? 'UI-READY';
  const startCaseId = meta.startCaseId ?? 'WORKLOAD-START';
  const integrityHash = createHash('sha256').update(res.settleDhash).digest('hex');
  return {
    schema: BOOT_SCHEMA,
    source: 'labview-workload-visual-ring',
    workload: meta.workload ?? 'labview-ide-launch',
    iteration: meta.iteration ?? `labview-launch-${Date.now()}`,
    plane: meta.plane ?? null,
    hypervisor: meta.hypervisor ?? 'vbox-vnc',
    substrate: meta.substrate ?? 'vm-vnc-visual-ring',
    fingerprintAlgo: FINGERPRINT_ALGO,
    fingerprintSpecVersion: FINGERPRINT_SPEC_VERSION,
    frames: [
      { index: res.settleFrameIndex, hostMonotonicMs: res.settleMs, settled: true, caseId: readyCaseId, perceptualFingerprint: res.settleDhash, integrityHash },
    ],
    spans: [
      // launchMs is a HOST-observed duration (launch trigger -> the host visually detects UI-ready). scope
      // 'cross-plane' so a cross-plane workload receipt COMPARES it as a WITNESS (launch durations are
      // comparable across hypervisors); the capture-path/host bias is reported, not gated.
      { id: 'launchMs', from: startCaseId, to: readyCaseId, clock: 'host', scope: meta.launchScope ?? 'cross-plane', ms: res.launchMs },
    ],
    visual: { gated: false, perMilestone: [{ caseId: readyCaseId, hammingTolerance: meta.hammingTolerance ?? 8, roiMask: null }] },
    sourceDetail: {
      framesCaptured: res.framesConsidered,
      stableTailFrames: res.stableTailFrames,
      settleMs: res.settleMs,
      workloadStartMs,
      workloadStartGuestMonoNs: meta.workloadStartGuestMonoNs ?? null,
      settleOpts: { window, toleranceHamming },
    },
  };
}
