// combined-visual-dual-clock.mjs — the CAPSTONE of the cross-plane VISUAL ring: ONE receipt composing the two
// proven halves.
//   IDENTITY (deterministic, #187): the two capture paths — VMware None-auth + VBox VNC-auth — capture the same
//     host-advanced fiducial timeline byte-identically (== each other == ground truth).
//   CORRELATION (#188): the captured pixels carry a RECOVERABLE guest clock — decode which fiducial step each
//     frame shows and pair guest-display-time -> host-capture-time (the visual dual-clock).
// Together: the same pixels are captured identically cross-plane AND those pixels encode the guest clock.
//
// The correlation here is a LOOPBACK dual-clock (the fiducial server is the "guest", the capture client the
// "host", over a real socket) — the DETERMINISTIC, gateable analog of LINUX's LIVE VBox guest->host dual-clock
// (#188, delta mean 22.9ms / spread 101ms on a real VM). It exercises the SAME decode + correlate machinery.
//
//   node experiments/mprr-capture-ring/combined-visual-dual-clock.mjs   # print the receipt (LBA_OUT=<file> to save)

import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { createFiducialServer } from './fiducial-vnc-server.mjs';
import { createStreamingFramebuffer } from './vnc-source.mjs';
import { dhash64FromRgba } from '../manual-procedure-record/fingerprint.mjs';
import { GUEST_W, GUEST_H, DUAL_CLOCK_TICKS, correlateVisualDualClock } from './visual-dual-clock.mjs';
import { captureFiducialCrossPlane } from './fiducial-cross-plane.mjs';

const waitFor = async (pred, ms = 5000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('waitFor timeout'); await new Promise((r) => setTimeout(r, 3)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A LOOPBACK visual dual-clock: advance a fiducial "guest" through DUAL_CLOCK_TICKS at the guest resolution,
 * capturing each step over a real socket; record guest-display-time (when the step was set) + host-capture-time
 * (when it was captured), then correlate. Real sockets, no VM — the gateable analog of LINUX's live VBox run.
 */
async function loopbackDualClock({ ticks = DUAL_CLOCK_TICKS, stepDelayMs = 40 } = {}) {
  const server = await createFiducialServer({ width: GUEST_W, height: GUEST_H });
  const stream = createStreamingFramebuffer({ host: server.host, port: server.port, connect: ({ host, port }) => net.connect({ host, port }) });
  await stream.ready; // server starts at tick 0 == ticks[0]
  const guestSteps = [];
  const captured = [];
  try {
    const now0 = Date.now();
    guestSteps.push({ step: 0, tick: ticks[0], guestMonoMs: now0 });
    captured.push({ hostMs: now0, dhashHex: dhash64FromRgba(stream.current(), GUEST_W, GUEST_H) });
    for (let step = 1; step < ticks.length; step++) {
      await sleep(stepDelayMs); // let both clocks advance so the correlation is meaningful
      const before = stream.updateCount();
      const setAt = Date.now(); // guest-display-time: when the guest set this step
      server.setTick(ticks[step]);
      await waitFor(() => stream.updateCount() > before);
      const capAt = Date.now(); // host-capture-time
      guestSteps.push({ step, tick: ticks[step], guestMonoMs: setAt });
      captured.push({ hostMs: capAt, dhashHex: dhash64FromRgba(stream.current(), GUEST_W, GUEST_H) });
    }
    return correlateVisualDualClock({ guestSteps, captured });
  } finally {
    stream.close();
    await server.close();
  }
}

/** Compose the identity (#187) + correlation (#188) halves into the one capstone receipt. */
export async function combinedVisualDualClock() {
  const identity = await captureFiducialCrossPlane();
  const correlation = await loopbackDualClock();
  const allDecoded = correlation.pairedSteps === DUAL_CLOCK_TICKS.length;
  const verdict = identity.verdict === 'IDENTICAL' && allDecoded ? 'PASS' : 'FAIL';
  return {
    schema: 'labview-benchmark-actor/combined-visual-dual-clock-receipt@1',
    title: 'cross-plane VISUAL ring: byte-identical capture (identity) + recoverable guest clock (correlation)',
    identity: {
      verdict: identity.verdict,
      ticks: identity.ticks.length,
      paths: 'none-auth(VMware) == vnc-auth(VBox) == ground truth',
    },
    correlation: {
      resolution: correlation.resolution,
      pairedSteps: correlation.pairedSteps,
      allStepsDecoded: allDecoded,
      driftMs: correlation.driftMs,
    },
    liveReference: 'LINUX #188 proved this on a real VBox guest->host: delta mean 22.9ms / spread 101ms. This loopback (~ms) is the deterministic, gateable analog exercising the same decode + correlate machinery.',
    verdict,
    rerun: 'node experiments/mprr-capture-ring/combined-visual-dual-clock.mjs',
  };
}

if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/').split('/').pop() ?? '')) {
  const r = await combinedVisualDualClock();
  console.log(`combined visual dual-clock: ${r.verdict}`);
  console.log(`  identity:    ${r.identity.verdict} over ${r.identity.ticks} ticks (${r.identity.paths})`);
  console.log(`  correlation: ${r.correlation.pairedSteps}/${DUAL_CLOCK_TICKS.length} steps @ ${r.correlation.resolution}, (host-guest) mean ${r.correlation.driftMs.meanDelta}ms spread ${r.correlation.driftMs.spreadMs}ms`);
  if (process.env.LBA_OUT) { writeFileSync(process.env.LBA_OUT, `${JSON.stringify(r, null, 2)}\n`); console.log(`receipt -> ${process.env.LBA_OUT}`); }
  process.exitCode = r.verdict === 'PASS' ? 0 : 1;
}
