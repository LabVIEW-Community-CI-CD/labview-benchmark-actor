// verify-workload-benchmark.mjs — proves the visual-ring workload record assembly (workload-benchmark.mjs) with
// SYNTHETIC frames (no VM): a launch capture (changing frames -> a stable "UI ready" tail) yields a launchMs
// span + a settled-UI visual pin, the record feeds bootBenchmarkDiff (self-diff PASS), and a UI still changing
// at capture end fails closed. Run: node experiments/mprr-capture-ring/verify-workload-benchmark.mjs

import assert from 'node:assert/strict';
import { buildWorkloadRecord } from './workload-benchmark.mjs';
import { bootBenchmarkDiff } from '../mprr-boot-benchmark/boot-benchmark-diff.mjs';

let passed = 0;
const ok = (m) => { console.log(`  ok - ${m}`); passed += 1; };
const fr = (ms, dhashHex) => ({ ms, dhashHex });

// A synthetic LabVIEW-launch capture: 4 changing frames (console -> splash -> window) then a STABLE tail
// (UI ready). A blinking cursor (Hamming 1 from READY) rides the tail; toleranceHamming absorbs it.
const LOAD = ['0000000000000000', '00000000000000ff', '000000000000ffff', '0000ffffffffffff'];
const READY = 'ffffffffffffffff';
const READY_BLINK = 'fffffffffffffffe'; // Hamming 1 from READY
let t = 1_000_000;
const workloadStartMs = t;
const frames = [];
for (const d of LOAD) { frames.push(fr(t, d)); t += 800; }                 // 4 changing frames (indices 0..3)
for (let i = 0; i < 10; i += 1) { frames.push(fr(t, (i === 2 || i === 5 || i === 8) ? READY_BLINK : READY)); t += 83; } // stable tail (indices 4..13)

const rec = buildWorkloadRecord({ frames, workloadStartMs, meta: { plane: 'LINUX', workload: 'labview-ide-launch' }, settle: { window: 8, toleranceHamming: 2 } });
assert.equal(rec.schema, 'labview-benchmark-actor/boot-benchmark-v1');
assert.equal(rec.workload, 'labview-ide-launch');
const launch = rec.spans.find((s) => s.id === 'launchMs');
assert.ok(launch && launch.clock === 'host' && launch.scope === 'cross-plane', 'launchMs is a host-observed, cross-plane (witnessed) span');
assert.equal(launch.ms, 4 * 800, `launchMs = settleMs - workloadStartMs (${4 * 800})`);
assert.equal(rec.frames[0].caseId, 'UI-READY');
assert.equal(rec.frames[0].perceptualFingerprint, READY, 'the UI-READY pin is the first settled-tail dhash');
assert.equal(rec.frames[0].settled, true);
assert.equal(rec.sourceDetail.stableTailFrames, 10, 'the whole stable tail counted');
ok(`launchMs record: launchMs=${launch.ms}ms, UI-READY pin, stable tail ${rec.sourceDetail.stableTailFrames}`);

const diff = bootBenchmarkDiff(rec, rec);
assert.equal(diff.verdict, 'PASS', 'the workload record self-diffs PASS through bootBenchmarkDiff');
ok('workload record feeds bootBenchmarkDiff -> self-diff PASS');

// fail-closed: the UI is still changing at capture end (alternating frames, no stable tail).
const A = '0000000000000000'; const B = 'ffffffffffffffff';
const churning = [];
let u = 500000;
for (let i = 0; i < 12; i += 1) { churning.push(fr(u, i % 2 === 0 ? A : B)); u += 83; }
assert.throws(() => buildWorkloadRecord({ frames: churning, workloadStartMs: 500000 }), /never settled/, 'a UI still changing at capture end fails closed');
ok('fail-closed when the UI never settles');

console.log(`\nworkload-benchmark self-test: ${passed}/3 PASS`);
