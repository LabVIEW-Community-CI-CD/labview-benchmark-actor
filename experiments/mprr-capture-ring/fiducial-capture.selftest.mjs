// Self-test for the fiducial VNC server + the capture pipeline, over a REAL localhost socket (server<->client,
// not a scripted fake): the host advances a "stopwatch" fiducial; the VNC streaming client records it; and we
// assert the captured dhash sequence == the KNOWN fiducial ground truth, end-to-end through the ring. This is
// the ground-truth (stopwatch/fiducial) validation the fake-socket + black-screen-VM tests can't give.
// Run: node experiments/mprr-capture-ring/fiducial-capture.selftest.mjs

import assert from 'node:assert/strict';
import net from 'node:net';
import { createFiducialServer, fiducialDhash, FIDUCIAL_W, FIDUCIAL_H } from './fiducial-vnc-server.mjs';
import { createStreamingFramebuffer, makeSampler } from './vnc-source.mjs';
import { makeRingSink } from './vmware-ring-capture.mjs';
import { readCaptureFrames } from './capture-ring.mjs';
import { createShortRing, CLI_DEFAULT_CAPACITY_BYTES } from '../mprr-ring/mprrRing.mjs';
import { dhash64FromRgba } from '../manual-procedure-record/fingerprint.mjs';

const waitFor = async (pred, ms = 2000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('waitFor timeout'); await new Promise((r) => setTimeout(r, 3)); } };
const dhashNow = (stream) => dhash64FromRgba(stream.current(), FIDUCIAL_W, FIDUCIAL_H);
let passed = 0;
const ok = (m) => { console.log(`  ok - ${m}`); passed += 1; };

const server = await createFiducialServer();
const stream = createStreamingFramebuffer({ host: server.host, port: server.port, connect: ({ host, port }) => net.connect({ host, port }) });
const dims = await stream.ready;
assert.equal(dims.width, FIDUCIAL_W); assert.equal(dims.height, FIDUCIAL_H);

// 1) CONTENT FIDELITY: each host-advanced tick's fiducial is reproduced byte-faithfully at the client.
assert.equal(dhashNow(stream), fiducialDhash(0), 'tick 0 (initial full frame) == fiducial ground truth');
for (let n = 1; n <= 7; n++) {
  const before = stream.updateCount();
  server.setTick(n);
  await waitFor(() => stream.updateCount() > before);
  assert.equal(dhashNow(stream), fiducialDhash(n), `tick ${n} captured == fiducial ground truth`);
}
ok('real RFB round-trip reproduces every host-advanced fiducial tick (dhash == ground truth)');

// 2) FULL PIPELINE: sample each captured fiducial into the ring + decode; the ring transports the dhash
//    sequence + monotonic timing faithfully (fiducial -> client -> sink -> ring -> decode).
const ring = createShortRing(CLI_DEFAULT_CAPACITY_BYTES);
const sink = makeRingSink(ring);
const sampler = makeSampler({ stream, onFrame: sink.onFrame });
const expectedDhash = [];
for (let i = 0; i < 6; i++) {
  const n = 10 + i;
  const before = stream.updateCount();
  server.setTick(n);
  await waitFor(() => stream.updateCount() > before);
  sampler.tick(1000 + i * 83); // controlled host-clock cadence
  expectedDhash.push(fiducialDhash(n));
}
const decoded = readCaptureFrames(ring, sink.writes[0].absoluteStartOffset, sink.writes.at(-1).absoluteEndOffset);
assert.deepEqual(decoded.map((d) => d.dhashHex), expectedDhash, 'ring transports each fiducial dhash faithfully (hex<->u64)');
assert.deepEqual(decoded.map((d) => d.frameIndex), [0, 1, 2, 3, 4, 5]);
assert.deepEqual(decoded.map((d) => Number(d.timingTicks64)), [0, 83, 166, 249, 332, 415].map((ms) => ms * 10_000));
ok('fiducial -> client -> sink -> ring -> decode: dhash sequence + monotonic guest-clock ticks match ground truth');

// 3) CAPTURE LATENCY (the stopwatch measuring the pipeline): advance the fiducial on the wall clock, measure the
//    set->capture lag. Sanity-bounded only (timing-sensitive), but demonstrates the host<->capture correlation.
const t0 = Date.now();
const before = stream.updateCount();
server.setTick(99);
await waitFor(() => stream.updateCount() > before && dhashNow(stream) === fiducialDhash(99));
const lagMs = Date.now() - t0;
assert.ok(lagMs >= 0 && lagMs < 1000, `localhost capture latency sane (${lagMs}ms)`);
ok(`capture latency (fiducial set -> captured at client) = ${lagMs}ms over the loopback socket`);

stream.close();          // close the client first so the server has no open connection to wait on
await server.close();
console.log(`\nfiducial-capture self-test: ${passed}/3 PASS`);
