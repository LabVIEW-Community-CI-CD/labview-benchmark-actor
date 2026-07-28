#!/usr/bin/env node
// VI Analyzer RESULT model, absorbed dependency-free (operator directive: install + leverage VI Analyzer, like
// ni/labview-icon-editor). WIN installs the toolkit (cleanroom/docker-windows/install-vi-analyzer.ps1) and runs
// it on real VIs via `LabVIEWCLI -OperationName RunVIAnalyzer -ConfigPath <.viancfg> -ReportSaveType ASCII`;
// that report is FAILURE-ORIENTED (a run summary of counts + only the failures/errors enumerated per VI, never
// passes). This module summarizes a NORMALIZED report (the shape a plane's parser emits from that ASCII report)
// into comparable metrics + a deterministic resultHash, so a VI Analyzer run becomes a CROSS-PLANE-comparable
// benchmark exactly like the mprr ring: register the metrics in the benchmark store, and crossPlaneCompare
// reports numeric deltas (counts) + the resultHash digest (which MUST match when both planes summarize the same
// report). Deterministic + order-independent + locale-independent: the hash canonicalizes the findings order.

import { createHash } from 'node:crypto';

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

export const VI_ANALYZER_RESULT_SCHEMA = 'labview-benchmark-actor/vi-analyzer-result@v2';
// The real LabVIEWCLI RunVIAnalyzer report is FAILURE-ORIENTED: it emits a run SUMMARY (passed/failed/error/
// skipped/unloadable counts) and enumerates ONLY the failures + testing errors per VI -- passes are never
// listed (no "show passed" toggle). So the faithful normalized shape is a summary of counts + a findings list;
// findings are only `fail` | `error`. A clean all-pass run (e.g. the icon-editor CI gate) is summary counts
// with an EMPTY findings list -- the honest signal.
const FINDING_RESULTS = new Set(['fail', 'error']);

// Cross-plane determinism: sort by UTF-16 code unit, NOT String.localeCompare. localeCompare with no locale
// argument uses the runtime's default locale collation, which can differ between Windows and Linux -- that
// would canonicalize the same report differently on each plane and make the resultHash platform-dependent,
// breaking cross-plane parity. Code-unit order is byte-stable on every platform.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function count(summary, key) {
  const v = summary[key];
  if (v === undefined) {
    return 0;
  }
  assert(Number.isInteger(v) && v >= 0, `summary.${key} must be a non-negative integer`);
  return v;
}

/**
 * Summarize a normalized VI Analyzer report into comparable metrics + a deterministic resultHash. The report
 * is the tool's REAL failure-oriented shape:
 *   `{ config?, summary: { passed, failed, error, skipped?, unloadable? }, findings: [{ viPath, test, result }] }`
 * where `result` is `fail` | `error` (findings enumerate ONLY failures/errors). The findings are canonicalized
 * (sorted by viPath then test, code-unit) so the resultHash is independent of report ordering -- two planes
 * summarizing the same report produce the SAME resultHash. Consistency teeth: the findings count for each
 * result MUST equal the matching summary count (the failure section enumerates exactly the failed+error tests).
 */
export function summarizeViAnalyzerReport(report) {
  assert(report && typeof report === 'object', 'report must be an object');
  assert(report.summary && typeof report.summary === 'object', 'report.summary required (run counts)');
  assert(Array.isArray(report.findings), 'report.findings required (array; empty for an all-pass run)');

  const passed = count(report.summary, 'passed');
  const failed = count(report.summary, 'failed');
  const errored = count(report.summary, 'error');
  const skipped = count(report.summary, 'skipped');
  const unloadable = count(report.summary, 'unloadable');

  const canonicalFindings = report.findings
    .map((f) => {
      assert(f && typeof f.viPath === 'string' && f.viPath, 'finding.viPath required');
      assert(typeof f.test === 'string' && f.test, `finding for ${f.viPath} has no test name`);
      assert(FINDING_RESULTS.has(f.result), `finding ${f.viPath}/${f.test} has invalid result '${f.result}' (fail|error)`);
      return { viPath: f.viPath, test: f.test, result: f.result };
    })
    .sort((a, b) => byCodeUnit(a.viPath, b.viPath) || byCodeUnit(a.test, b.test));

  // A (viPath, test) finding must be unique (a duplicate would make the resultHash ambiguous).
  for (let i = 1; i < canonicalFindings.length; i += 1) {
    const prev = canonicalFindings[i - 1];
    const cur = canonicalFindings[i];
    assert(!(prev.viPath === cur.viPath && prev.test === cur.test), `duplicate finding: ${cur.viPath} / ${cur.test}`);
  }

  // Consistency: the failure section enumerates EXACTLY the failed + error tests the summary counts.
  const failFindings = canonicalFindings.filter((f) => f.result === 'fail').length;
  const errorFindings = canonicalFindings.filter((f) => f.result === 'error').length;
  assert(failFindings === failed, `findings with result=fail (${failFindings}) must equal summary.failed (${failed})`);
  assert(errorFindings === errored, `findings with result=error (${errorFindings}) must equal summary.error (${errored})`);

  const byVi = new Map();
  for (const f of canonicalFindings) {
    byVi.set(f.viPath, (byVi.get(f.viPath) || 0) + 1);
  }
  const findingsByVi = [...byVi.entries()]
    .map(([viPath, findingCount]) => ({ viPath, findingCount }))
    .sort((a, b) => byCodeUnit(a.viPath, b.viPath));

  // The resultHash canonicalizes over the run counts + the sorted findings (NOT config -- the benchmarkId
  // already scopes the comparison to the same config). Fixed key order keeps the serialization byte-stable.
  const canonicalSummary = { passed, failed, error: errored, skipped, unloadable };
  const resultHash = createHash('sha256')
    .update(JSON.stringify({ summary: canonicalSummary, findings: canonicalFindings }))
    .digest('hex');

  const totalTests = passed + failed + errored + skipped + unloadable;
  const pass = failed === 0 && errored === 0;
  return {
    schema: VI_ANALYZER_RESULT_SCHEMA,
    config: report.config ?? null,
    totalTests,
    passedTests: passed,
    failedTests: failed,
    errorTests: errored,
    skippedTests: skipped,
    unloadableTests: unloadable,
    totalFindings: canonicalFindings.length,
    findingsByVi,
    pass,
    resultHash,
  };
}

/** Project a VI Analyzer summary to benchmark-store metrics (numeric deltas + the resultHash digest). */
export function viAnalyzerBenchmarkMetrics(summary) {
  assert(summary && summary.schema === VI_ANALYZER_RESULT_SCHEMA, 'summary must be a vi-analyzer-result');
  return {
    totalTests: summary.totalTests,
    passedTests: summary.passedTests,
    failedTests: summary.failedTests,
    errorTests: summary.errorTests,
    skippedTests: summary.skippedTests,
    unloadableTests: summary.unloadableTests,
    totalFindings: summary.totalFindings,
    pass: summary.pass ? 1 : 0,
    resultHash: summary.resultHash,
  };
}
