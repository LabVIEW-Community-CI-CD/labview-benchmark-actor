// Self-test for winPdhSampler.ps1 -- proven on REAL data (no fakes): a committed capture from the Windows PDH
// sampler run LIVE on the golden Windows VM. Cross-platform + browser-free (replays the committed JSON; PDH is
// Windows-only so it is captured once, not run in CI). Asserts the EXACT-12-FPS lock, the v2 counters{} catalog,
// cross-plane parity with the Linux linuxProcSampler on the SHARED keys, and that the WIN series flows through the
// same performance-counter-correlation@v2 engine. Run: node winPdhSampler.selftest.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sampleFromSnapshots } from './linuxProcSampler.mjs';
import { buildPerformanceCounterCorrelation } from './performanceCounterCorrelation.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cap = JSON.parse(readFileSync(join(here, 'fixtures', 'win-pdh-12fps-capture.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// --- REAL exact-12-FPS Windows PDH capture ---
{
  assert.equal(cap.schema, 'labview-benchmark-actor/resource-correlated-launch@2');
  assert.equal(cap.plane, 'WIN');
  assert.equal(cap.measured.exactly12fps, true, 'the Windows PDH capture must be EXACTLY 12 FPS (wall-clock locked)');
  assert.ok(Math.abs(cap.frameIntervalMs - 1000 / 12) < 1e-3, 'frame interval is 1000/12 ms');
  // Windows' default timer tick is ~15.6 ms, so the phase error is coarser than Linux -- but the 12 FPS lock holds.
  assert.ok(cap.measured.medianPhaseErrorMs <= 20, `median frame-lock error within the Windows timer floor, got ${cap.measured.medianPhaseErrorMs}`);
  assert.ok(cap.sampleCount >= 12 && cap.samples.length === cap.sampleCount, 'the capture has samples');
  ok(`REAL Windows PDH capture: ${cap.sampleCount} samples @ ${cap.measured.effectiveFps} FPS (exactly12fps)`);
}

// --- v2 counters{} catalog on every sample ---
const winKeys = [...cap.counterKeys].sort();
{
  assert.ok(winKeys.length >= 12, `the Windows PDH catalog subset (${winKeys.length} keys)`);
  for (const k of ['cpuTotalPct', 'memAvailableMb', 'diskWriteBytesPerSec', 'contextSwitchesPerSec']) {
    assert.ok(winKeys.includes(k), `catalog has ${k}`);
  }
  for (const s of cap.samples) {
    assert.ok(s.counters && typeof s.counters.cpuTotalPct === 'number', 'each sample carries numeric counters{}');
  }
  ok(`v2 counters{} catalog on all ${cap.sampleCount} samples (${winKeys.length} PDH keys)`);
}

// --- cross-plane parity: the shared catalog keys are emitted by BOTH the Windows PDH + Linux /proc samplers ---
{
  const snap = (epochMs, d) => ({
    epochMs,
    cum: { cpuTotal: 1000 + d, cpuBusy: 200 + d, user: 100 + d, system: 50 + d, idle: 800, ctxt: 5000 + d, diskReads: 10 + d, diskSectorsRead: 100 + d, diskWrites: 5 + d, diskSectorsWritten: 50 + d, rxBytes: 1000 + d, txBytes: 500 + d },
    gauge: { procsRunning: 2, loadAvg1: 0.5, memTotalKb: 16000000, memAvailKb: 8000000, committedKb: 4000000 }
  });
  const linuxKeys = new Set(Object.keys(sampleFromSnapshots(snap(1000, 0), snap(1083, 100)).counters));
  const shared = winKeys.filter((k) => linuxKeys.has(k));
  for (const k of ['cpuTotalPct', 'cpuUserPct', 'cpuPrivilegedPct', 'contextSwitchesPerSec', 'memAvailableMb', 'memCommittedBytes', 'memCommittedInUsePct', 'diskReadsPerSec', 'diskWritesPerSec', 'diskReadBytesPerSec', 'diskWriteBytesPerSec']) {
    assert.ok(shared.includes(k), `shared cross-plane key ${k}`);
  }
  assert.ok(shared.length >= 11, `>= 11 shared catalog keys across WIN + LINUX planes (got ${shared.length})`);
  ok(`cross-plane parity: ${shared.length} shared catalog keys emitted by both the Windows PDH + Linux /proc samplers`);
}

// --- the WIN series flows through the same v2 correlation engine ---
{
  const trigger = cap.samples[Math.floor(cap.samples.length / 2)].epochMs;
  const model = buildPerformanceCounterCorrelation({ frameRateHz: 12, epochMsAtFrameZero: cap.epochMsAtFrameZero, triggerEpochMs: trigger, samples: cap.samples });
  assert.equal(model.sampleCount, cap.sampleCount);
  assert.ok(model.counterKeys.includes('cpuTotalPct') && model.perCounter.cpuTotalPct.pre.count > 0, 'WIN plane correlated on the v2 catalog keys');
  ok(`Windows PDH series -> performance-counter-correlation@v2 (${model.counterKeys.length} counters correlated)`);
}

console.log(`\nwinPdhSampler.selftest: ${passed}/${passed} checks passed (REAL data)`);
