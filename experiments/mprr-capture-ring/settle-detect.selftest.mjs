// Self-test for settle-detect.mjs — deterministic, synthetic frame streams (no VM, no socket). Proves the
// "UI ready" settle pin = the first frame of the maximal STABLE dhash tail, tolerance absorbs small jitter,
// a mid-sequence pause does NOT falsely settle (final steady state only), and it fails closed when the UI is
// still changing at capture end. Run: node experiments/mprr-capture-ring/settle-detect.selftest.mjs

import assert from 'node:assert/strict';
import { detectSettle, launchMs } from './settle-detect.mjs';

const A = '0000000000000000';
const B = 'ffffffffffffffff';
const C = '00000000000000ff';
const Cp = '00000000000000fe'; // Hamming 1 from C
const D = '000000000000ff00';
const E = '0000000000ff0000';
const fr = (ms, dhashHex) => ({ ms, dhashHex });

let passed = 0;
const ok = (m) => { console.log(`  ok - ${m}`); passed += 1; };

// 1) changes then stabilizes -> settle at the first frame of the stable tail.
{
  const frames = [fr(0, A), fr(100, A), fr(200, B), fr(300, C), fr(400, C), fr(500, C), fr(600, C), fr(700, C)];
  const s = detectSettle(frames, { window: 5 });
  assert.equal(s.settled, true);
  assert.equal(s.settleFrameIndex, 3);
  assert.equal(s.settleMs, 300);
  assert.equal(s.stableTailFrames, 5);
  const l = launchMs(frames, 50, { window: 5 });
  assert.equal(l.launchMs, 250); // 300 - 50
  ok('settle at the first frame of the stable tail; launchMs = settle - workloadStart');
}

// 2) tolerance absorbs small ongoing jitter (a 1-bit blink) without defeating settle.
{
  const frames = [fr(0, B), fr(100, C), fr(200, Cp), fr(300, C), fr(400, C), fr(500, C)];
  const strict = detectSettle(frames, { window: 5, toleranceHamming: 0 });
  assert.equal(strict.settled, false, 'strict (tol 0): the Cp blink breaks the tail -> only 3 stable, < window 5');
  const tol = detectSettle(frames, { window: 5, toleranceHamming: 2 });
  assert.equal(tol.settled, true);
  assert.equal(tol.settleFrameIndex, 1); // the C right after B; Cp absorbed by tolerance
  assert.equal(tol.settleMs, 100);
  ok('toleranceHamming absorbs a small blink; strict tolerance fails closed on it');
}

// 3) a mid-sequence stable run does NOT falsely settle -> only the FINAL steady state counts.
{
  const frames = [fr(0, A), fr(100, A), fr(200, A), fr(300, B), fr(400, C), fr(500, C), fr(600, C), fr(700, C), fr(800, C)];
  const s = detectSettle(frames, { window: 5 });
  assert.equal(s.settled, true);
  assert.equal(s.settleFrameIndex, 4, 'the early 3-frame A pause is ignored; settle is the final C tail');
  assert.equal(s.settleMs, 400);
  ok('a mid-launch pause does not falsely settle (final steady state only)');
}

// 4) still changing at capture end -> fails closed.
{
  const frames = [fr(0, A), fr(100, B), fr(200, C), fr(300, D), fr(400, E)];
  const s = detectSettle(frames, { window: 5 });
  assert.equal(s.settled, false);
  assert.equal(s.settleFrameIndex, null);
  assert.equal(launchMs(frames, 0, { window: 5 }).launchMs, null);
  ok('UI still changing at capture end -> settled:false, launchMs null (fails closed)');
}

// 5) empty input -> fails closed.
assert.equal(detectSettle([]).settled, false);
ok('empty frame stream -> settled:false');

console.log(`\nsettle-detect self-test: ${passed}/5 PASS`);
