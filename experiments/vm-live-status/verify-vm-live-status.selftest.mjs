// Self-test for vmStatusAnalysis.mjs -- live golden-VM idle-time analysis (LBA-REQ-047, ADR-0023 Phase 1).
// Asserts the committed REAL timeline receipt validates + replays deterministically, that it actually
// discriminates idle from busy (surfaces the dead time), and that validation FAILS CLOSED on a stale/tampered
// analysis, a tampered digest, a too-short series, or non-monotonic sample times. Pure + rg-free + offline
// (no VM / ssh). Run: node verify-vm-live-status.selftest.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TIMELINE_SCHEMA, analyzeTimeline, buildStatusTimelineReceipt, validateStatusTimelineReceipt, digestReceipt } from './vmStatusAnalysis.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(here, 'fixtures', 'vm-status-timeline-receipt.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };
const clone = (o) => JSON.parse(JSON.stringify(o));

// 1. the committed real timeline receipt validates
{
  const r = validateStatusTimelineReceipt(receipt);
  assert.ok(r.ok, `expected a valid timeline receipt; findings: ${r.findings.join('; ')}`);
  assert.equal(receipt.schema, TIMELINE_SCHEMA, 'schema');
  ok(`committed receipt valid: ${receipt.analysis.totalSamples} samples over ${receipt.analysis.totalSec}s`);
}

// 2. it actually identifies idle time (>= 1 idle span AND some busy time -> real discrimination)
{
  const a = receipt.analysis;
  assert.ok(a.idleSpans.length >= 1, 'at least one idle span (dead time) identified');
  assert.ok(a.busySec > 0, 'at least some busy time (the timeline discriminates)');
  assert.ok(a.idlePct > 0 && a.idlePct < 100, 'idle% is a real fraction (not trivially all-idle/all-busy)');
  assert.ok(a.longestIdleRunSec > 0, 'longest idle run identified');
  assert.equal(a.idleSec + a.busySec, a.totalSec, 'idle + busy = total time');
  const spanIdle = a.idleSpans.reduce((s, sp) => s + sp.durSec, 0);
  assert.equal(spanIdle, a.idleSec, 'idle spans sum to total idle time');
  ok(`idle-time identified: ${a.idlePct}% idle, longest idle run ${a.longestIdleRunSec}s, ${a.idleSpans.length} idle spans, ${a.transitions} transitions`);
}

// 3. deterministic replay: rebuilding from the samples yields the identical digest + analysis
{
  const rebuilt = buildStatusTimelineReceipt(receipt);
  assert.equal(rebuilt.digest, receipt.digest, 'rebuilt digest matches (deterministic)');
  assert.deepEqual(rebuilt.analysis, receipt.analysis, 'rebuilt analysis matches');
  ok('timeline replays deterministically (rebuild -> identical digest + analysis)');
}

// 4. fail-closed: a stale/tampered analysis that contradicts the samples is rejected
{
  const stale = clone(receipt);
  stale.analysis.idlePct = 0;               // lie: claim there was no idle time
  stale.digest = digestReceipt(stale);      // re-seal so only the re-derivation, not the digest, must catch it
  const r = validateStatusTimelineReceipt(stale);
  assert.equal(r.ok, false, 'an analysis that contradicts the samples FAILS');
  assert.ok(r.findings.some((f) => /re-derivation/.test(f)), 'names the drift');
  ok('fail-closed: stale/tampered analysis rejected');
}

// 5. fail-closed: a tampered digest
{
  const tampered = clone(receipt);
  tampered.digest = '0'.repeat(64);
  const r = validateStatusTimelineReceipt(tampered);
  assert.equal(r.ok, false, 'a tampered digest FAILS');
  assert.ok(r.findings.some((f) => /digest/.test(f)), 'names the digest');
  ok('fail-closed: tampered digest rejected');
}

// 6. fail-closed: a too-short series + non-monotonic sample times
{
  const tooShort = buildStatusTimelineReceipt({ ...receipt, samples: receipt.samples.slice(0, 1) });
  assert.equal(validateStatusTimelineReceipt(tooShort).ok, false, 'a < 2-sample series FAILS');

  const nonMono = clone(receipt);
  nonMono.samples[5].t = 0; // time jumps backwards
  const r = validateStatusTimelineReceipt(buildStatusTimelineReceipt(nonMono));
  assert.equal(r.ok, false, 'non-monotonic sample times FAIL');
  assert.ok(r.findings.some((f) => /monotonic/.test(f)), 'names the ordering');
  ok('fail-closed: too-short series + non-monotonic times rejected');
}

// 7. analyzer unit: a synthetic all-idle series is 100% idle, an all-busy series 0% idle
{
  const idleOnly = analyzeTimeline({ samples: [{ t: 0, cpuPct: 1 }, { t: 2, cpuPct: 2 }, { t: 4, cpuPct: 0 }], sampleIntervalSec: 2, idleCpuThreshold: 5 });
  assert.equal(idleOnly.idlePct, 100, 'all-idle -> 100% idle');
  const busyOnly = analyzeTimeline({ samples: [{ t: 0, cpuPct: 90 }, { t: 2, cpuPct: 80 }], sampleIntervalSec: 2, idleCpuThreshold: 5 });
  assert.equal(busyOnly.idlePct, 0, 'all-busy -> 0% idle');
  ok('analyzer unit: all-idle=100%, all-busy=0%');
}

console.log(`\nverify-vm-live-status.selftest: ${passed}/${passed} checks passed`);
