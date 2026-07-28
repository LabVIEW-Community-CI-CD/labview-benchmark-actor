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

const RESULTS = new Set(['pass', 'fail', 'error']);
const VI_KEYS = new Set(['viPath', 'tests']);
const TEST_KEYS = new Set(['test', 'result']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate a normalized VI Analyzer report against the cross-plane input contract.
 * Returns `{ ok, errors }` (never throws): `errors` is a list of `path: message` strings.
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
  if (!Array.isArray(report.vis) || report.vis.length === 0) {
    push('vis', 'must be a non-empty array');
    return { ok: false, errors };
  }

  const seenPaths = new Map();
  report.vis.forEach((vi, i) => {
    const at = `vis[${i}]`;
    if (!isPlainObject(vi)) {
      push(at, 'must be an object');
      return;
    }
    for (const k of Object.keys(vi)) {
      if (!VI_KEYS.has(k)) {
        push(`${at}.${k}`, 'unknown property (allowed: viPath, tests)');
      }
    }
    if (typeof vi.viPath !== 'string' || vi.viPath.length === 0) {
      push(`${at}.viPath`, 'must be a non-empty string');
    } else {
      const prev = seenPaths.get(vi.viPath);
      if (prev !== undefined) {
        push(`${at}.viPath`, `duplicate viPath (also at vis[${prev}]); a duplicate makes the resultHash ambiguous`);
      } else {
        seenPaths.set(vi.viPath, i);
      }
    }
    if (!Array.isArray(vi.tests)) {
      push(`${at}.tests`, 'must be an array');
      return;
    }
    vi.tests.forEach((t, j) => {
      const tat = `${at}.tests[${j}]`;
      if (!isPlainObject(t)) {
        push(tat, 'must be an object');
        return;
      }
      for (const k of Object.keys(t)) {
        if (!TEST_KEYS.has(k)) {
          push(`${tat}.${k}`, 'unknown property (allowed: test, result)');
        }
      }
      if (typeof t.test !== 'string' || t.test.length === 0) {
        push(`${tat}.test`, 'must be a non-empty string');
      }
      if (!RESULTS.has(t.result)) {
        push(`${tat}.result`, `must be one of pass|fail|error (got ${JSON.stringify(t.result)})`);
      }
    });
  });

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
  console.log(`  totalVis=${summary.totalVis} totalTests=${summary.totalTests} pass=${summary.passedTests} fail=${summary.failedTests} error=${summary.errorTests}`);
  console.log(`  resultHash=${summary.resultHash}`);
  console.log('  -> register with: REPORT_PATH=' + path + ' node experiments/benchmark-store/register-vi-analyzer-run.mjs');
  process.exit(0);
}
