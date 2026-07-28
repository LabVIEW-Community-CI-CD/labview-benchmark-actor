#!/usr/bin/env node
// Validate a NORMALIZED VI Analyzer report against the cross-plane input contract (vi-analyzer-report.schema.json,
// LBA-REQ-015) BEFORE registering it as a benchmark run. This is the WIN-plane pre-send self-check: a report that
// validates here summarizes to a deterministic, order-independent, locale-independent resultHash that the LINUX
// plane reproduces byte-for-byte, so the cross-plane compare matches on the first try.
//
// Run:  node experiments/vi-analyzer/validate-vi-analyzer-report.mjs <report.json>
// Exit: 0 = valid (prints totalVis/totalTests/resultHash); 1 = invalid (prints every error with its path).
//
// Dependency-free (the repo carries no JSON-Schema runtime): the checks below mirror the committed JSON Schema
// and the summarizer's teeth, but collect ALL errors with a JSON path instead of throwing on the first.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { summarizeViAnalyzerReport } from './viAnalyzerResult.mjs';

const FINDING_RESULTS = new Set(['fail', 'error']);
const SUMMARY_KEYS = new Set(['passed', 'failed', 'error', 'skipped', 'unloadable']);
const FINDING_KEYS = new Set(['viPath', 'test', 'result']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkCount(errors, summary, key, required) {
  if (!(key in summary)) {
    if (required) {
      errors.push(`summary.${key}: required (non-negative integer)`);
    }
    return null;
  }
  const v = summary[key];
  if (!Number.isInteger(v) || v < 0) {
    errors.push(`summary.${key}: must be a non-negative integer (got ${JSON.stringify(v)})`);
    return null;
  }
  return v;
}

/**
 * Validate a normalized VI Analyzer report (v2 real failure-oriented shape) against the cross-plane input
 * contract. Returns `{ ok, errors }` (never throws): `errors` is a list of `path: message` strings.
 */
export function validateViAnalyzerReport(report) {
  const errors = [];
  const push = (path, msg) => errors.push(`${path}: ${msg}`);

  if (!isPlainObject(report)) {
    return { ok: false, errors: ['(root): report must be an object'] };
  }
  if ('schema' in report && typeof report.schema !== 'string') {
    push('schema', 'must be a string when present');
  }
  if ('config' in report && !(typeof report.config === 'string' || isPlainObject(report.config) || report.config === null)) {
    push('config', 'must be a string, object, or null when present');
  }

  // summary (the run counts from the tool's completion line).
  let failed = null;
  let errored = null;
  if (!isPlainObject(report.summary)) {
    push('summary', 'required (object of run counts: passed, failed, error, ...)');
  } else {
    for (const k of Object.keys(report.summary)) {
      if (!SUMMARY_KEYS.has(k)) {
        push(`summary.${k}`, 'unknown property (allowed: passed, failed, error, skipped, unloadable)');
      }
    }
    checkCount(errors, report.summary, 'passed', true);
    failed = checkCount(errors, report.summary, 'failed', true);
    errored = checkCount(errors, report.summary, 'error', true);
    checkCount(errors, report.summary, 'skipped', false);
    checkCount(errors, report.summary, 'unloadable', false);
  }

  // findings (the enumerated failures + testing errors; empty for an all-pass run).
  if (!Array.isArray(report.findings)) {
    push('findings', 'required (array; empty for an all-pass run)');
    return { ok: errors.length === 0, errors };
  }
  const seen = new Map();
  let failFindings = 0;
  let errorFindings = 0;
  report.findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!isPlainObject(f)) {
      push(at, 'must be an object');
      return;
    }
    for (const k of Object.keys(f)) {
      if (!FINDING_KEYS.has(k)) {
        push(`${at}.${k}`, 'unknown property (allowed: viPath, test, result)');
      }
    }
    const hasPath = typeof f.viPath === 'string' && f.viPath.length > 0;
    const hasTest = typeof f.test === 'string' && f.test.length > 0;
    if (!hasPath) {
      push(`${at}.viPath`, 'must be a non-empty string');
    }
    if (!hasTest) {
      push(`${at}.test`, 'must be a non-empty string');
    }
    if (!FINDING_RESULTS.has(f.result)) {
      push(`${at}.result`, `must be fail|error (got ${JSON.stringify(f.result)})`);
    } else if (f.result === 'fail') {
      failFindings += 1;
    } else {
      errorFindings += 1;
    }
    if (hasPath && hasTest) {
      const key = `${f.viPath}\u0000${f.test}`;
      const prev = seen.get(key);
      if (prev !== undefined) {
        push(at, `duplicate finding ${f.viPath} / ${f.test} (also at findings[${prev}])`);
      } else {
        seen.set(key, i);
      }
    }
  });

  // Consistency teeth: the failure section enumerates EXACTLY the failed + error tests the summary counts.
  if (failed !== null && failed !== failFindings) {
    push('findings', `fail findings (${failFindings}) must equal summary.failed (${failed})`);
  }
  if (errored !== null && errored !== errorFindings) {
    push('findings', `error findings (${errorFindings}) must equal summary.error (${errored})`);
  }

  return { ok: errors.length === 0, errors };
}

// CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node validate-vi-analyzer-report.mjs <report.json>');
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`FAIL  could not read/parse ${path}: ${err.message}`);
    process.exit(1);
  }
  const { ok, errors } = validateViAnalyzerReport(report);
  if (!ok) {
    console.error(`FAIL  ${path} is not a valid VI Analyzer report (${errors.length} error(s)):`);
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }
  // Belt-and-suspenders: a valid report MUST summarize (the canonical cross-plane teeth) and yield a resultHash.
  const summary = summarizeViAnalyzerReport(report);
  console.log(`PASS  ${path} is a valid VI Analyzer report`);
  console.log(`  totalTests=${summary.totalTests} pass=${summary.passedTests} fail=${summary.failedTests} error=${summary.errorTests} findings=${summary.totalFindings}`);
  console.log(`  resultHash=${summary.resultHash}`);
  console.log('  -> register with: REPORT_PATH=' + path + ' node experiments/benchmark-store/register-vi-analyzer-run.mjs');
  process.exit(0);
}
