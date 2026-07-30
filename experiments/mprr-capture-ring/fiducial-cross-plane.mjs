// fiducial-cross-plane.mjs — the FIDUCIAL cross-plane RECEIPT harness. Both capture paths — the WIN VMware
// path (RFB None-auth) and the LINUX VBox path (RFB VNC-auth, #186) — capture the SAME host-advanced fiducial
// timeline over REAL localhost sockets, THROUGH the sink + ring, and must produce dhash sequences IDENTICAL to
// each other AND to the fiducial ground truth. This is the visual analog of the bootbench cross-plane diff, but
// with a deterministic ground truth instead of a live boot -> closes the cross-plane VISUAL ring with zero VM
// flakiness. Both paths ride the SAME shared RFB core (vnc-source.mjs); only the auth differs -> identity by
// construction, proven end-to-end over the wire.
//
//   node experiments/mprr-capture-ring/fiducial-cross-plane.mjs   # print the receipt (LBA_OUT=<file> to save)

import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { createFiducialServer, fiducialDhash } from './fiducial-vnc-server.mjs';
import { createStreamingFramebuffer, makeSampler } from './vnc-source.mjs';
import { makeRingSink } from './vmware-ring-capture.mjs';
import { readCaptureFrames } from './capture-ring.mjs';
import { createShortRing, CLI_DEFAULT_CAPACITY_BYTES } from '../mprr-ring/mprrRing.mjs';

// Single-bit + composite ticks: distinct fiducial patterns (identity holds even where dhash of two ticks would
// collide — this asserts fidelity, not distinctness). All carry the center anchor, so none is the all-zero
// no-frame sentinel that the sink would skip.
export const DEFAULT_TICKS = [1, 2, 4, 8, 16, 32, 64, 99];

const waitFor = async (pred, ms = 4000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('waitFor timeout'); await new Promise((r) => setTimeout(r, 3)); } };

/** Capture the fiducial `ticks` timeline over one auth path (password=undefined => None-auth), through the ring. */
async function captureTimeline({ password, ticks }) {
  const server = await createFiducialServer({ password });
  const stream = createStreamingFramebuffer({ host: server.host, port: server.port, password, connect: ({ host, port }) => net.connect({ host, port }) });
  await stream.ready;
  const ring = createShortRing(CLI_DEFAULT_CAPACITY_BYTES);
  const sink = makeRingSink(ring);
  const sampler = makeSampler({ stream, onFrame: sink.onFrame });
  try {
    for (let i = 0; i < ticks.length; i++) {
      const before = stream.updateCount();
      server.setTick(ticks[i]);
      await waitFor(() => stream.updateCount() > before);
      sampler.tick(1000 + i * 83);
    }
    const decoded = readCaptureFrames(ring, sink.writes[0].absoluteStartOffset, sink.writes.at(-1).absoluteEndOffset);
    return decoded.map((d) => d.dhashHex);
  } finally {
    stream.close();
    await server.close();
  }
}

/** Run both capture paths against the same fiducial timeline and build the cross-plane receipt. */
export async function captureFiducialCrossPlane({ ticks = DEFAULT_TICKS, password = 'fiducial' } = {}) {
  const groundTruth = ticks.map((t) => fiducialDhash(t));
  const winSeq = await captureTimeline({ password: undefined, ticks });   // WIN VMware path (None-auth)
  const linuxSeq = await captureTimeline({ password, ticks });            // LINUX VBox path (VNC-auth)
  const matchesGroundTruth = winSeq.length === ticks.length
    && winSeq.every((h, i) => h === groundTruth[i])
    && linuxSeq.every((h, i) => h === groundTruth[i]);
  const identical = winSeq.length === linuxSeq.length && winSeq.every((h, i) => h === linuxSeq[i]);
  return {
    schema: 'labview-benchmark-actor/fiducial-cross-plane-receipt@1',
    substrate: 'fiducial-vnc (deterministic ground truth, no VM)',
    ticks,
    groundTruth,
    win: { auth: 'none', role: 'vmware-source-path', dhashSeq: winSeq },
    linux: { auth: 'vnc', role: 'vbox-source-path', dhashSeq: linuxSeq },
    verdict: identical && matchesGroundTruth ? 'IDENTICAL' : 'MISMATCH',
    rerun: 'node experiments/mprr-capture-ring/fiducial-cross-plane.mjs',
  };
}

if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/').split('/').pop() ?? '')) {
  const receipt = await captureFiducialCrossPlane();
  console.log(`fiducial cross-plane: ${receipt.verdict} over ${receipt.ticks.length} ticks (WIN None-auth vs LINUX VNC-auth)`);
  console.log(`  ground truth: ${receipt.groundTruth.slice(0, 3).join(' ')} ...`);
  console.log(`  WIN   (none): ${receipt.win.dhashSeq.slice(0, 3).join(' ')} ...`);
  console.log(`  LINUX (vnc):  ${receipt.linux.dhashSeq.slice(0, 3).join(' ')} ...`);
  if (process.env.LBA_OUT) { writeFileSync(process.env.LBA_OUT, `${JSON.stringify(receipt, null, 2)}\n`); console.log(`receipt -> ${process.env.LBA_OUT}`); }
  process.exitCode = receipt.verdict === 'IDENTICAL' ? 0 : 1;
}
