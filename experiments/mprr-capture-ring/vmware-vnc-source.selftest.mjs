// Self-test for vmware-vnc-source.mjs — proves the streaming RFB client + descriptor sampler against a
// SCRIPTED fake socket (no VM, no real VNC): RFB 3.8 None-auth handshake, a full first FramebufferUpdate,
// then an INCREMENTAL update that mutates the maintained framebuffer, plus the governed-cadence descriptor
// emission (frameIndex + monotonic timingTicks64 + dhash-64 fingerprint). Run: node <this file>.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createStreamingFramebuffer, sampleDescriptor, makeSampler } from './vmware-vnc-source.mjs';
import { dhash64FromRgba } from '../manual-procedure-record/fingerprint.mjs';

const W = 16, H = 16;

/** One RFB FramebufferUpdate with a single Raw rect painted by colorFn(x,y)->[r,g,b]. */
function buildUpdate(rx, ry, rw, rh, colorFn) {
  const head = Buffer.alloc(16);
  head[0] = 0; head[1] = 0; head.writeUInt16BE(1, 2); // type=FramebufferUpdate, padding, numRects=1
  head.writeUInt16BE(rx, 4); head.writeUInt16BE(ry, 6); head.writeUInt16BE(rw, 8); head.writeUInt16BE(rh, 10);
  head.writeInt32BE(0, 12); // encoding = Raw
  const px = Buffer.alloc(rw * rh * 4);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const [r, g, b] = colorFn(x, y); const o = (y * rw + x) * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 0;
    }
  }
  return Buffer.concat([head, px]);
}

/** The full scripted server byte stream: handshake + full update + one incremental update. */
function buildServerBytes() {
  const si = Buffer.alloc(24);
  si.writeUInt16BE(W, 0); si.writeUInt16BE(H, 2); si.writeUInt32BE(0, 20); // width,height,nameLen=0
  return Buffer.concat([
    Buffer.from('RFB 003.008\n', 'latin1'),          // ProtocolVersion
    Buffer.from([1, 1]),                              // security: count=1, type=1 (None)
    Buffer.from([0, 0, 0, 0]),                        // SecurityResult = 0 (OK)
    si,                                               // ServerInit
    buildUpdate(0, 0, W, H, (x) => { const v = (x % 3) * 110; return [v, v, v]; }),        // #1 full: non-monotonic vertical bands
    buildUpdate(0, 0, W, H / 2, (x) => { const v = ((x + 2) % 4) * 80; return [v, v, v]; }), // #2 incremental: repaint top half, different bands
  ]);
}

function makeFakeSocket(serverBytes) {
  const sock = new EventEmitter();
  sock.write = () => true;                            // ignore client writes
  sock.destroy = () => sock.emit('close');
  queueMicrotask(() => sock.emit('data', serverBytes)); // deliver after the reader attaches
  return sock;
}

const waitFor = async (pred, ms = 1000) => {
  const t = Date.now();
  while (!pred()) { if (Date.now() - t > ms) throw new Error('waitFor timeout'); await new Promise((r) => setTimeout(r, 5)); }
};

let passed = 0;
const ok = (m) => { console.log(`  ok - ${m}`); passed += 1; };

// 1) Streaming handshake + full first frame.
const stream = createStreamingFramebuffer({ host: 'x', port: 0, connect: () => makeFakeSocket(buildServerBytes()) });
const dims = await stream.ready;
assert.equal(dims.width, W); assert.equal(dims.height, H);
assert.equal(stream.updateCount(), 1, 'first (full) update applied by ready');
const dhashFull = dhash64FromRgba(stream.current(), W, H);
assert.equal(dhashFull.length, 16);
// top-left pixel of the gradient = [0,0,0]
assert.equal(stream.current()[0], 0);
ok('RFB handshake + full first framebuffer (16x16, dhash len 16)');

// 2) Incremental update mutates the maintained framebuffer + changes the fingerprint.
await waitFor(() => stream.updateCount() >= 2);
const fb = stream.current();
assert.equal(fb[0], 160); assert.equal(fb[2], 160); // top-left now ((0+2)%4)*80 = 160 (the #2 band)
const dhashInc = dhash64FromRgba(fb, W, H);
assert.notEqual(dhashFull, dhashInc, 'incremental update should change the dhash fingerprint');
ok('incremental update maintained the framebuffer + changed the fingerprint');

// 3) sampleDescriptor: agreed shape, 100ns ticks, fields pass through.
const d = sampleDescriptor(fb, W, H, { frameIndex: 5, t0Ms: 100, nowMs: 350, milestoneId: 4, settled: 1 });
assert.equal(d.frameIndex, 5);
assert.equal(d.milestoneId, 4);
assert.equal(d.settled, 1);
assert.equal(d.timingTicks64, BigInt(250 * 10_000)); // 250ms -> 2_500_000 x 100ns ticks
assert.equal(typeof d.dhash64, 'string'); assert.equal(d.dhash64.length, 16);
ok('sampleDescriptor emits the agreed { timingTicks64, frameIndex, dhash64, milestoneId, settled }');

// 4) makeSampler cadence: monotonic frameIndex + ticks from t0, driven by an injected clock.
const frames = [];
const sampler = makeSampler({ stream, milestoneOf: () => 0, onFrame: (x) => frames.push(x) });
sampler.tick(1000);        // frame 0, t0=1000, ticks 0
sampler.tick(1083);        // frame 1, +83ms -> 830_000 ticks
assert.deepEqual(frames.map((f) => f.frameIndex), [0, 1]);
assert.equal(frames[0].timingTicks64, 0n);
assert.equal(frames[1].timingTicks64, BigInt(83 * 10_000));
ok('makeSampler emits monotonic frameIndex + guest-clock ticks at cadence');

stream.close();
console.log(`\nvmware-vnc-source self-test: ${passed}/4 PASS`);
