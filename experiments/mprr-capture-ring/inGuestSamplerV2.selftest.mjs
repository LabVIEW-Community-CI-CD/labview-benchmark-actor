// Self-test for the in-guest resource sampler's v2 counters{} (LBA-REQ-011, mesh in-guest instrumentation).
// Browser-free + cross-platform: replays a committed REAL capture from in-guest-resource-sampler.py (run live on
// this host's /proc) and asserts every sample carries the v2 counters{} catalog whose keys EXACTLY match the
// authoritative linuxProcSampler (parity), plus the legacy flat fields (back-compat). linuxProcSampler's key set
// is derived from synthetic snapshots so no /proc is needed in CI. Run: node inGuestSamplerV2.selftest.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sampleFromSnapshots } from '../resource-usage-correlation/linuxProcSampler.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, 'fixtures', 'in-guest-sampler-v2-capture.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// linuxProcSampler's authoritative counter key set, derived without /proc (pure arithmetic on synthetic snapshots).
const snap = (epochMs, d) => ({
  epochMs,
  cum: { cpuTotal: 1000 + d, cpuBusy: 200 + d, user: 100 + d, system: 50 + d, idle: 800, ctxt: 5000 + d, diskReads: 10 + d, diskSectorsRead: 100 + d, diskWrites: 5 + d, diskSectorsWritten: 50 + d, rxBytes: 1000 + d, txBytes: 500 + d },
  gauge: { procsRunning: 2, loadAvg1: 0.5, memTotalKb: 16000000, memAvailKb: 8000000, committedKb: 4000000 }
});
const lpsKeys = Object.keys(sampleFromSnapshots(snap(1000, 0), snap(1083, 100)).counters).sort();

// --- parity: the guest sampler emits the SAME v2 catalog keys the host linuxProcSampler does ---
{
  assert.equal(fx.schema, 'labview-benchmark-actor/in-guest-resource-sampler@v2');
  assert.ok(fx.sampleCount >= 2 && fx.samples.length === fx.sampleCount, 'the committed capture has samples');
  assert.deepEqual([...fx.counterKeys].sort(), lpsKeys, 'guest sampler counter keys are at parity with linuxProcSampler');
  assert.ok(lpsKeys.length >= 15, `the full Linux catalog subset (${lpsKeys.length} keys)`);
  ok(`parity: in-guest sampler emits linuxProcSampler's ${lpsKeys.length} counter keys`);
}

// --- every sample carries the counters{} catalog + the legacy flat fields (back-compat) ---
{
  for (const s of fx.samples) {
    assert.ok(s.counters && typeof s.counters === 'object', 'each sample has a counters object');
    for (const k of lpsKeys) assert.ok(k in s.counters, `sample carries ${k}`);
    assert.ok(typeof s.counters.cpuTotalPct === 'number' && typeof s.counters.memAvailableMb === 'number', 'core counters are numeric');
    assert.ok('cpuPct' in s && 'ramMb' in s && 'diskPct' in s && Number.isFinite(s.epochMs), 'legacy flat fields + epochMs retained');
  }
  const last = fx.samples[fx.samples.length - 1].counters;
  assert.ok(last.memAvailableMb > 0 && last.procsRunning >= 1, 'real captured values are plausible');
  ok(`all ${fx.sampleCount} samples carry counters{} (15 keys) + legacy flat fields`);
}

console.log(`\ninGuestSamplerV2.selftest: ${passed}/${passed} checks passed (REAL data)`);
