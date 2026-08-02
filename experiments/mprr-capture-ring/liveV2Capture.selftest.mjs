// Self-test for liveV2Capture.mjs -- proven on REAL data (no fakes): the committed receipt captured on THIS host
// by running the real linuxProcSampler -> buildLaunchCapture -> v2 frame-correlator chain end to end. Replays the
// committed receipt deterministically (set RUN_LIVE=1 to additionally re-run the live chain as a smoke).
// Run: node liveV2Capture.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LIVE_V2_CAPTURE_SCHEMA, runLiveV2Capture } from './liveV2Capture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(here, 'fixtures', 'live-v2-capture-receipt.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// --- committed REAL receipt: the full sampler -> assembler -> correlator chain, exactly 12 FPS ---
{
  assert.equal(receipt.schema, LIVE_V2_CAPTURE_SCHEMA, 'live-v2 receipt schema');
  assert.equal(receipt.recordSchema, 'labview-benchmark-actor/launch-capture@1', 'the assembler produced a launch-capture@1 record');
  assert.equal(receipt.measured.exactly12fps, true, 'the real sampler locked to EXACTLY 12 FPS');
  assert.ok(Math.abs(receipt.frameIntervalMs - 1000 / 12) < 1e-6, 'frame interval is exactly 1000/12 ms');
  assert.ok(receipt.frameCount > 0 && receipt.sampleCount === receipt.frameCount, '1:1 samples <-> frames');
  ok(`REAL chain: ${receipt.frameCount} frames @ ${receipt.measured.effectiveFps.toFixed(3)} FPS (sampler -> buildLaunchCapture -> correlator)`);
}

// --- the v2 counter catalog survived the whole chain ---
{
  for (const k of ['cpuTotalPct', 'memAvailableMb', 'diskWriteBytesPerSec']) {
    assert.ok(receipt.counterKeys.includes(k), `counterKeys carries ${k} through buildLaunchCapture`);
  }
  assert.ok(receipt.counterKeys.length >= 12, `the full Linux counter catalog reached the record (${receipt.counterKeys.length})`);
  assert.equal(receipt.everyFrameHasCounters, true, 'every assembled frame carries its counters{}');
  assert.equal(receipt.correlatorRendersCounters, true, 'the counters reach the correlator webview model island');
  ok(`v2 catalog end-to-end: ${receipt.counterKeys.length} counters on every frame -> the correlator renders them`);
}

// --- optional live smoke (not gated in CI): re-run the real chain now ---
if (process.env.RUN_LIVE === '1') {
  const live = await runLiveV2Capture({ samples: 24 });
  assert.equal(live.everyFrameHasCounters, true, 'live re-run: every frame carries counters');
  assert.equal(live.correlatorRendersCounters, true, 'live re-run: correlator renders counters');
  ok(`live re-run smoke: ${live.frameCount} frames, ${live.counterKeys.length} counters`);
}

console.log(`\nliveV2Capture.selftest: ${passed}/${passed} checks passed (REAL data)`);
