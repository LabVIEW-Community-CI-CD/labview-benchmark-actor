#!/usr/bin/env node
// Self-verifying gate for the VI Analyzer TREND receipt (experiments/vi-analyzer/vi-analyzer-trend-live-
// evidence.json). RE-DERIVES each run's resultHash from its committed summary counts (viAnalyzerResult.mjs) and
// asserts: (a) every run re-derives to its stored hash, (b) all runs share ONE resultHash, (c) that digest
// equals the single-run cross-plane canonical, (d) every run is 69/69 all-pass with exit 0, and (e) the trend
// stats are internally consistent. Re-runnable from COMMITTED data alone (no cleanroom, no /tmp artifacts), so
// the determinism claim is independently checkable long after the live run.
//
// Usage:  node experiments/vi-analyzer/verify-vi-analyzer-trend.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { summarizeViAnalyzerReport } from './viAnalyzerResult.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const receiptPath = process.argv[2] || join(here, 'vi-analyzer-trend-live-evidence.json');
const r = JSON.parse(readFileSync(receiptPath, 'utf8'));

let failures = 0;
const check = (cond, msg) => {
  if (!cond) { console.error(`FAIL  ${msg}`); failures += 1; } else { console.log(`PASS  ${msg}`); }
};

check(r.schema === 'labview-benchmark-actor/vi-analyzer-trend-live-evidence@1', 'receipt schema is vi-analyzer-trend-live-evidence@1');
check(Array.isArray(r.runs) && r.runs.length >= 3, `receipt carries a trend of >=3 runs (got ${r.runs?.length})`);

const derived = new Set();
for (const run of r.runs) {
  // Reconstruct the normalized report from the committed counts (all-pass -> empty findings) and RE-DERIVE the
  // hash: a stored hash that does not recompute from its own counts would be caught here.
  const report = { config: 'LabVIEWCLIExampleProject', summary: { ...run.summary }, findings: [] };
  const s = summarizeViAnalyzerReport(report);
  check(s.resultHash === run.resultHash, `run ${run.run}: resultHash re-derives from its committed counts`);
  check(
    run.exit === 0 && run.summary.passed === 69 && run.summary.failed === 0 && run.summary.error === 0,
    `run ${run.run}: 69/69 all-pass, exit 0`
  );
  derived.add(s.resultHash);
}

check(derived.size === 1, `all runs re-derive to ONE resultHash (determinism), got ${derived.size}`);
check([...derived][0] === r.determinism.canonicalHash, 'the trend resultHash equals the single-run cross-plane canonical');
check(
  r.determinism.deterministicAcrossRuns === true && r.determinism.matchesSingleRunCanonical === true,
  'receipt determinism flags are set'
);

// Trend-stats internal consistency (guards a hand-edited or stale receipt).
const walls = r.runs.map((x) => x.wallMs);
check(r.trend.coldWallMs === walls[0], 'trend.coldWallMs == run 1 wall');
const warm = walls.slice(1).sort((a, b) => a - b);
check(r.trend.warmMedianMs === warm[Math.floor(warm.length / 2)], 'trend.warmMedianMs is the median of runs 2..N');
check(r.trend.warmMinMs === warm[0] && r.trend.warmMaxMs === warm[warm.length - 1], 'trend.warmMin/Max match runs 2..N');
check(r.trend.coldOverWarm === +(r.trend.coldWallMs / r.trend.warmMedianMs).toFixed(2), 'trend.coldOverWarm == cold/warmMedian');

if (failures > 0) {
  console.error(`\nvi-analyzer-trend: FAIL (${failures} check(s))`);
  process.exit(1);
}
console.log(
  `\nvi-analyzer-trend: PASS -- ${r.runs.length} runs, ONE resultHash ${[...derived][0].slice(0, 16)}... == single-run canonical; cold/warm ${r.trend.coldOverWarm}x`
);
