// live-vmware-capture.mjs — validate vmware-vnc-source.mjs against a REAL VMware RemoteDisplay.vnc server
// (no fake socket). VNC is a HOST-side TCP port (127.0.0.1:590x) VMware exposes, so this needs no guest IP,
// no SSH, and no guest networking — just a powered-on VM. Point it at a running VM's VNC port and it streams
// the maintained framebuffer at the governed cadence, emitting the agreed capture-ring descriptors.
//
//   Env: LBA_VNC_HOST (127.0.0.1)  LBA_VNC_PORT (5902)  LBA_FPS (12)  LBA_DURATION_MS (8000)
//   node experiments/mprr-capture-ring/live-vmware-capture.mjs

import net from 'node:net';
import { createVmwareVncSource } from './vmware-vnc-source.mjs';

const host = process.env.LBA_VNC_HOST ?? '127.0.0.1';
const port = Number(process.env.LBA_VNC_PORT ?? 5902);
const fps = Number(process.env.LBA_FPS ?? 12);
const durationMs = Number(process.env.LBA_DURATION_MS ?? 8000);

const frames = [];
const t0 = Date.now();
const src = createVmwareVncSource({
  host, port, fps, durationMs,
  connect: ({ host, port }) => net.connect({ host, port }),
  onFrame: (d) => frames.push(d),
});

const dims = await src.ready;
console.log(`connected: ${dims.width}x${dims.height} @ ${host}:${port} (RFB None-auth handshake OK)`);
await src.done;

const distinctDhash = new Set(frames.map((f) => f.dhash64)).size;
const fmt = (d) => (d ? { ticks: String(d.timingTicks64), idx: d.frameIndex, dhash: d.dhash64 } : null);
console.log(`elapsed=${Date.now() - t0}ms frames=${frames.length} rfbUpdates=${src.updateCount()} distinctDhash=${distinctDhash}`);
console.log('first frame:', fmt(frames[0]));
console.log('last  frame:', fmt(frames.at(-1)));
if (frames.length === 0) { console.error('FAIL: no frames captured'); process.exit(1); }
console.log(`PASS: streamed ${frames.length} live descriptors from real VMware VNC`);
