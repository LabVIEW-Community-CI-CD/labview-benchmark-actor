// vbox-vnc-source.selftest.mjs — proves the LINUX VirtualBox VNC source (vbox-vnc-source.mjs) against a
// SCRIPTED fake socket (no VM, no real VNC): it rides the SAME shared RFB core as WIN's VMware source, defaults
// to the VBox VNC port, round-trips a live-shaped descriptor through the 24-byte capture ring, AND emits a
// BYTE-IDENTICAL descriptor to the VMware source for the same framebuffer (the cross-plane invariant the shared
// core exists to guarantee). Run: node experiments/mprr-capture-ring/vbox-vnc-source.selftest.mjs.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createStreamingFramebuffer, makeSampler, createVboxVncSource, VBOX_DEFAULT_VNC_PORT } from './vbox-vnc-source.mjs';
import { createVmwareVncSource } from './vmware-vnc-source.mjs';
import { makeRingSink } from './vmware-ring-capture.mjs'; // generic descriptor->ring sink (shared with the VMware wiring)
import { createShortRing, CLI_DEFAULT_CAPACITY_BYTES } from '../mprr-ring/mprrRing.mjs';
import { readCaptureFrames } from './capture-ring.mjs';
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

/** Scripted RFB 3.8 None-auth server stream: handshake + full update + one incremental update. */
function buildServerBytes() {
  const si = Buffer.alloc(24); si.writeUInt16BE(W, 0); si.writeUInt16BE(H, 2); si.writeUInt32BE(0, 20);
  return Buffer.concat([
    Buffer.from('RFB 003.008\n', 'latin1'), Buffer.from([1, 1]), Buffer.from([0, 0, 0, 0]), si,
    buildUpdate(0, 0, W, H, (x) => { const v = (x % 3) * 110; return [v, v, v]; }),
    buildUpdate(0, 0, W, H / 2, (x) => { const v = ((x + 2) % 4) * 80; return [v, v, v]; }),
  ]);
}
function makeFakeSocket(bytes) {
  const sock = new EventEmitter();
  sock.write = () => true; sock.destroy = () => sock.emit('close');
  queueMicrotask(() => sock.emit('data', bytes));
  return sock;
}
const waitFor = async (pred, ms = 1000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('waitFor timeout'); await new Promise((r) => setTimeout(r, 5)); } };

let passed = 0;
const ok = (m) => { console.log(`  ok - ${m}`); passed += 1; };

// 1) createVboxVncSource wires the shared RFB core and defaults to the VBox VNC port (5900).
{
  let seenPort = null;
  const src = createVboxVncSource({
    connect: ({ port }) => { seenPort = port; return makeFakeSocket(buildServerBytes()); },
    setTimer: () => null, clearTimer: () => {}, // no cadence — we only exercise connect + handshake here
  });
  const dims = await src.ready;
  assert.equal(VBOX_DEFAULT_VNC_PORT, 5900);
  assert.equal(seenPort, 5900, 'createVboxVncSource defaults to the VBox VNC port');
  assert.equal(dims.width, W); assert.equal(dims.height, H);
  src.stop();
  ok('createVboxVncSource wires the shared RFB core at the VBox default VNC port (5900)');
}

// 2) VBox VNC descriptors round-trip through the capture ring (dhash hex<->u64, timing, index, MESH-OK marker).
{
  const stream = createStreamingFramebuffer({ host: 'x', port: 0, connect: () => makeFakeSocket(buildServerBytes()) });
  await stream.ready;
  await waitFor(() => stream.updateCount() >= 2);

  const ring = createShortRing(CLI_DEFAULT_CAPACITY_BYTES);
  const sink = makeRingSink(ring);
  const sampler = makeSampler({ stream, milestoneOf: (now) => (now >= 1100 ? 4 : 0), onFrame: sink.onFrame });
  sampler.tick(1000); // frame 0: pure visual (milestoneId 0)
  sampler.tick(1100); // frame 1: visual + MESH-OK marker (milestoneId 4)

  assert.equal(sink.stats().written, 2);
  const decoded = readCaptureFrames(ring, sink.writes[0].absoluteStartOffset, sink.writes.at(-1).absoluteEndOffset);
  const liveHex = dhash64FromRgba(stream.current(), W, H);
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].frameIndex, 0); assert.equal(decoded[1].frameIndex, 1);
  assert.equal(decoded[0].timingTicks64, 0n); assert.equal(decoded[1].timingTicks64, BigInt(100 * 10_000));
  assert.equal(decoded[0].dhashHex, liveHex); assert.equal(decoded[1].dhashHex, liveHex); // dhash hex->u64->hex
  assert.equal(decoded[0].hasFrame, true); assert.equal(decoded[0].milestoneId, 0); assert.equal(decoded[0].caseId, null);
  assert.equal(decoded[1].milestoneId, 4); assert.equal(decoded[1].caseId, 'MESH-OK'); assert.equal(decoded[1].hasFrame, true);
  stream.close();
  ok('VBox VNC descriptors round-trip through the capture ring (dhash hex<->u64, timing, index, MESH-OK marker)');
}

// 3) Cross-plane byte-identity: the VBox and VMware sources emit an IDENTICAL descriptor for the same
//    framebuffer (both are thin wrappers over the one shared RFB core — byte-identical cross-plane by design).
{
  const firstDescriptor = async (makeSource) => {
    const frames = [];
    let timerCb = null;
    const src = makeSource({
      connect: () => makeFakeSocket(buildServerBytes()),
      clock: () => 1000, setTimer: (cb) => { timerCb = cb; return 1; }, clearTimer: () => {},
      durationMs: 0, milestoneOf: () => 4, onFrame: (d) => frames.push(d),
    });
    await src.ready;
    await waitFor(() => timerCb !== null);
    timerCb(); // one governed tick: samples frame 0, then durationMs(0) reached -> done
    await src.done;
    return frames[0];
  };
  const vbox = await firstDescriptor(createVboxVncSource);
  const vmware = await firstDescriptor(createVmwareVncSource);
  assert.deepEqual(vbox, vmware, 'VBox and VMware sources emit byte-identical descriptors for the same framebuffer');
  assert.equal(vbox.timingTicks64, 0n); assert.equal(vbox.frameIndex, 0); assert.equal(vbox.milestoneId, 4);
  assert.equal(typeof vbox.dhash64, 'string'); assert.equal(vbox.dhash64.length, 16);
  ok('VBox and VMware sources are byte-identical (one shared RFB core)');
}

console.log(`\nvbox-vnc-source self-test: ${passed}/3 PASS`);
