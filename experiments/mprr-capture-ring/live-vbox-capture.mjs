// live-vbox-capture.mjs — stream a running VirtualBox VM's VNC into the shared capture ring + decode (LIVE).
// VBox exposes VNC as a host-side TCP port via the VRDE VNC module (see vbox-vnc-source.mjs for the enablement
// commands), so this needs no guest IP and no SSH — just a powered-on VM with the VNC VRDE server on.
//
//   Env: LBA_VNC_HOST (127.0.0.1)  LBA_VNC_PORT (5900)  LBA_FPS (12)  LBA_DURATION_MS (8000)
//   node experiments/mprr-capture-ring/live-vbox-capture.mjs
//
// Mirror of WIN's vmware-ring-capture.mjs live entry, on the VBox source — same ring, same decode, so a LINUX
// VBox capture and a WIN VMware capture are directly comparable.

import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { createShortRing, CLI_DEFAULT_CAPACITY_BYTES } from '../mprr-ring/mprrRing.mjs';
import { readCaptureFrames } from './capture-ring.mjs';
import { makeRingSink } from './vmware-ring-capture.mjs'; // generic descriptor->ring sink (shared with the VMware wiring)
import { recordFromRing } from './capture-ring-recorder.mjs';
import { createVboxVncSource, VBOX_DEFAULT_VNC_PORT } from './vbox-vnc-source.mjs';

const host = process.env.LBA_VNC_HOST ?? '127.0.0.1';
const port = Number(process.env.LBA_VNC_PORT ?? VBOX_DEFAULT_VNC_PORT);
const fps = Number(process.env.LBA_FPS ?? 12);
const durationMs = Number(process.env.LBA_DURATION_MS ?? 8000);
const password = process.env.LBA_VNC_PASSWORD ?? undefined; // VirtualBox VNC VRDE requires VNC auth (type 2)

const ring = createShortRing(CLI_DEFAULT_CAPACITY_BYTES);
const sink = makeRingSink(ring);
const src = createVboxVncSource({ host, port, fps, durationMs, password, connect: ({ host, port }) => net.connect({ host, port }), onFrame: sink.onFrame });

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
if (!written) console.log('note: 0 visual frames written — the screen was uniform/static, so the sink correctly SKIPPED every empty (all-zero-dhash) frame; the connect + VNC-auth + stream path itself succeeded.');

// Recorder-as-consumer: reconstruct the boot-benchmark-v1 record straight off the live ring (spans from any
// milestone markers; per-milestone visual pins from the dhash frames). A bare VNC boot has no LBABENCH markers,
// so this yields the VISUAL ring (frames, no spans) — the LINUX half to pair cross-plane with WIN's live VMware
// ring via bootBenchmarkDiff.
const record = recordFromRing(ring, from, to, { iteration: `vbox-ring-${Date.now()}`, plane: 'LINUX', hypervisor: 'vbox-vnc', substrate: 'vm-vnc-visual-ring' });
console.log(`record: spans=${record.spans.length} milestones=${record.milestones.length} visualPins=${record.frames.length} (visual frames ${record.counts.visual})`);
if (process.env.LBA_OUT) { writeFileSync(process.env.LBA_OUT, `${JSON.stringify(record, null, 2)}\n`); console.log(`wrote record -> ${process.env.LBA_OUT}`); }

console.log(`done: streamed ${written} VBox VNC frames through the capture ring; decoded ${decoded.length}; record ready.`);
