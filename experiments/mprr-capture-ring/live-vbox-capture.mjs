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
import { createShortRing, CLI_DEFAULT_CAPACITY_BYTES } from '../mprr-ring/mprrRing.mjs';
import { readCaptureFrames } from './capture-ring.mjs';
import { makeRingSink } from './vmware-ring-capture.mjs'; // generic descriptor->ring sink (shared with the VMware wiring)
import { createVboxVncSource, VBOX_DEFAULT_VNC_PORT } from './vbox-vnc-source.mjs';

const host = process.env.LBA_VNC_HOST ?? '127.0.0.1';
const port = Number(process.env.LBA_VNC_PORT ?? VBOX_DEFAULT_VNC_PORT);
const fps = Number(process.env.LBA_FPS ?? 12);
const durationMs = Number(process.env.LBA_DURATION_MS ?? 8000);

const ring = createShortRing(CLI_DEFAULT_CAPACITY_BYTES);
const sink = makeRingSink(ring);
const src = createVboxVncSource({ host, port, fps, durationMs, connect: ({ host, port }) => net.connect({ host, port }), onFrame: sink.onFrame });

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
if (!written) { console.error('FAIL: nothing written to the ring'); process.exit(1); }
console.log(`PASS: streamed ${written} VBox VNC frames through the capture ring + decoded ${decoded.length}`);
