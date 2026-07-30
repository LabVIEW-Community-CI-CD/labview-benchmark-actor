// visual-dual-clock.mjs — the VISUAL dual-clock correlator. The guest renders a host-agreed fiducial "stopwatch"
// on its own display, advancing it on the GUEST monotonic clock; the host captures the guest framebuffer over
// VNC and DECODES which fiducial step each frame shows (from its dhash). Pairing guest-display-time (when the
// guest set a step) with host-capture-time (when the host first captured it) gives the VISUAL analog of the
// boot-benchmark dual-clock: instead of a serial marker carrying guest CLOCK_MONOTONIC, the guest clock is read
// straight off the PIXELS. A stable (host - guest) offset across steps => the host reads the guest clock
// faithfully through the display; the spread => the end-to-end capture latency jitter; a growing offset =>
// guest<->host clock-rate drift.
//
// Reuses WIN's fiducial pattern (fiducial-vnc-server.mjs) as the shared ground truth, at the GUEST resolution.

import { fiducialDhash } from './fiducial-vnc-server.mjs';

export const GUEST_W = 1280;
export const GUEST_H = 800;

// A curated sequence of ticks whose fiducial dhashes are DISTINCT at the guest resolution, so each guest step
// renders a uniquely decodable frame. Both the guest renderer (which ticks to draw, in order) and this decoder
// agree on it — the host passes it to the renderer, so there is one source. (dhash at 1280x800 collapses many
// ticks; these 12 are mutually distinct — asserted by the self-test.)
export const DUAL_CLOCK_TICKS = [0, 1, 2, 4, 5, 16, 17, 18, 20, 21, 32, 33];

/** Build the decode table dhashHex -> { tick, step } for a tick sequence at the guest resolution. */
export function buildDecodeTable(ticks = DUAL_CLOCK_TICKS, w = GUEST_W, h = GUEST_H) {
  const table = new Map();
  ticks.forEach((tick, step) => {
    const key = fiducialDhash(tick, w, h);
    if (!table.has(key)) table.set(key, { tick, step });
  });
  return table;
}

/** Decode a captured dhash to its { tick, step } (or null when it is not a known fiducial step). */
export function decodeStep(dhashHex, table) {
  return table.get(dhashHex) ?? null;
}

/**
 * Correlate the VISUAL dual-clock.
 *   guestSteps: [{ step, tick, guestMonoMs }]  — the guest's own record (it advanced the fiducial on its clock)
 *   captured:   [{ hostMs, dhashHex }]         — the host capture stream (host-capture wall time + frame dhash)
 * For each guest step observed in the capture, pair the guest-display-time with the FIRST host-capture-time
 * that shows it, align both clocks to their first paired step, and report the per-step (host - guest) delta +
 * its spread. Fails closed if fewer than 2 steps pair up.
 */
export function correlateVisualDualClock({ guestSteps, captured, ticks = DUAL_CLOCK_TICKS, w = GUEST_W, h = GUEST_H }) {
  const table = buildDecodeTable(ticks, w, h);
  const guestByStep = new Map(guestSteps.map((g) => [g.step, g]));
  const firstHostByStep = new Map();
  let decodedFrames = 0;
  for (const c of captured) {
    const d = decodeStep(c.dhashHex, table);
    if (!d) continue;
    decodedFrames += 1;
    if (!firstHostByStep.has(d.step)) firstHostByStep.set(d.step, c.hostMs);
  }
  const steps = [...firstHostByStep.keys()].filter((s) => guestByStep.has(s)).sort((a, b) => a - b);
  if (steps.length < 2) {
    throw new Error(`visual-dual-clock: need >= 2 paired steps to correlate (got ${steps.length})`);
  }
  const g0 = guestByStep.get(steps[0]).guestMonoMs;
  const h0 = firstHostByStep.get(steps[0]);
  const pairs = steps.map((s) => {
    const relGuestMs = guestByStep.get(s).guestMonoMs - g0;
    const relHostMs = firstHostByStep.get(s) - h0;
    return { step: s, tick: guestByStep.get(s).tick, relGuestMs, relHostMs, deltaMs: relHostMs - relGuestMs };
  });
  const deltas = pairs.map((p) => p.deltaMs);
  const minDelta = Math.min(...deltas);
  const maxDelta = Math.max(...deltas);
  const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  return {
    schema: 'labview-benchmark-actor/visual-dual-clock-receipt@1',
    resolution: `${w}x${h}`,
    decodedFrames,
    pairedSteps: pairs.length,
    pairs,
    // The guest clock read visually: a tight spread = the host tracks the guest clock through the pixels.
    driftMs: { minDelta, meanDelta: Math.round(meanDelta * 10) / 10, maxDelta, spreadMs: maxDelta - minDelta },
    rerun: 'node experiments/mprr-capture-ring/live-vbox-dual-clock.mjs',
  };
}
