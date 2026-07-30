// verify-visual-dual-clock.mjs — proves the VISUAL dual-clock correlator (visual-dual-clock.mjs) with SYNTHETIC
// data (no VM): the tick sequence decodes distinctly at the guest resolution, the correlator pairs guest-display
// steps to host-capture times, recovers the capture-latency jitter as the (host-guest) spread, surfaces a
// guest<->host clock-RATE drift as a growing delta, and fails closed on too few paired steps.
// Run: node experiments/mprr-capture-ring/verify-visual-dual-clock.mjs

import assert from 'node:assert/strict';
import { fiducialDhash } from './fiducial-vnc-server.mjs';
import { DUAL_CLOCK_TICKS, GUEST_W, GUEST_H, buildDecodeTable, decodeStep, correlateVisualDualClock } from './visual-dual-clock.mjs';

let passed = 0;
const ok = (m) => { console.log(`  ok - ${m}`); passed += 1; };
const dh = (tick) => fiducialDhash(tick, GUEST_W, GUEST_H);

// 1) The tick sequence is mutually decode-distinct at the guest resolution.
const table = buildDecodeTable();
assert.equal(table.size, DUAL_CLOCK_TICKS.length, 'DUAL_CLOCK_TICKS must be mutually distinct at the guest resolution');
ok('DUAL_CLOCK_TICKS all decode-distinct at 1280x800');

// 2) decodeStep maps each fiducial step + rejects an unknown frame.
DUAL_CLOCK_TICKS.forEach((tick, step) => assert.deepEqual(decodeStep(dh(tick), table), { tick, step }));
assert.equal(decodeStep('ffffffffffffffff', table), null, 'unknown dhash -> null');
ok('decodeStep maps each fiducial step + rejects unknown frames');

// 3) Synthetic dual-clock: the guest advances every 250ms; the host captures each ~30ms later with small jitter,
//    plus a noise frame + a duplicate capture per step (only the FIRST host time for a step counts).
const intervalMs = 250; const latency = 30;
const jitter = [0, 4, -3, 6, 2, -1, 5, 0, 3, -2, 4, 1];
const guestSteps = DUAL_CLOCK_TICKS.map((tick, step) => ({ step, tick, guestMonoMs: 100000 + step * intervalMs }));
const captured = [];
DUAL_CLOCK_TICKS.forEach((tick, step) => {
  const hostMs = 5_000_000 + step * intervalMs + latency + jitter[step];
  captured.push({ hostMs: hostMs - 10, dhashHex: '0000000000000000' }); // noise (unknown) -> skipped
  captured.push({ hostMs, dhashHex: dh(tick) });                        // first capture of this step
  captured.push({ hostMs: hostMs + 40, dhashHex: dh(tick) });           // duplicate -> ignored
});
const rec = correlateVisualDualClock({ guestSteps, captured });
assert.equal(rec.pairedSteps, DUAL_CLOCK_TICKS.length, 'all steps pair');
assert.equal(rec.decodedFrames, DUAL_CLOCK_TICKS.length * 2, 'both real captures per step decode; noise does not');
assert.equal(rec.pairs[0].relGuestMs, 0); assert.equal(rec.pairs[0].relHostMs, 0);
const jSpread = Math.max(...jitter) - Math.min(...jitter);
assert.equal(rec.driftMs.spreadMs, jSpread, `(host-guest) delta spread == injected jitter spread (${jSpread}ms)`);
for (const p of rec.pairs) assert.ok(Math.abs(p.relHostMs - p.relGuestMs) <= jSpread, 'host-capture timeline tracks guest-display within jitter');
ok(`dual-clock correlation: ${rec.pairedSteps} steps, (host-guest) spread ${rec.driftMs.spreadMs}ms == injected jitter`);

// 4) A guest<->host clock-RATE drift (host clock 2% fast) surfaces as a growing (host-guest) delta.
const drifted = DUAL_CLOCK_TICKS.map((tick, step) => ({ hostMs: 5_000_000 + Math.round(step * intervalMs * 1.02) + latency, dhashHex: dh(tick) }));
const recD = correlateVisualDualClock({ guestSteps, captured: drifted });
assert.ok(recD.driftMs.maxDelta > recD.driftMs.minDelta, 'a rate drift shows as a growing (host-guest) delta');
assert.ok(recD.pairs.at(-1).deltaMs > recD.pairs[0].deltaMs, 'last-step delta > first-step delta under drift');
ok('guest<->host clock-rate drift surfaces as a growing delta');

// 5) Fail closed when fewer than 2 steps pair.
assert.throws(() => correlateVisualDualClock({ guestSteps, captured: [{ hostMs: 1, dhashHex: dh(DUAL_CLOCK_TICKS[0]) }] }),
  /need >= 2 paired steps/, 'one paired step -> fail closed');
ok('fail-closed when < 2 steps pair');

console.log(`\nvisual-dual-clock self-test: ${passed}/5 PASS`);
