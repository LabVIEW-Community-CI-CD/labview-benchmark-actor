// settle-detect.mjs — the deterministic "UI READY" detector for visual-ring workload benchmarks. Given the
// captured frame stream (each { ms, dhashHex }), find when the display reached its FINAL steady state: the
// settle pin = the first frame of the MAXIMAL STABLE dhash tail (every frame from there to capture-end within
// toleranceHamming of the last frame). launchMs = settleMs - workloadStartMs. This is the visual "ready" pin a
// workload benchmark (e.g. a LabVIEW IDE launch: desktop -> splash -> Getting-Started window) times against.
//
// Fails closed (settled:false) when the tail is shorter than `window` — i.e. the UI is still changing at
// capture end, so no steady state was reached. `toleranceHamming` absorbs small ongoing motion (a blinking
// cursor / clock) without defeating settle detection. Pure + deterministic -> gated with synthetic sequences.

import { hammingHex } from '../manual-procedure-record/fingerprint.mjs';

/**
 * Detect the settle pin in a capture frame stream.
 * @param {Array<{ms:number, dhashHex:string}>} frames  capture order (host- or guest-clock ms + frame dhash)
 * @param {{window?:number, toleranceHamming?:number}} [opts]  window = min stable-tail frames (default 5);
 *   toleranceHamming = max dhash Hamming distance still considered "unchanged" (default 0 = exact).
 * @returns {object} { settled, settleFrameIndex, settleMs, settleDhash, stableTailFrames, framesConsidered, reason? }
 */
export function detectSettle(frames, { window = 5, toleranceHamming = 0 } = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    return { settled: false, reason: 'no frames', settleFrameIndex: null };
  }
  const n = frames.length;
  const last = frames[n - 1].dhashHex;
  // Walk back from the end while each frame is within tolerance of the FINAL frame -> start of the stable tail.
  let i = n - 1;
  while (i > 0 && hammingHex(frames[i - 1].dhashHex, last) <= toleranceHamming) { i -= 1; }
  const stableTailFrames = n - i;
  if (stableTailFrames < window) {
    return { settled: false, reason: `stable tail ${stableTailFrames} < window ${window} (UI still changing at capture end)`, settleFrameIndex: null, stableTailFrames, framesConsidered: n };
  }
  return {
    settled: true,
    settleFrameIndex: i,
    settleMs: frames[i].ms,
    settleDhash: frames[i].dhashHex,
    stableTailFrames,
    framesConsidered: n,
  };
}

/**
 * Compute launchMs = settleMs - workloadStartMs for a captured workload, using detectSettle. Returns the full
 * settle result plus { launchMs } (null when not settled). Both times must be on the SAME clock (the caller
 * supplies workloadStartMs in the frame stream's clock — e.g. via the visual dual-clock correlation).
 */
export function launchMs(frames, workloadStartMs, opts = {}) {
  const settle = detectSettle(frames, opts);
  return { ...settle, launchMs: settle.settled ? settle.settleMs - workloadStartMs : null };
}
