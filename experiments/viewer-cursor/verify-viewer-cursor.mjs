#!/usr/bin/env node
// Deterministic self-test for the benchmark viewer time-cursor logic (LBA-REQ-004, T-004). Dependency-free,
// no browser. Proves: pointer maps to the correct in-bounds sample, keyboard steps by one sample, Home/End
// jump to run start/end, a drag updates the selected time continuously, and no operation selects outside the
// recorded window. Writes a re-runnable receipt.json. The browser/webview render is the maintainer step.
//
// Usage: node experiments/viewer-cursor/verify-viewer-cursor.mjs [--json]
// Exit 0 when every check passes, 1 otherwise.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCursor, selectedIndex, selectedTime, setPointer, step, jump } from './viewerCursor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.slice(2).includes('--json');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, pass: true, detail: detail ?? null });
  } catch (e) {
    results.push({ name, pass: false, error: String(e && e.message ? e.message : e) });
  }
}
function assert(c, m) {
  if (!c) {
    throw new Error(m);
  }
}

// A 5-sample time axis (ms) spanning the run window [0, 40].
const SAMPLES = [0, 10, 20, 30, 40];

check('pointer-maps-to-nearest-in-bounds-sample', () => {
  const c = createCursor(SAMPLES);
  assert(selectedTime(setPointer(c, 0)) === 0, 'fraction 0 -> run start (t=0)');
  assert(selectedTime(setPointer(c, 1)) === 40, 'fraction 1 -> run end (t=40)');
  assert(selectedTime(setPointer(c, 0.5)) === 20, 'fraction 0.5 -> middle sample (t=20)');
  // Out-of-range fractions clamp to the bounds (no selection outside the window).
  assert(selectedTime(setPointer(c, -0.5)) === 0, 'fraction < 0 clamps to run start');
  assert(selectedTime(setPointer(c, 1.5)) === 40, 'fraction > 1 clamps to run end');
  return { start: 0, end: 40 };
});

check('keyboard-steps-by-one-sample-clamped', () => {
  let c = createCursor(SAMPLES); // index 0
  c = step(c, 1);
  assert(selectedIndex(c) === 1 && selectedTime(c) === 10, 'ArrowRight steps one sample forward');
  c = step(c, -1);
  assert(selectedIndex(c) === 0, 'ArrowLeft steps one sample back');
  c = step(c, -1);
  assert(selectedIndex(c) === 0, 'stepping before the start clamps (no wrap, no out-of-range)');
  c = jump(c, 'end');
  c = step(c, 1);
  assert(selectedIndex(c) === SAMPLES.length - 1, 'stepping past the end clamps');
  return { lastIndex: selectedIndex(c) };
});

check('home-end-jump-to-run-bounds', () => {
  const c = createCursor(SAMPLES);
  assert(selectedTime(jump(c, 'start')) === 0, 'Home jumps to run start');
  assert(selectedTime(jump(c, 'end')) === 40, 'End jumps to run end');
  return { start: selectedTime(jump(c, 'start')), end: selectedTime(jump(c, 'end')) };
});

check('drag-updates-selected-time-continuously', () => {
  const c = createCursor(SAMPLES);
  // A left->right drag: the selected time must be monotonically non-decreasing and stay in bounds.
  const times = [0, 0.25, 0.5, 0.75, 1].map((f) => selectedTime(setPointer(c, f)));
  for (let i = 1; i < times.length; i += 1) {
    assert(times[i] >= times[i - 1], 'a left-to-right drag must not move the selected time backward');
    assert(times[i] >= 0 && times[i] <= 40, 'the selected time stays within the run bounds during the drag');
  }
  assert(times.join(',') === '0,10,20,30,40', 'the drag tracks each sample as the pointer sweeps');
  return { times };
});

check('never-selects-outside-the-window', () => {
  const c = createCursor(SAMPLES);
  // Exhaustively hammer every operation and assert the selection is always in-bounds.
  const ops = [setPointer(c, -9), setPointer(c, 9), step(c, -100), step(step(c, 100), 100), jump(c, 'start'), jump(c, 'end')];
  for (const state of ops) {
    assert(selectedIndex(state) >= 0 && selectedIndex(state) <= SAMPLES.length - 1, 'index stays in [0, n-1]');
    assert(selectedTime(state) >= 0 && selectedTime(state) <= 40, 'selected time stays within [start, end]');
  }
  return { ops: ops.length };
});

const total = results.length;
const passed = results.filter((r) => r.pass).length;
const failed = total - passed;
const receipt = {
  schemaVersion: 'labview-benchmark-actor/viewer-cursor-receipt-v1',
  total,
  passed,
  failed,
  timeAxis: { samples: SAMPLES, start: SAMPLES[0], end: SAMPLES[SAMPLES.length - 1] },
  results,
};
writeFileSync(join(here, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);

if (asJson) {
  console.log(JSON.stringify(receipt, null, 2));
} else {
  console.log(`viewer-cursor: ${passed}/${total} checks passed (LBA-REQ-004 cursor logic)`);
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : ' -- ' + r.error}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
