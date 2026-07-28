#!/usr/bin/env node
// Gate: the VI Analyzer result model has TEETH. Proves the summary counts, the pass verdict, the
// order-independent deterministic resultHash (the cross-plane anchor), and the rejection teeth. Exit 0 = pass.
//
// Run: node experiments/vi-analyzer/verify-vi-analyzer-result.mjs

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  VI_ANALYZER_RESULT_SCHEMA,
  summarizeViAnalyzerReport,
  viAnalyzerBenchmarkMetrics,
} from './viAnalyzerResult.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, pass: true });
  } catch (err) {
    checks.push({ name, pass: false, err: err.message });
  }
}
function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg || 'assertion failed');
  }
}

const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'sample-report.json'), 'utf8'));

// 1. Counts + pass verdict over the fixture (3 VIs, 8 tests, 5 pass, 2 fail, 1 error).
check('summary-counts-and-verdict', () => {
  const s = summarizeViAnalyzerReport(fixture);
  assert(s.schema === VI_ANALYZER_RESULT_SCHEMA, 'schema');
  assert(s.totalVis === 3, `totalVis 3, got ${s.totalVis}`);
  assert(s.totalTests === 8, `totalTests 8, got ${s.totalTests}`);
  assert(s.passedTests === 5 && s.failedTests === 2 && s.errorTests === 1, 'pass/fail/error counts');
  assert(s.pass === false, 'any fail/error => not pass');
  const byVi = Object.fromEntries(s.failuresByVi.map((f) => [f.viPath, f.failCount]));
  assert(byVi['resource/plugins/lv_icon.vi'] === 1 && byVi['Main.vi'] === 2, 'failuresByVi counts');
});

// 2. Deterministic + ORDER-INDEPENDENT resultHash (the cross-plane anchor): shuffling VIs/tests => same hash.
check('resultHash-deterministic-and-order-independent', () => {
  const a = summarizeViAnalyzerReport(fixture);
  const shuffled = {
    config: fixture.config,
    vis: [...fixture.vis].reverse().map((vi) => ({ viPath: vi.viPath, tests: [...vi.tests].reverse() })),
  };
  const b = summarizeViAnalyzerReport(shuffled);
  assert(/^[0-9a-f]{64}$/.test(a.resultHash), 'resultHash is 64-hex');
  assert(a.resultHash === b.resultHash, 'resultHash is order-independent (canonicalized)');
  assert(a.totalTests === b.totalTests && a.failedTests === b.failedTests, 'counts stable under shuffle');
});

// 3. An all-pass report is pass=true with no failures.
check('all-pass-report', () => {
  const s = summarizeViAnalyzerReport({
    config: 'x.viancfg',
    vis: [{ viPath: 'A.vi', tests: [{ test: 'Icon Overlap', result: 'pass' }] }],
  });
  assert(s.pass === true && s.failedTests === 0 && s.errorTests === 0, 'all pass');
  assert(s.failuresByVi.length === 0, 'no failuresByVi');
});

// 4. A different result set produces a DIFFERENT resultHash (the hash actually tracks content).
check('resultHash-tracks-content', () => {
  const base = summarizeViAnalyzerReport(fixture);
  const flipped = JSON.parse(JSON.stringify(fixture));
  flipped.vis[0].tests[2].result = 'pass'; // Spelling fail -> pass
  const changed = summarizeViAnalyzerReport(flipped);
  assert(base.resultHash !== changed.resultHash, 'changing a result changes the hash');
  assert(changed.failedTests === 1, 'one fewer failure');
});

// 5. Benchmark metrics projection carries the numeric counts + the resultHash digest.
check('benchmark-metrics-projection', () => {
  const s = summarizeViAnalyzerReport(fixture);
  const m = viAnalyzerBenchmarkMetrics(s);
  assert(m.totalTests === 8 && m.failedTests === 2 && m.pass === 0, 'numeric metrics');
  assert(m.resultHash === s.resultHash, 'resultHash carried as the cross-plane digest');
});

// 6. Teeth: an invalid result value and a duplicate viPath are rejected.
check('rejects-invalid-result-and-duplicate-vi', () => {
  let a = false;
  try {
    summarizeViAnalyzerReport({ vis: [{ viPath: 'A.vi', tests: [{ test: 'T', result: 'skipped' }] }] });
  } catch (err) {
    a = /invalid result/.test(err.message);
  }
  assert(a, 'invalid result rejected');
  let b = false;
  try {
    summarizeViAnalyzerReport({
      vis: [
        { viPath: 'A.vi', tests: [{ test: 'T', result: 'pass' }] },
        { viPath: 'A.vi', tests: [{ test: 'U', result: 'pass' }] },
      ],
    });
  } catch (err) {
    b = /duplicate viPath/.test(err.message);
  }
  assert(b, 'duplicate viPath rejected');
});

// 7. Cross-plane determinism: the canonical order is UTF-16 code-unit order, NOT locale collation (which
// differs between Windows and Linux and would make the resultHash platform-dependent). 'Z' (0x5A) sorts
// BEFORE 'a' (0x61) by code unit but AFTER under typical locale collation, and 'A.vi' vs 'b.vi' likewise.
check('resultHash-is-code-unit-order-not-locale', () => {
  const localeSensitive = {
    config: 'x.viancfg',
    vis: [
      { viPath: 'b.vi', tests: [{ test: 'Z', result: 'pass' }, { test: 'a', result: 'fail' }] },
      { viPath: 'A.vi', tests: [{ test: 'm', result: 'pass' }] },
    ],
  };
  const s = summarizeViAnalyzerReport(localeSensitive);
  // Independently recompute over an EXPLICIT code-unit canonical form (the cross-plane-stable order).
  const expectCanonical = [
    { viPath: 'A.vi', tests: [{ test: 'm', result: 'pass' }] }, // 'A'(0x41) < 'b'(0x62)
    { viPath: 'b.vi', tests: [{ test: 'Z', result: 'pass' }, { test: 'a', result: 'fail' }] }, // 'Z'(0x5A) < 'a'(0x61)
  ];
  const expectHash = createHash('sha256').update(JSON.stringify(expectCanonical)).digest('hex');
  assert(s.resultHash === expectHash, `resultHash must use code-unit order (cross-plane stable); got ${s.resultHash} want ${expectHash}`);
});

const passed = checks.filter((c) => c.pass).length;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.err ? `  -- ${c.err}` : ''}`);
}
console.log(`\n${passed}/${checks.length} vi-analyzer-result checks passed`);
process.exit(passed === checks.length ? 0 : 1);
