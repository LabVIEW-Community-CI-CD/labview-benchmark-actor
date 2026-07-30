// Round-trip self-test for the WIN capture-ring wiring (vmware-ring-capture.mjs): a SCRIPTED fake VNC socket
// -> vmware-vnc-source streaming framebuffer -> makeRingSink -> writeCaptureFrame -> the mprr short ring ->
// readCaptureFrames -> decode. Proves a live-shaped VNC descriptor survives the 24-byte ring byte-for-byte
// (dhash via hex<->u64, timing, index, and a MESH-OK milestone marker riding a visual frame). No VM. Run: node.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createStreamingFramebuffer, makeSampler } from './vmware-vnc-source.mjs';
import { makeRingSink, ringFrameFromDescriptor } from './vmware-ring-capture.mjs';
import { createShortRing, CLI_DEFAULT_CAPACITY_BYTES } from '../mprr-ring/mprrRing.mjs';
import { readCaptureFrames } from './capture-ring.mjs';
import { dhash64FromRgba } from '../manual-procedure-record/fingerprint.mjs';

const W = 16, H = 16;

function buildUpdate(rx, ry, rw, rh, colorFn) {
  const head = Buffer.alloc(16);
  head[0] = 0; head[1] = 0; head.writeUInt16BE(1, 2);
  head.writeUInt16BE(rx, 4); head.writeUInt16BE(ry, 6); head.writeUInt16BE(rw, 8); head.writeUInt16BE(rh, 10);
  head.writeInt32BE(0, 12);
  const px = Buffer.alloc(rw * rh * 4);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) { const [r, g, b] = colorFn(x, y); const o = (y * rw + x) * 4; px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 0; }
  return Buffer.concat([head, px]);
}
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

// mapper unit: empty (uniform all-zero dhash + no milestone) => skipped (null); a milestone-only marker maps.
assert.equal(ringFrameFromDescriptor({ dhash64: '0000000000000000', milestoneId: 0 }), null);
assert.deepEqual(ringFrameFromDescriptor({ timingTicks64: 5n, frameIndex: 2, dhash64: '0000000000000000', milestoneId: 3 }),
  { timingTicks64: 5n, frameIndex: 2, settled: false, milestoneId: 3 });
ok('ringFrameFromDescriptor skips empty frames + maps a pure milestone marker');

// stream two frames, sample into the ring at MESH-OK on the 2nd, drain + decode.
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
assert.equal(decoded.length, 2);

const liveHex = dhash64FromRgba(stream.current(), W, H);
assert.equal(decoded[0].frameIndex, 0); assert.equal(decoded[1].frameIndex, 1);
assert.equal(decoded[0].timingTicks64, 0n); assert.equal(decoded[1].timingTicks64, BigInt(100 * 10_000));
assert.equal(decoded[0].dhashHex, liveHex); assert.equal(decoded[1].dhashHex, liveHex); // dhash round-tripped hex->u64->hex
assert.equal(decoded[0].hasFrame, true);
assert.equal(decoded[0].milestoneId, 0); assert.equal(decoded[0].caseId, null);
assert.equal(decoded[1].milestoneId, 4); assert.equal(decoded[1].caseId, 'MESH-OK'); assert.equal(decoded[1].hasFrame, true);
ok('VNC descriptors round-trip through the capture ring (dhash hex<->u64, timing, index, MESH-OK marker)');

stream.close();
console.log(`\nvmware-ring-capture self-test: ${passed}/2 PASS`);
