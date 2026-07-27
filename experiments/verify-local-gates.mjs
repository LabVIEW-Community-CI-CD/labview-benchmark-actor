#!/usr/bin/env node
// labview-benchmark-actor — local CI/CD verification gate.
//
// Dependency-free ESM (Node >= 18). Re-validates the retained experiment
// receipts and the RTM "Proven" evidence so the specification package has a
// REAL, re-runnable pass/fail pipeline rather than static evidence files.
//
// This gate is intentionally cross-platform: it runs identically on a
// linux-native and a windows-native runner (see .github/workflows/lba-local-gates.yml).
// That parity is the near-term horizon — linux-native mirroring the same mprr
// ring-buffer read/replay capability windows-native has (best effort). The
// ring-buffer READ/replay path is already cross-platform (the mprr
// ReviewCaptureTransportReader targets net8.0 plain); only surface render and
// Windows.Media.Ocr image-derived-timing production remain windows-bound.
//
// Usage:
//   node experiments/verify-local-gates.mjs [--json] [--out <path>]
// Exit code 0 when every check passes, 1 otherwise.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..'); // experiments/ -> package root

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0 ? args[outIndex + 1] : null;

const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, pass: true, detail: detail ?? null });
  } catch (error) {
    checks.push({ name, pass: false, error: String(error && error.message ? error.message : error) });
  }
}
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
function readJson(relPath) {
  return JSON.parse(readFileSync(join(pkgRoot, relPath), 'utf8'));
}
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// 1. Bus-prototype receipt is green (LBA-REQ-006/007, T-007).
check('bus-prototype-receipt-green', () => {
  const receipt = readJson('experiments/bus-prototype/receipt.json');
  assert(receipt.total > 0, 'total must be > 0');
  assert(receipt.passed === receipt.total, `passed ${receipt.passed} != total ${receipt.total}`);
  assert(receipt.failed === 0, `failed ${receipt.failed} must be 0`);
  assert(Array.isArray(receipt.results) && receipt.results.every((r) => r.pass === true), 'every result must pass');
  return { total: receipt.total, passed: receipt.passed, failed: receipt.failed };
});

// 2. OCR-primitive engine available and readback byte-exact (image-fidelity leg).
check('ocr-primitive-engine-and-readback', () => {
  const receipt = readJson('experiments/ocr-primitive-proof/receipt.json');
  assert(receipt.ocrEngine && receipt.ocrEngine.available === true, 'ocrEngine.available must be true');
  assert(receipt.positiveReadback?.bitStream?.exact === true, 'bitStream readback must be byte-exact');
  assert(receipt.positiveReadback?.statusLine?.exact === true, 'statusLine readback must be byte-exact');
  return { recognizerLanguages: receipt.ocrEngine.recognizerLanguages };
});

// 3. mprr-live-capture shared retained inputs are present (both planes bind these).
check('mprr-live-capture-shared-inputs-present', () => {
  for (const name of ['ground-truth-ledger.json', 'surface-metadata.json']) {
    assert(existsSync(join(pkgRoot, 'experiments', 'mprr-live-capture', name)), `missing experiments/mprr-live-capture/${name}`);
  }
  return { dir: 'experiments/mprr-live-capture' };
});

// 4. RTM structure + every "Proven" row cites at least one existing evidence path.
check('rtm-proven-rows-cite-existing-evidence', () => {
  const rows = readFileSync(join(pkgRoot, 'docs', 'requirements', 'rtm.csv'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(parseCsvLine);
  const header = rows.shift();
  const expected = ['ReqID', 'Requirement', 'TestID', 'CodeRef', 'Status', 'Notes'];
  assert(header.length === expected.length && expected.every((h, i) => header[i] === h), `RTM header must be ${expected.join(',')}`);
  let provenChecked = 0;
  for (const row of rows) {
    assert(row.length === expected.length, `RTM row for ${row[0]} has ${row.length} columns, expected ${expected.length}`);
    const [reqId, requirement, testId, codeRef, status] = row;
    assert(/\bshall\b/i.test(requirement), `${reqId} requirement text must contain "shall"`);
    assert(testId.trim().length > 0, `${reqId} must map to a TestID`);
    if (status.trim() === 'Proven') {
      const candidates = codeRef.split(';').map((p) => p.trim()).filter((p) => p.length > 0 && !p.startsWith('('));
      const existing = candidates.filter((p) => existsSync(join(pkgRoot, p)));
      assert(existing.length > 0, `${reqId} is Proven but no CodeRef path exists: ${codeRef}`);
      provenChecked += 1;
    }
  }
  return { rowsChecked: rows.length, provenChecked };
});

const passed = checks.filter((c) => c.pass).length;
const failed = checks.length - passed;
const receipt = {
  schema: 'lba/local-gates@1',
  ranAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  total: checks.length,
  passed,
  failed,
  results: checks
};

if (outPath) {
  writeFileSync(resolve(process.cwd(), outPath), `${JSON.stringify(receipt, null, 2)}\n`);
}
if (asJson) {
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} else {
  for (const c of checks) {
    process.stdout.write(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : `  -- ${c.error}`}\n`);
  }
  process.stdout.write(`\n${passed}/${checks.length} checks passed on ${receipt.platform} (node ${receipt.node})\n`);
}
process.exit(failed === 0 ? 0 : 1);
