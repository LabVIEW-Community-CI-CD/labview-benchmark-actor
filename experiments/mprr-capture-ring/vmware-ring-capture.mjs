// vmware-ring-capture.mjs — WIRING: the WIN VMware VNC streaming source (vmware-vnc-source.mjs) INTO the shared
// capture ring (capture-ring.mjs writeCaptureFrame over mprr-ring/mprrRing.mjs). This closes the WIN half of
// the capture-ring split (task mprr-capture-ring-backbone): each governed-cadence VNC descriptor is written as
// a 24-byte capture-frame; a consumer drains readCaptureFrames + decodes. Same ring both planes serialize
// against — LINUX feeds a VBox VNC source, WIN feeds this VMware source — so a capture is byte-identical.
//
//   Env: LBA_VNC_HOST (127.0.0.1)  LBA_VNC_PORT (5902)  LBA_FPS (12)  LBA_DURATION_MS (8000)
//   node experiments/mprr-capture-ring/vmware-ring-capture.mjs   # live: stream a running VM's VNC into the ring

import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { createShortRing, CLI_DEFAULT_CAPACITY_BYTES } from '../mprr-ring/mprrRing.mjs';
import { writeCaptureFrame, readCaptureFrames } from './capture-ring.mjs';
import { createVmwareVncSource } from './vmware-vnc-source.mjs';
import { recordFromRing } from './capture-ring-recorder.mjs';

const ALL_ZERO_DHASH = '0000000000000000';

/**
 * Map a vmware-vnc-source descriptor { timingTicks64, frameIndex, dhash64:16-hex, milestoneId, settled } to a
 * capture-ring writeCaptureFrame frame. The source keeps dhash64 as the 16-hex form, so it maps to `dhashHex`
 * (the adapter converts to u64 via dhashHexToBits). Returns null for an EMPTY frame — a uniform all-zero-dhash
 * sample with no milestone — so the wiring SKIPS it rather than tripping the adapter's fail-closed empty-frame
 * guard (a uniform frame carries no fingerprint anyway).
 */
export function ringFrameFromDescriptor(d) {
  const hasVisual = Boolean(d.dhash64) && d.dhash64 !== ALL_ZERO_DHASH;
  const milestoneId = d.milestoneId ?? 0;
  if (!hasVisual && milestoneId === 0) return null;
  const frame = { timingTicks64: d.timingTicks64, frameIndex: d.frameIndex, settled: Boolean(d.settled) };
  if (hasVisual) frame.dhashHex = d.dhash64;
  if (milestoneId > 0) frame.milestoneId = milestoneId;
  return frame;
}

/** A ring sink for a vmware-vnc-source: returns { onFrame, writes, stats } — pass onFrame to the source. */
export function makeRingSink(ring) {
  const writes = [];
  let skipped = 0;
  const onFrame = (d) => {
    const frame = ringFrameFromDescriptor(d);
    if (!frame) { skipped += 1; return; }
    writes.push(writeCaptureFrame(ring, frame));
  };
  return { onFrame, writes, stats: () => ({ written: writes.length, skipped }) };
}

if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/').split('/').pop() ?? '')) {
  const host = process.env.LBA_VNC_HOST ?? '127.0.0.1';
  const port = Number(process.env.LBA_VNC_PORT ?? 5902);
  const fps = Number(process.env.LBA_FPS ?? 12);
  const durationMs = Number(process.env.LBA_DURATION_MS ?? 8000);

  const ring = createShortRing(CLI_DEFAULT_CAPACITY_BYTES);
  const sink = makeRingSink(ring);
  const src = createVmwareVncSource({ host, port, fps, durationMs, connect: ({ host, port }) => net.connect({ host, port }), onFrame: sink.onFrame });

  const dims = await src.ready;
  console.log(`connected: ${dims.width}x${dims.height} @ ${host}:${port} -> capture ring (${CLI_DEFAULT_CAPACITY_BYTES}B)`);
  await src.done;

  const { written, skipped } = sink.stats();
  const from = sink.writes[0]?.absoluteStartOffset ?? 0;
  const to = sink.writes.at(-1)?.absoluteEndOffset ?? 0;
  const decoded = written ? readCaptureFrames(ring, from, to) : [];
  const withFrame = decoded.filter((f) => f.hasFrame).length;
  console.log(`ring: written=${written} skipped(empty)=${skipped} decoded=${decoded.length} hasFrame=${withFrame}`);
  const d0 = decoded[0];
  if (d0) console.log('first decoded:', { ticks: String(d0.timingTicks64), idx: d0.frameIndex, dhash: d0.dhashHex, milestoneId: d0.milestoneId, settled: d0.settled });
  if (!written) console.log('note: 0 visual frames written — the screen was uniform/static, so the sink correctly SKIPPED every empty (all-zero-dhash) frame; the connect + stream path itself succeeded.');

  // Recorder-as-consumer: reconstruct the boot-benchmark-v1 record straight off the live ring (spans from any
  // milestone markers; per-milestone visual pins from the dhash frames). A bare VNC boot has no LBABENCH
  // markers, so this yields the VISUAL ring (frames, no spans) — the WIN half to pair cross-plane with LINUX's
  // live VBox ring via bootBenchmarkDiff.
  const record = recordFromRing(ring, from, to, { iteration: `vmware-ring-${Date.now()}`, plane: 'WIN', hypervisor: 'vmware-vnc', substrate: 'vm-vnc-visual-ring' });
  console.log(`record: spans=${record.spans.length} milestones=${record.milestones.length} visualPins=${record.frames.length} (visual frames ${record.counts.visual})`);
  if (process.env.LBA_OUT) { writeFileSync(process.env.LBA_OUT, `${JSON.stringify(record, null, 2)}\n`); console.log(`wrote record -> ${process.env.LBA_OUT}`); }

  console.log(`done: streamed ${written} VMware VNC frames through the capture ring; decoded ${decoded.length}; record ready.`);
}
