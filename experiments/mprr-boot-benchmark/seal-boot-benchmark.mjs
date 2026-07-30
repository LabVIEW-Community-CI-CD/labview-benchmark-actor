// seal-boot-benchmark.mjs — the shared, provider-agnostic producer of `boot-benchmark-v1`.
//
// The boot-time sibling of correlate-seal.mjs. A booting console has no viewer monotonic counter, so this
// does NOT read an on-screen counter; instead it correlates milestone MARKERS the guest emitted against the
// host capture timeline, sealing a DUAL-CLOCK record that benchmarks the from-source first boot.
//
// Two clocks, each authoritative for one thing (per the LINUX<->WIN design on the deterministic-record seam):
//   - HOST CLOCK_MONOTONIC (frame.hostMonotonicMs) = the VISUAL timeline; a serial LBABENCH marker pins a
//     milestone to the closest-in-host-time frame LIVE.
//   - GUEST CLOCK_MONOTONIC (journald short-monotonic) = the AUTHORITATIVE timing; buildMs/meshFormMs come
//     from it (cross-plane comparable). The serial marker's mono= only CROSS-CHECKS the pin (skewMs).
//
// Determinism (mirrors correlate-seal): the record seals ONLY if EVERY declared milestone is pinned AND every
// pin's skew (|serialMono - journalMono|) is within tolerance. A boot you can't correlate is NOT a record.
//
// This module is a PURE function over an already-captured session (no VM control, no disk/serial I/O) — the
// live driver (start VM, screenshot loop, tail serial, read journal) sits on top and feeds this. That keeps
// the seal deterministic + unit-testable in CI without hardware, exactly like correlate-seal.mjs.
//
// A "captured session" is:
//   { iteration, sessionId, vm?, hypervisor, plane,
//     capture: { backend, transport, cadenceHz },
//     procedure: { id, milestones: [caseId...] },
//     hostT0MonotonicMs,                                  // host CLOCK_MONOTONIC ms captured pre-boot (t0)
//     frames: [ { hostMonotonicMs, rgba, width, height } | { hostMonotonicMs, png } ],  // capture order
//     serialMarkers: [ { caseId, serialMonotonicMs, hostArrivalMonotonicMs } ],  // live serial pins
//     guestTiming: { <caseId>: guestMonotonicMs, ... },   // authoritative journald short-monotonic (ms)
//     visual?: { gated?, perMilestone?: [ { caseId, hammingTolerance, roiMask? } ] },
//     skewToleranceMs?, sealedAt? }

import { createHash } from 'node:crypto';
import { dhash64FromRgba, FINGERPRINT_ALGO, FINGERPRINT_SPEC_VERSION } from '../manual-procedure-record/fingerprint.mjs';
import { decodePng } from '../manual-procedure-record/capture-adapter.mjs';

const DEFAULT_SKEW_TOLERANCE_MS = 500; // serial mono vs journald mono: same guest event, so ~equal; generous
const DEFAULT_VISUAL_TOLERANCE = 64;   // permissive (whole-hash width) => visual is a witness, not a gate

// The benchmark spans, tagged by clock source + comparison scope. GUEST-clock spans are cross-plane
// comparable; the HOST-clock span includes hypervisor firmware (BIOS/GRUB) so it is within-plane only.
const SPAN_DEFS = [
  { id: 'buildMs',      from: 'LBABUS-BUILD-START', to: 'LBABUS-BUILT', clock: 'guest', scope: 'cross-plane' },
  { id: 'meshFormMs',   from: 'LBABUS-BUILT',       to: 'MESH-OK',      clock: 'guest', scope: 'cross-plane' },
  { id: 'bootToMeshMs', from: 'hostT0',             to: 'MESH-OK',      clock: 'host',  scope: 'within-plane' },
];

function sha256Bytes(bytesLike) {
  const buf = bytesLike instanceof Uint8Array ? Buffer.from(bytesLike) : Buffer.from(Uint8Array.from(bytesLike));
  return createHash('sha256').update(buf).digest('hex');
}

