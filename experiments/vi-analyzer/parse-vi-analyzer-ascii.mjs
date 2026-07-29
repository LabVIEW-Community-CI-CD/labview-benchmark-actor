#!/usr/bin/env node
// Parse a REAL LabVIEWCLI RunVIAnalyzer ASCII report into the v2 normalized report shape (LBA-REQ-015), so the
// WIN plane does NOT have to hand-write a parser. The tool report is FAILURE-ORIENTED: a completion line gives
// the run counts, and the failure sections enumerate only the failures/errors. This emits:
//   { schema, config?, summary: { passed, failed, error, skipped, unloadable }, findings: [{ viPath, test, result }] }
//
// Usage:
//   node experiments/vi-analyzer/parse-vi-analyzer-ascii.mjs <report.txt> [--config <name>] > report.json
//   node experiments/vi-analyzer/validate-vi-analyzer-report.mjs report.json   # confirm before committing
//
// Reliability:
//   - The COMPLETION LINE ("VI Analyzer completed. N tests passed, M failed, K skipped, U unloadable, E error")
//     is parsed robustly (each count matched independently, order-insensitive). This FULLY handles a clean
//     all-pass run (the real icon-editor gate): summary counts + an EMPTY findings array.
//   - FINDINGS extraction (the "Failed Tests (sorted by VI)" / "Testing Errors" sections) is BEST-EFFORT: the
//     exact per-VI/per-test line format varies. If the parser cannot recover as many findings as the summary
//     counts, the downstream validator's consistency teeth (fail/error findings MUST equal summary.failed/error)
//     will REJECT the report -- so a mismatch is caught, never silently shipped. For a non-all-pass run, verify
//     the findings against your real report (or extend `extractFindings` below to your exact format).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

/** Each count regex matches BOTH the compact summary form ("452 tests passed, 0 failed, ...") and the real
 * line-per-count ASCII form LabVIEWCLI actually emits ("452 tests passed.\n0 tests failed.\n0 tests produced
 * error.\n0 VIs were unloadable.\n0 tests were unloadable.\n0 tests were unrunable.\n..."). The leading integer
 * of the matched span is the count. */
const COUNT_PATTERNS = {
  passed: /(\d+)\s+(?:tests?\s+)?passed/i,
  failed: /(\d+)\s+(?:tests?\s+)?failed/i,
  // "0 error" (summary form) or "0 tests produced error" (real form).
  error: /(\d+)(?:\s+tests?)?(?:\s+produced)?\s+errors?/i,
  skipped: /(\d+)\s+(?:tests?\s+)?skipped/i,
  // "0 unloadable" or "0 tests were unloadable" -- deliberately NOT "N VIs were unloadable" (VI-level count).
  unloadable: /(\d+)\s+(?:tests?\s+(?:were\s+)?)?unloadable/i,
};

function matchCount(text, key) {
  const m = text.match(COUNT_PATTERNS[key]);
  return m ? parseInt(m[1], 10) : 0;
}

export function parseSummary(text) {
  // The v2 summary carries the five canonical TEST-level counts. VI Analyzer also prints "N VIs were unloadable"
  // (VI-level) and "N tests were unrunable"; those are intentionally not part of the v2 summary (all 0 for a
  // clean all-pass run). Keeping the five counts stable preserves the established cross-plane resultHash.
  return {
    passed: matchCount(text, 'passed'),
    failed: matchCount(text, 'failed'),
    error: matchCount(text, 'error'),
    skipped: matchCount(text, 'skipped'),
    unloadable: matchCount(text, 'unloadable'),
  };
}

/**
 * Best-effort extraction of the enumerated failures/errors. VI Analyzer ASCII lists a VI path (often a line
 * ending in `.vi`) followed by its flagged test lines until the next VI or a blank/section boundary. This
 * heuristic groups test lines under the most recent `.vi` path within the failure sections. Returns
 * `[{ viPath, test, result }]` with result inferred from the section (fail vs error). Verify against your real
 * report; the validator's consistency teeth are the safety net.
 */
export function extractFindings(text) {
  const lines = text.split(/\r?\n/);
  const findings = [];
  let section = null; // 'fail' | 'error' | null
  let currentVi = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^Failed Tests\b/i.test(line)) { section = 'fail'; currentVi = null; continue; }
    if (/^Testing Errors\b/i.test(line)) { section = 'error'; currentVi = null; continue; }
    if (/^(Passed Tests|VI Analyzer completed|Summary)\b/i.test(line)) { section = null; currentVi = null; continue; }
    if (!section || !line) { continue; }
    // A VI header line ends in `.vi` (optionally with a trailing colon).
    const viMatch = line.match(/^(.*\.vi)\s*:?\s*$/i);
    if (viMatch) { currentVi = viMatch[1]; continue; }
    // Otherwise, within a section under a VI, treat the line as a flagged test name (strip bullets/indentation).
    if (currentVi) {
      const test = line.replace(/^[-*\u2022\s]+/, '').replace(/\s*:.*$/, '').trim();
      if (test) { findings.push({ viPath: currentVi, test, result: section }); }
    }
  }
  return findings;
}

export function parseAsciiReport(text, config) {
  const summary = parseSummary(text);
  const findings = extractFindings(text);
  const report = { schema: 'vi-analyzer-report@v2', findings };
  if (config) { report.config = config; }
  report.summary = summary;
  // Emit a stable key order: schema, config, summary, findings.
  return { schema: report.schema, ...(config ? { config } : {}), summary, findings };
}

// CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const cfgIdx = args.indexOf('--config');
  const config = cfgIdx >= 0 ? args[cfgIdx + 1] : undefined;
  const path = args.find((a, i) => a !== '--config' && !(cfgIdx >= 0 && i === cfgIdx + 1));
  if (!path) {
    console.error('usage: node parse-vi-analyzer-ascii.mjs <report.txt> [--config <name>] > report.json');
    process.exit(2);
  }
  const text = readFileSync(path, 'utf8');
  const report = parseAsciiReport(text, config || basename(path).replace(/\.[^.]*$/, ''));
  const total = report.summary.failed + report.summary.error;
  if (report.findings.length !== total) {
    console.error(
      `WARN: extracted ${report.findings.length} finding(s) but summary says ${total} (failed=${report.summary.failed} error=${report.summary.error}). ` +
        'For an all-pass run this is 0/0 (fine). Otherwise extend extractFindings() to your report format; the validator will reject a mismatch.',
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
