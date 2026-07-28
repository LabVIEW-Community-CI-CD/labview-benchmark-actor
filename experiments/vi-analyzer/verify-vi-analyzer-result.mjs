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
const allPass = JSON.parse(readFileSync(join(here, 'fixtures', 'sample-report-allpass.json'), 'utf8'));

// 1. Counts + pass verdict over the fixture (summary 5 pass / 2 fail / 1 error; 3 findings).
check('summary-counts-and-verdict', () => {
  const s = summarizeViAnalyzerReport(fixture);
  assert(s.schema === VI_ANALYZER_RESULT_SCHEMA, 'schema');
  assert(s.totalTests === 8, `totalTests 8, got ${s.totalTests}`);
  assert(s.passedTests === 5 && s.failedTests === 2 && s.errorTests === 1, 'pass/fail/error counts');
  assert(s.totalFindings === 3, `totalFindings 3, got ${s.totalFindings}`);
  assert(s.pass === false, 'any fail/error => not pass');
  const byVi = Object.fromEntries(s.findingsByVi.map((f) => [f.viPath, f.findingCount]));
  assert(byVi['resource/plugins/lv_icon.vi'] === 1 && byVi['Main.vi'] === 2, 'findingsByVi counts');
});

// 2. Deterministic + ORDER-INDEPENDENT resultHash (the cross-plane anchor): shuffling findings => same hash.
check('resultHash-deterministic-and-order-independent', () => {
  const a = summarizeViAnalyzerReport(fixture);
  const shuffled = { config: fixture.config, summary: fixture.summary, findings: [...fixture.findings].reverse() };
  const b = summarizeViAnalyzerReport(shuffled);
  assert(/^[0-9a-f]{64}$/.test(a.resultHash), 'resultHash is 64-hex');
  assert(a.resultHash === b.resultHash, 'resultHash is order-independent (canonicalized)');
  assert(a.totalTests === b.totalTests && a.failedTests === b.failedTests, 'counts stable under shuffle');
});

// 3. A clean all-pass run (the real icon-editor gate) is pass=true with EMPTY findings + real counts.
check('all-pass-report', () => {
  const s = summarizeViAnalyzerReport(allPass);
  assert(s.pass === true && s.failedTests === 0 && s.errorTests === 0, 'all pass');
  assert(s.totalFindings === 0 && s.findingsByVi.length === 0, 'no findings');
  assert(s.totalTests === 452 && s.passedTests === 452, 'real all-pass counts');
});

// 4. A different result set produces a DIFFERENT resultHash (the hash tracks content). Flip one finding
// fail -> error (adjusting the summary to keep consistency): a fail vs an error is a real, distinct result.
check('resultHash-tracks-content', () => {
  const base = summarizeViAnalyzerReport(fixture);
  const changed = JSON.parse(JSON.stringify(fixture));
  changed.findings[1].result = 'error'; // Main.vi/Spelling: fail -> error
  changed.summary.failed = 1;
  changed.summary.error = 2;
  const s = summarizeViAnalyzerReport(changed);
  assert(base.resultHash !== s.resultHash, 'changing a result changes the hash');
  assert(s.failedTests === 1 && s.errorTests === 2, 'counts follow the change');
});

// 5. Benchmark metrics projection carries the numeric counts + the resultHash digest.
check('benchmark-metrics-projection', () => {
  const s = summarizeViAnalyzerReport(fixture);
  const m = viAnalyzerBenchmarkMetrics(s);
  assert(m.totalTests === 8 && m.failedTests === 2 && m.totalFindings === 3 && m.pass === 0, 'numeric metrics');
  assert(m.resultHash === s.resultHash, 'resultHash carried as the cross-plane digest');
});

// 6. Teeth: a pass in findings, a duplicate finding, and a summary/findings inconsistency are rejected.
check('rejects-invalid-finding-duplicate-and-inconsistency', () => {
  let a = false;
  try {
    summarizeViAnalyzerReport({ summary: { passed: 0, failed: 0, error: 0 }, findings: [{ viPath: 'A.vi', test: 'T', result: 'pass' }] });
  } catch (err) {
    a = /invalid result/.test(err.message);
  }
  assert(a, 'a pass in findings is rejected (findings are fail|error only)');
  let b = false;
  try {
    summarizeViAnalyzerReport({
      summary: { passed: 0, failed: 2, error: 0 },
      findings: [{ viPath: 'A.vi', test: 'T', result: 'fail' }, { viPath: 'A.vi', test: 'T', result: 'fail' }],
    });
  } catch (err) {
    b = /duplicate finding/.test(err.message);
  }
  assert(b, 'duplicate finding rejected');
  let c = false;
  try {
    summarizeViAnalyzerReport({ summary: { passed: 5, failed: 2, error: 0 }, findings: [{ viPath: 'A.vi', test: 'T', result: 'fail' }] });
  } catch (err) {
    c = /must equal summary.failed/.test(err.message);
  }
  assert(c, 'summary/findings inconsistency rejected (failed count != fail findings)');
});

// 7. Cross-plane determinism: the canonical order is UTF-16 code-unit order, NOT locale collation (which
// differs between Windows and Linux and would make the resultHash platform-dependent). 'Z' (0x5A) sorts
// BEFORE 'a' (0x61) by code unit but AFTER under typical locale collation.
check('resultHash-is-code-unit-order-not-locale', () => {
  const localeSensitive = {
    config: 'x.viancfg',
    summary: { passed: 0, failed: 2, error: 0 },
    findings: [
      { viPath: 'a.vi', test: 'x', result: 'fail' },
      { viPath: 'Z.vi', test: 'y', result: 'fail' },
    ],
  };
  const s = summarizeViAnalyzerReport(localeSensitive);
  // Independently recompute over the EXPLICIT code-unit canonical form (the cross-plane-stable order).
  const canonicalFindings = [
    { viPath: 'Z.vi', test: 'y', result: 'fail' }, // 'Z'(0x5A) < 'a'(0x61) by code unit (locale sorts 'a' first)
    { viPath: 'a.vi', test: 'x', result: 'fail' },
  ];
  const expectHash = createHash('sha256')
    .update(JSON.stringify({ summary: { passed: 0, failed: 2, error: 0, skipped: 0, unloadable: 0 }, findings: canonicalFindings }))
    .digest('hex');
  assert(s.resultHash === expectHash, `resultHash must use code-unit order (cross-plane stable); got ${s.resultHash} want ${expectHash}`);
});

const passed = checks.filter((c) => c.pass).length;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.err ? `  -- ${c.err}` : ''}`);
}
console.log(`\n${passed}/${checks.length} vi-analyzer-result checks passed`);
process.exit(passed === checks.length ? 0 : 1);