// Normalize a captured frame to { hostMonotonicMs, rgba, width, height }. Accepts raw RGBA or a PNG buffer
// (decoded losslessly by the shared capture-adapter, so identical PNG bytes => identical fingerprint).
function normalizeFrame(f, i) {
  if (!f || !Number.isFinite(f.hostMonotonicMs)) {
    throw new Error(`seal-boot-benchmark: frame ${i} needs a numeric hostMonotonicMs`);
  }
  if (f.rgba && Number.isInteger(f.width) && Number.isInteger(f.height)) {
    return { hostMonotonicMs: f.hostMonotonicMs, rgba: f.rgba, width: f.width, height: f.height };
  }
  if (f.png) {
    const { width, height, rgba } = decodePng(f.png);
    return { hostMonotonicMs: f.hostMonotonicMs, rgba, width, height };
  }
  throw new Error(`seal-boot-benchmark: frame ${i} needs {rgba,width,height} or {png}`);
}

// Pin a milestone to the captured frame whose host time is closest to the serial marker's host arrival.
function nearestFrameIndex(frames, hostArrivalMonotonicMs) {
  let best = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const d = Math.abs(frames[i].hostMonotonicMs - hostArrivalMonotonicMs);
    if (d < bestDelta) { bestDelta = d; best = i; }
  }
  return best;
}

/**
 * Correlate a captured boot session and, iff every milestone pins + cross-checks, seal a boot-benchmark-v1.
 * Throws (never seals) on a missing milestone pin, a missing authoritative guest time, or an out-of-tolerance
 * skew — a boot you cannot deterministically correlate is not a record.
 * @param {object} session see module header for shape
 * @returns {object} a boot-benchmark-v1 record
 */
