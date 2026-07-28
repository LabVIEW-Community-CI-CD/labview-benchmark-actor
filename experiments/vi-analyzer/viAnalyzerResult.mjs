#!/usr/bin/env node
// VI Analyzer RESULT model, absorbed dependency-free (operator directive: install + leverage VI Analyzer, like
// ni/labview-icon-editor). WIN installs the toolkit (cleanroom/docker-windows/install-vi-analyzer.ps1) and runs
// it on real VIs via `LabVIEWCLI -OperationName RunVIAnalyzer -ConfigPath <.viancfg>`; that produces a report
// of per-VI test results. This module summarizes a NORMALIZED report (the shape a plane's parser emits) into
// comparable metrics + a deterministic resultHash, so a VI Analyzer run becomes a CROSS-PLANE-comparable
// benchmark exactly like the mprr ring: register the metrics in the benchmark store, and crossPlaneCompare
// reports numeric deltas (test counts) + the resultHash digest (which MUST match when both planes analyze the
// same VIs with the same config). Deterministic + order-independent: the hash canonicalizes VI + test order.

import { createHash } from 'node:crypto';

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

export const VI_ANALYZER_RESULT_SCHEMA = 'labview-benchmark-actor/vi-analyzer-result@v1';
const RESULTS = new Set(['pass', 'fail', 'error']);

// Cross-plane determinism: sort by UTF-16 code unit, NOT String.localeCompare. localeCompare with no locale
// argument uses the runtime's default locale collation, which can differ between Windows and Linux -- that
// would canonicalize the same report differently on each plane and make the resultHash platform-dependent,
// breaking cross-plane parity. Code-unit order is byte-stable on every platform.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Summarize a normalized VI Analyzer report `{ config?, vis: [{ viPath, tests: [{ test, result }] }] }` into
 * comparable metrics + a deterministic resultHash. `result` is `pass` | `fail` | `error`. The summary is
 * canonicalized (VIs sorted by path, tests sorted by name) so the resultHash is independent of report ordering
 * -- two planes analyzing the same VIs with the same config produce the SAME resultHash.
 */
export function summarizeViAnalyzerReport(report) {
  assert(report && Array.isArray(report.vis) && report.vis.length > 0, 'report.vis required (non-empty)');

  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let errorTests = 0;
  const failuresByVi = [];

  const canonicalVis = report.vis
    .map((vi) => {
      assert(typeof vi.viPath === 'string' && vi.viPath, 'vi.viPath required');
      assert(Array.isArray(vi.tests), `vi ${vi.viPath} tests must be an array`);
      const tests = vi.tests
        .map((t) => {
          assert(typeof t.test === 'string' && t.test, `vi ${vi.viPath} has a test with no name`);
          assert(RESULTS.has(t.result), `vi ${vi.viPath} test ${t.test} has invalid result '${t.result}'`);
          return { test: t.test, result: t.result };
        })
        .sort((a, b) => byCodeUnit(a.test, b.test));
      let viFail = 0;
      for (const t of tests) {
        totalTests += 1;
        if (t.result === 'pass') {
          passedTests += 1;
        } else if (t.result === 'fail') {
          failedTests += 1;
          viFail += 1;
        } else {
          errorTests += 1;
          viFail += 1;
        }
      }
      if (viFail > 0) {
        failuresByVi.push({ viPath: vi.viPath, failCount: viFail });
      }
      return { viPath: vi.viPath, tests };
    })
    .sort((a, b) => byCodeUnit(a.viPath, b.viPath));

  // A viPath must be unique (a duplicate would make the resultHash ambiguous).
  for (let i = 1; i < canonicalVis.length; i += 1) {
    assert(canonicalVis[i].viPath !== canonicalVis[i - 1].viPath, `duplicate viPath: ${canonicalVis[i].viPath}`);
  }
  failuresByVi.sort((a, b) => byCodeUnit(a.viPath, b.viPath));

  const resultHash = createHash('sha256').update(JSON.stringify(canonicalVis)).digest('hex');
  const pass = failedTests === 0 && errorTests === 0;
  return {
    schema: VI_ANALYZER_RESULT_SCHEMA,
    config: report.config ?? null,
    totalVis: canonicalVis.length,
    totalTests,
    passedTests,
    failedTests,
    errorTests,
    pass,
    failuresByVi,
    resultHash,
  };
}

/** Project a VI Analyzer summary to benchmark-store metrics (numeric deltas + the resultHash digest). */
export function viAnalyzerBenchmarkMetrics(summary) {
  assert(summary && summary.schema === VI_ANALYZER_RESULT_SCHEMA, 'summary must be a vi-analyzer-result');
  return {
    totalVis: summary.totalVis,
    totalTests: summary.totalTests,
    passedTests: summary.passedTests,
    failedTests: summary.failedTests,
    errorTests: summary.errorTests,
    pass: summary.pass ? 1 : 0,
    resultHash: summary.resultHash,
  };
}
