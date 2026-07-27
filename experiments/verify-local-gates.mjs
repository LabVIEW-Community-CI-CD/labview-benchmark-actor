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

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { corroborationConfidence, REAL_READBACK_CASES } from './corroboration-confidence-reference.mjs';

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

// 3b. Canonical shared self-test-conformance inputs pinned with contract-(a) shapes.
check('self-test-conformance-inputs-pinned', () => {
  const dir = join('experiments', 'self-test-conformance', 'inputs');
  const ledger = readJson(join(dir, 'ground-truth-ledger.json'));
  assert(ledger.schemaVersion === 'mprr-self-test-ground-truth-ledger-v1', 'ground-truth-ledger schemaVersion mismatch');
  assert(ledger.timingAuthority?.tickIntervalMilliseconds === 10, 'tickIntervalMilliseconds must be 10');
  assert(ledger.timingAuthority?.periodicEventId === 'stopwatch-tick', 'periodicEventId must be stopwatch-tick');
  const surface = readJson(join(dir, 'surface-metadata.json'));
  assert(surface.schemaVersion === 'mprr-self-test-surface-v1', 'surface-metadata schemaVersion mismatch');
  assert(surface.groundTruthLedgerPath === 'ground-truth-ledger.json', 'surface groundTruthLedgerPath must be the relative portable reference');
  const events = readFileSync(join(pkgRoot, dir, 'operator-events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(events.length === 3, `operator-events must have 3 events, got ${events.length}`);
  assert(
    events.map((e) => e.kind).join(',') === 'cursor-sample,click,keyboard',
    `unexpected operator-event kinds: ${events.map((e) => e.kind).join(',')}`
  );
  return { events: events.length, ledgerTick: ledger.timingAuthority.tickIntervalMilliseconds };
});

// 4. Ring-buffer mirror replay proof is deterministic and monotonic.
check('ring-buffer-mirror-replay-deterministic', () => {
  const receipt = readJson('experiments/ring-buffer-mirror/receipt.json');
  const replay = receipt.chain?.syntheticReplayProof;
  assert(replay, 'syntheticReplayProof missing');
  assert(/^[0-9a-f]{64}$/.test(replay.actionDigestSha256 || ''), 'actionDigestSha256 must be 64 hex chars');
  assert(replay.monotonicPacketSequence === true && replay.monotonicLogicalTimeline === true, 'replay timeline must be monotonic');
  assert(replay.fixtureManifestValidation?.passed === true, 'fixtureManifestValidation must pass');
  assert(/^[0-9a-f]{64}$/.test(receipt.crossPlaneMirror?.portableActionDigestSha256 || ''), 'portable cross-plane digest must be present');
  return { actionDigestSha256: replay.actionDigestSha256, portable: receipt.crossPlaneMirror.portableActionDigestSha256 };
});

// 5. RTM structure + every "Proven" row cites at least one existing evidence path.
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
// 6. ADR index integrity: every ADR file is indexed and every index row resolves,
//    and each ADR heading number matches its filename (guards ADR/index drift).
check('adr-index-integrity', () => {
  const adrDir = join(pkgRoot, 'docs', 'architecture', 'adr');
  const files = readdirSync(adrDir)
    .filter((f) => /^ADR-\d{4}-.*\.md$/.test(f))
    .sort();
  assert(files.length > 0, 'no ADR files found');
  const readme = readFileSync(join(adrDir, 'README.md'), 'utf8');
  const linked = [...readme.matchAll(/\|\s*\[ADR-\d{4}\]\((ADR-\d{4}-[^)]+\.md)\)/g)].map((m) => m[1]);
  const linkedSet = new Set(linked);
  for (const f of files) {
    assert(linkedSet.has(f), `ADR file ${f} is not listed in the index README`);
    const num = f.slice(4, 8);
    const heading = readFileSync(join(adrDir, f), 'utf8').split(/\r?\n/, 1)[0];
    assert(heading.startsWith(`# ADR-${num}:`), `${f} heading must start with "# ADR-${num}:"`);
  }
  for (const l of linked) {
    assert(files.includes(l), `index links ${l} but the file does not exist`);
  }
  return { adrFiles: files.length, indexed: linked.length };
});

// 7. corroborationConfidence reference matches the real OCR readbacks (ADR-0007 fidelity metric).
check('corroboration-confidence-reference', () => {
  for (const c of REAL_READBACK_CASES) {
    const got = corroborationConfidence(c.canonicalObservedText, c.rawOcrText);
    assert(got.corroborationConfidence === c.expect.corroborationConfidence, `${c.fontSizePt}pt confidence ${got.corroborationConfidence} != ${c.expect.corroborationConfidence}`);
    assert(got.fractionalTailMatched === c.expect.fractionalTailMatched, `${c.fontSizePt}pt tailMatched ${got.fractionalTailMatched} != ${c.expect.fractionalTailMatched}`);
  }
  let threw = false;
  try { corroborationConfidence('not-a-time', ''); } catch { threw = true; }
  assert(threw, 'corroborationConfidence must reject a non hh:mm:ss.cc canonical');
  return { cases: REAL_READBACK_CASES.length };
});

// 8. WIN plane-3 native-Windows cross-check receipt is authoritative with zero skew (mirrors the LINUX receipt).
check('windows-crosscheck-receipt-authoritative', () => {
  const r = readJson(join('experiments', 'self-test-conformance', 'receipt-windows-crosscheck.json'));
  assert(r.schemaVersion === 'mprr-self-test-transport-conformance-v1', 'crosscheck schemaVersion mismatch');
  assert(r.authoritativeOutcome === 'authoritative', `authoritativeOutcome must be authoritative, got ${r.authoritativeOutcome}`);
  assert(Array.isArray(r.missingComparisons) && r.missingComparisons.length === 0, 'missingComparisons must be empty');
  assert(r.imageTimingComparison?.maxAbsoluteSkewMilliseconds === 0 && r.imageTimingComparison?.sampleCount === 3, 'image timing must be 3 samples, 0 skew');
  assert(r.tdmsShortPacketTimingComparison?.maxAbsoluteSkewMilliseconds === 0 && r.tdmsShortPacketTimingComparison?.comparedEventCount === 5, 'tdms short-packet must be 5 events, 0 skew');
  const reader = r.readerProjectionComparison;
  assert(reader?.maxAbsoluteSkewMilliseconds === 0 && (reader.comparedEventCount ?? reader.sampleCount) === 5, 'reader projection must be 5 events, 0 skew');
  assert(r.winCrossCheckProvenance?.crossCheckPlane, 'winCrossCheckProvenance.crossCheckPlane must be present');
  return { outcome: r.authoritativeOutcome, packets: r.replayPlanPacketCount };
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