export function sealBootBenchmark(session) {
  if (!session || typeof session !== 'object') throw new Error('seal-boot-benchmark: session object required');
  for (const key of ['iteration', 'sessionId', 'hypervisor', 'plane', 'capture', 'procedure']) {
    if (!session[key]) throw new Error(`seal-boot-benchmark: session.${key} is required`);
  }
  if (!Array.isArray(session.frames) || session.frames.length < 2) {
    throw new Error('seal-boot-benchmark: session.frames must have >= 2 frames');
  }
  if (!Number.isFinite(session.hostT0MonotonicMs)) {
    throw new Error('seal-boot-benchmark: numeric session.hostT0MonotonicMs (pre-boot t0) is required');
  }
  const milestones = session.procedure.milestones;
  if (!Array.isArray(milestones) || milestones.length < 2) {
    throw new Error('seal-boot-benchmark: procedure.milestones must list >= 2 milestones');
  }
  const guestTiming = session.guestTiming ?? {};
  const serialMarkers = session.serialMarkers ?? [];
  const skewToleranceMs = Number.isFinite(session.skewToleranceMs) ? session.skewToleranceMs : DEFAULT_SKEW_TOLERANCE_MS;

  // 1) Fingerprint + integrity-hash every captured frame; raw pixels are discarded after this loop.
  const norm = session.frames.map(normalizeFrame);
  const outFrames = norm.map((f, i) => ({
    index: i,
    hostMonotonicMs: f.hostMonotonicMs,
    perceptualFingerprint: dhash64FromRgba(f.rgba, f.width, f.height),
    integrityHash: sha256Bytes(f.rgba),
  }));

  // 2) Pin each declared milestone: serial marker -> nearest frame (live), journald -> authoritative ms,
  //    skew cross-check. Fail closed on any missing/out-of-tolerance milestone (determinism).
  const pins = [];
  for (const caseId of milestones) {
    const marker = serialMarkers.find((m) => m.caseId === caseId);
    if (!marker) throw new Error(`seal-boot-benchmark: milestone ${caseId} has no serial pin — NOT sealed`);
    if (!Number.isFinite(marker.hostArrivalMonotonicMs) || !Number.isFinite(marker.serialMonotonicMs)) {
      throw new Error(`seal-boot-benchmark: milestone ${caseId} serial marker needs numeric hostArrivalMonotonicMs + serialMonotonicMs`);
    }
    const guestMonotonicMs = guestTiming[caseId];
    if (!Number.isFinite(guestMonotonicMs)) {
      throw new Error(`seal-boot-benchmark: milestone ${caseId} has no authoritative guest time (journald) — NOT sealed`);
    }
    const frameIndex = nearestFrameIndex(norm, marker.hostArrivalMonotonicMs);
    const skewMs = Math.abs(marker.serialMonotonicMs - guestMonotonicMs);
    if (skewMs > skewToleranceMs) {
      throw new Error(`seal-boot-benchmark: milestone ${caseId} skew ${skewMs}ms > tolerance ${skewToleranceMs}ms (suspect pin/clock) — NOT sealed`);
    }
    // Stamp the pinned frame as the settled milestone frame (the diff/pairing anchor).
    const fr = outFrames[frameIndex];
    fr.caseId = caseId;
    fr.guestMonotonicMs = guestMonotonicMs;
    fr.settled = true;
    pins.push({
      caseId,
      frameIndex,
      hostMonotonicMs: fr.hostMonotonicMs,
      guestMonotonicMs,
      serialMonotonicMs: marker.serialMonotonicMs,
      skewMs,
    });
  }

  // 3) Spans — only those whose endpoints are both present in this session's milestones.
  const guestAt = (caseId) => guestTiming[caseId];
  const hostPinAt = (caseId) => pins.find((p) => p.caseId === caseId)?.hostMonotonicMs;
  const spans = [];
  for (const def of SPAN_DEFS) {
    const haveTo = milestones.includes(def.to);
    const haveFrom = def.from === 'hostT0' ? true : milestones.includes(def.from);
    if (!haveTo || !haveFrom) continue;
    let ms;
    if (def.clock === 'guest') {
      ms = guestAt(def.to) - guestAt(def.from);
    } else {
      const toHost = hostPinAt(def.to);
      ms = toHost - session.hostT0MonotonicMs;
    }
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`seal-boot-benchmark: span ${def.id} computed non-monotonic ms=${ms} — NOT sealed`);
    }
    spans.push({ id: def.id, from: def.from, to: def.to, clock: def.clock, scope: def.scope, ms });
  }

  // 4) Visual policy (witness, not gate). Default permissive tolerances so cut 1 never gates on pixels.
  const visualIn = session.visual ?? {};
  const perMilestone = milestones.map((caseId) => {
    const supplied = (visualIn.perMilestone ?? []).find((v) => v.caseId === caseId);
    const entry = { caseId, hammingTolerance: supplied?.hammingTolerance ?? DEFAULT_VISUAL_TOLERANCE };
    if (supplied?.roiMask) entry.roiMask = supplied.roiMask;
    else entry.roiMask = null;
    return entry;
  });
  const visual = { gated: visualIn.gated === true, perMilestone };

  // 5) Seal: raw discarded; tamper-evident record hash over frames + spans.
  const recordHash = createHash('sha256');
  for (const fr of outFrames) {
    recordHash.update(`${fr.index}|${fr.hostMonotonicMs}|${fr.caseId ?? ''}|${fr.guestMonotonicMs ?? ''}|${fr.perceptualFingerprint}|${fr.integrityHash}\n`);
  }
  for (const s of spans) recordHash.update(`SPAN|${s.id}|${s.from}|${s.to}|${s.clock}|${s.scope}|${s.ms}\n`);

  return {
    schema: 'labview-benchmark-actor/boot-benchmark-v1',
    iteration: session.iteration,
    sessionId: session.sessionId,
    sealedAt: session.sealedAt ?? new Date().toISOString(),
    plane: session.plane,
    hypervisor: session.hypervisor,
    capture: {
      backend: session.capture.backend,
      transport: session.capture.transport,
      cadenceHz: session.capture.cadenceHz,
      ...(session.vm ? { vm: session.vm } : session.capture.vm ? { vm: session.capture.vm } : {}),
    },
    procedure: { id: session.procedure.id, ...(session.procedure.version ? { version: session.procedure.version } : {}), milestones: [...milestones] },
    fingerprintAlgo: FINGERPRINT_ALGO,
    fingerprintSpecVersion: FINGERPRINT_SPEC_VERSION,
    anchor: {
      source: 'host-capture-timeline',
      hostT0MonotonicMs: session.hostT0MonotonicMs,
      hostClock: 'monotonic-ms',
      guestClock: 'journald-short-monotonic',
      correlation: {
        method: 'serial-pin+journal-monotonic',
        allMilestonesPinned: true,
        skewToleranceMs,
        pins,
      },
    },
    frames: outFrames, // raw pixels intentionally absent — only fingerprint + integrity hash remain
    spans,
    visual,
    seal: { rawDiscarded: true, frameCount: outFrames.length, recordHash: recordHash.digest('hex') },
  };
}

export { SPAN_DEFS, DEFAULT_SKEW_TOLERANCE_MS };
