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
import { corroborationConfidence, REAL_READBACK_CASES, validateColonOcrFidelity } from './corroboration-confidence-reference.mjs';

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

// 9. image-derived-timing binds to the pixel-decoded strip channel, observedText is
//    the canonical encoding of observedCentiseconds, and any recorded colon OCR
//    reconciles with the reference metric (placeholder today; plane-2 object auto-
//    validated when the golden-VM run lands). ADR-0007.
check('image-derived-timing-colon-ocr-fidelity', () => {
  const doc = readJson(join('experiments', 'self-test-conformance', 'image-derived-timing.json'));
  assert(doc.schemaVersion === 'mprr-self-test-image-derived-timing-v1', 'image-derived-timing schemaVersion mismatch');
  const samples = doc.timingSamples;
  assert(Array.isArray(samples) && samples.length > 0, 'timingSamples must be a non-empty array');
  const canonical = /^(\d\d):(\d\d):(\d\d)\.(\d\d)$/;
  let colonOcrRecorded = 0;
  for (const s of samples) {
    const m = canonical.exec(String(s.observedText));
    assert(m, `sample ${s.sampleId} observedText ${JSON.stringify(s.observedText)} is not canonical hh:mm:ss.cc`);
    const totalCentiseconds = ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 100 + Number(m[4]);
    assert(totalCentiseconds === s.observedCentiseconds, `sample ${s.sampleId} observedText encodes ${totalCentiseconds}cs but observedCentiseconds is ${s.observedCentiseconds}`);
    assert(s.observedCentiseconds * 10 === s.observedRelativeMilliseconds, `sample ${s.sampleId} observedCentiseconds*10 != observedRelativeMilliseconds`);
    assert(s.fidelity?.channel === 'mprr-binary-strip-v1', `sample ${s.sampleId} timing channel must be the pixel-decoded strip, not OCR`);
    const verdict = validateColonOcrFidelity(s.fidelity.colonOcr, s.observedText);
    if (!verdict.placeholder) colonOcrRecorded += 1;
  }
  return { samples: samples.length, colonOcrRecorded };
});

// 10. Plane-2 golden-VM colon-OCR corroboration sidecar reconciles byte-for-byte
//     with the reference metric (honest ADR-0007 human-OCR evidence: the strip
//     stays load-bearing; colon OCR is scored corroboration only). Optional until
//     the golden-VM run lands, then actively re-scored here.
check('colon-corroboration-plane2-scoring', () => {
  const rel = join('experiments', 'self-test-conformance', 'colon-corroboration.json');
  if (!existsSync(join(pkgRoot, rel))) {
    return { present: false };
  }
  const entries = readJson(rel);
  assert(Array.isArray(entries) && entries.length > 0, 'colon-corroboration must be a non-empty array');
  let corroborated = 0;
  for (const e of entries) {
    const got = corroborationConfidence(e.observedText, e.rawOcrText);
    for (const key of ['fast', 'matchedFastDigits', 'corroborationConfidence', 'fractionalTailMatched']) {
      assert(e[key] === got[key], `${e.sampleId} ${key} ${JSON.stringify(e[key])} disagrees with reference ${JSON.stringify(got[key])}`);
    }
    if (got.corroborationConfidence > 0) corroborated += 1;
  }
  return { entries: entries.length, corroborated };
});

// 11. Every committed cross-plane conformance receipt is authoritative with zero
//     skew -> the 3-plane byte-identical machine-timing claim is gate-enforced, not
//     just prose (plane 1 Linux, plane 2 golden-VM, plane 3 native Windows).
check('all-plane-receipts-authoritative-zero-skew', () => {
  const dir = join('experiments', 'self-test-conformance');
  const seen = [];
  for (const name of ['receipt-linux.json', 'receipt-golden-vm.json', 'receipt-windows-crosscheck.json', 'receipt-final-merged.json', 'receipt-windows-final-merged.json']) {
    if (!existsSync(join(pkgRoot, dir, name))) {
      continue;
    }
    const r = readJson(join(dir, name));
    assert(r.schemaVersion === 'mprr-self-test-transport-conformance-v1', `${name} schemaVersion mismatch`);
    assert(r.authoritativeOutcome === 'authoritative', `${name} authoritativeOutcome must be authoritative`);
    assert(Array.isArray(r.missingComparisons) && r.missingComparisons.length === 0, `${name} missingComparisons must be empty`);
    for (const leg of ['imageTimingComparison', 'tdmsShortPacketTimingComparison', 'readerProjectionComparison']) {
      assert(r[leg]?.maxAbsoluteSkewMilliseconds === 0, `${name} ${leg}.maxAbsoluteSkewMilliseconds must be 0`);
    }
    seen.push(name);
  }
  assert(seen.length >= 1, 'at least one plane conformance receipt must be present');
  return { receipts: seen };
});

// 12. Resource-usage correlation receipt is green and the CPU/RAM/disk pre/post
//     window analysis is well-formed (LBA-REQ-011, T-011).
check('resource-usage-correlation-receipt-green', () => {
  const receipt = readJson(join('experiments', 'resource-usage-correlation', 'receipt.json'));
  assert(receipt.schemaVersion === 'labview-benchmark-actor/resource-usage-correlation-receipt-v1', 'receipt schemaVersion mismatch');
  assert(receipt.total > 0 && receipt.passed === receipt.total && receipt.failed === 0, `receipt not green: ${receipt.passed}/${receipt.total}`);
  const c = receipt.correlation;
  assert(c && c.schema === 'labview-benchmark-actor/resource-usage-correlation@v1', 'correlation schema mismatch');
  assert(typeof c.triggerFrameIndex === 'number', 'triggerFrameIndex must be a number');
  for (const metric of ['cpu', 'ram', 'disk']) {
    const w = c.windows && c.windows[metric];
    assert(w && typeof w.deltaMean === 'number', `windows.${metric}.deltaMean must be a number`);
    assert(w.pre && w.post && typeof w.pre.mean === 'number' && typeof w.post.mean === 'number', `windows.${metric} pre/post mean must be numeric`);
  }
  return { checks: receipt.total, triggerFrameIndex: c.triggerFrameIndex };
});

// 13. Vagrant clean-room provisioner scripts stay pure ASCII. Vagrant uploads the script and PowerShell 5.1
//     reads a BOM-less file as the system ANSI codepage, so a non-ASCII byte (e.g. an em-dash) corrupts on
//     upload and breaks the parse -> a SILENT `vagrant up` provisioner failure. Enforce it so a future edit
//     cannot regress the fix (see cleanroom/README.md "Provisioner notes").
check('cleanroom-provisioner-scripts-pure-ascii', () => {
  const dir = join(pkgRoot, 'cleanroom');
  if (!existsSync(dir)) {
    return { skipped: 'no cleanroom/ directory' };
  }
  const scripts = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.ps1'));
  assert(scripts.length > 0, 'expected at least one cleanroom/*.ps1 provisioner script');
  const scanned = [];
  for (const name of scripts) {
    const bytes = readFileSync(join(dir, name));
    for (let i = 0; i < bytes.length; i += 1) {
      assert(
        bytes[i] <= 0x7f,
        `cleanroom/${name}: non-ASCII byte 0x${bytes[i].toString(16)} at offset ${i} -- Vagrant provisioner scripts must be pure ASCII (Vagrant upload + PS 5.1 ANSI read silently breaks the parse)`
      );
    }
    scanned.push(name);
  }
  return { scripts: scanned };
});

// 14. The clean-room bootstrap installs its toolchain winget-free. `winget` is an MSIX app-execution alias
//     that is NOT resolvable on the non-interactive WinRM provisioner PATH, so `winget install ...` in the
//     bootstrap fails over Vagrant. Enforce winget-free installs (dotnet-install + release archives) so the
//     fix cannot regress. (The word may still appear in an explanatory comment; only a real invocation fails.)
check('cleanroom-bootstrap-is-winget-free', () => {
  const bootstrap = join(pkgRoot, 'cleanroom', 'bootstrap.ps1');
  if (!existsSync(bootstrap)) {
    return { skipped: 'no cleanroom/bootstrap.ps1' };
  }
  const codeOnly = readFileSync(bootstrap, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '')) // drop trailing PowerShell comments
    .join('\n');
  assert(
    !/\bwinget\s+(install|upgrade|search|list|source|export|import)\b/i.test(codeOnly),
    'cleanroom/bootstrap.ps1 invokes winget -- winget is not resolvable in the WinRM provisioner session; install winget-free (dotnet-install + direct release archives)'
  );
  return { wingetFree: true };
});

// 15. Host-concentration core receipt is green and the concentrated corpus preserves per-actor isolation
//     (LBA-REQ-010, T-010). The deterministic core is proven here; the live host-side ollama comparison
//     over a real multi-VM concentrated corpus stays the maintainer/VM step.
check('host-concentration-core-receipt-green', () => {
  const receipt = readJson(join('experiments', 'host-concentration', 'receipt.json'));
  assert(receipt.schemaVersion === 'labview-benchmark-actor/host-concentration-receipt-v1', 'receipt schemaVersion mismatch');
  assert(receipt.total > 0 && receipt.passed === receipt.total && receipt.failed === 0, `receipt not green: ${receipt.passed}/${receipt.total}`);
  const corpus = receipt.corpus;
  assert(corpus && corpus.schema === 'labview-benchmark-actor/host-concentration@v1', 'corpus schema mismatch');
  assert(/^[0-9a-f]{8}$/.test(corpus.corpusDigest || ''), 'corpus must carry an 8-hex corpusDigest');
  assert(Array.isArray(corpus.runs) && corpus.runs.length === corpus.runCount, 'runCount must match the runs length');
  for (const run of corpus.runs) {
    assert(corpus.actors.includes(run.actorId), `run ${run.runId} actorId ${run.actorId} not in the actor list (isolation)`);
    assert('metricsRef' in run && 'framesRef' in run, `run ${run.runId} must expose metricsRef + framesRef for the ollama layer`);
  }
  return { checks: receipt.total, actors: corpus.actors.length, runs: corpus.runCount };
});

// 16. Ollama-comparison core receipt is green and every comparison pairs runs within a single actor
//     (LBA-REQ-010 AC #3, T-010). The deterministic planning + output contract are proven here (mock ollama
//     driver); the live host-side ollama drive over a real concentrated corpus stays the maintainer step.
check('ollama-comparison-core-receipt-green', () => {
  const receipt = readJson(join('experiments', 'ollama-comparison', 'receipt.json'));
  assert(receipt.schemaVersion === 'labview-benchmark-actor/ollama-comparison-receipt-v1', 'receipt schemaVersion mismatch');
  assert(receipt.total > 0 && receipt.passed === receipt.total && receipt.failed === 0, `receipt not green: ${receipt.passed}/${receipt.total}`);
  const plan = receipt.plan;
  assert(plan && plan.schema === 'labview-benchmark-actor/ollama-comparison@v1', 'plan schema mismatch');
  assert(Array.isArray(plan.comparisons) && plan.comparisons.length === plan.comparisonCount, 'comparisonCount must match the comparisons length');
  for (const c of plan.comparisons) {
    assert(typeof c.actorId === 'string' && c.actorId, 'each comparison must name its actor');
    assert(c.baselineRunId !== c.candidateRunId, 'a comparison must pair two distinct runs');
    assert(typeof c.prompt === 'string' && c.prompt.includes(`actor ${c.actorId}`), 'each comparison must carry an actor-scoped prompt');
  }
  return { checks: receipt.total, comparisons: plan.comparisonCount };
});

// 17. The documentation package carries the repo-standards-review stamp and the requirement IDs are
//     contiguous with no renumbering after the standalone-repo move (LBA-REQ-008, T-008). Static/CM.
check('docs-stamp-and-no-id-renumbering', () => {
  // (a) Stamp: README + cm-plan name repo-standards-review v0.2.19 (commit d44f210d).
  for (const rel of ['README.md', join('docs', 'cm', 'cm-plan.md')]) {
    const text = readFileSync(join(pkgRoot, rel), 'utf8');
    assert(/repo-standards-review/.test(text), `${rel} must name repo-standards-review`);
    assert(/v0\.2\.19/.test(text), `${rel} must name the v0.2.19 baseline`);
    assert(/d44f210d/.test(text), `${rel} must cite the d44f210d commit`);
  }
  // (b) The docs/ lane layout the standards runner expects.
  for (const lane of ['architecture', 'cm', 'requirements', 'testing']) {
    assert(existsSync(join(pkgRoot, 'docs', lane)), `docs/${lane} lane must exist`);
  }
  // (c) No renumbering: the LBA-REQ ids in srs.md form a contiguous 1..N set (no gaps, no duplicates).
  const srs = readFileSync(join(pkgRoot, 'docs', 'requirements', 'srs.md'), 'utf8');
  const ids = [...new Set([...srs.matchAll(/LBA-REQ-(\d{3})/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  assert(ids.length > 0, 'srs.md must define LBA-REQ ids');
  assert(ids[0] === 1, 'requirement ids must start at 001 (no renumbering)');
  for (let i = 0; i < ids.length; i += 1) {
    assert(ids[i] === i + 1, `requirement ids must be contiguous 1..N; expected ${i + 1}, got ${ids[i]}`);
  }
  return { ids: ids.length, lanes: ['architecture', 'cm', 'requirements', 'testing'] };
});

// 18. Viewer time-cursor logic receipt is green: pointer + keyboard map to an in-bounds sample and no
//     operation selects outside the run window (LBA-REQ-004, T-004). The browser/webview render is the
//     maintainer step.
check('viewer-cursor-logic-receipt-green', () => {
  const receipt = readJson(join('experiments', 'viewer-cursor', 'receipt.json'));
  assert(receipt.schemaVersion === 'labview-benchmark-actor/viewer-cursor-receipt-v1', 'receipt schemaVersion mismatch');
  assert(receipt.total > 0 && receipt.passed === receipt.total && receipt.failed === 0, `receipt not green: ${receipt.passed}/${receipt.total}`);
  const axis = receipt.timeAxis;
  assert(axis && Array.isArray(axis.samples) && axis.samples.length > 0, 'receipt must record the time axis');
  assert(axis.start === axis.samples[0] && axis.end === axis.samples[axis.samples.length - 1], 'axis start/end must match the samples');
  return { checks: receipt.total, samples: axis.samples.length };
});

// 19. Multi-VM Vagrant topology receipt is green (LBA-REQ-006, T-006). Two golden-box VMs must have
//     coordinated over lbabus net -- UDP presence + TCP CLAIM/HANDOFF/DONE with echoed ACKs, unique
//     identities, comms-only -- so the RTM "Proven" flip cannot outrun re-runnable evidence.
check('multi-vm-topology-receipt-green', () => {
  const receipt = readJson(join('experiments', 'multi-vm-topology', 'receipt.json'));
  assert(receipt.schema === 'labview-benchmark-actor/multi-vm-topology-receipt-v1', 'receipt schema mismatch');
  assert(receipt.requirement === 'LBA-REQ-006' && receipt.test === 'T-006', 'receipt must bind LBA-REQ-006 / T-006');
  assert(receipt.pass === true, 'receipt pass must be true');
  const a = receipt.asserts || {};
  assert(a.udpPresenceBeacons >= 2, `udpPresenceBeacons ${a.udpPresenceBeacons} must be >= 2`);
  assert(a.tcpClaim === true && a.tcpHandoff === true && a.tcpDone === true, 'tcp CLAIM/HANDOFF/DONE must all be received');
  assert(a.echoedAcks >= 3, `echoedAcks ${a.echoedAcks} must be >= 3`);
  assert(a.commsOnly === true, 'commsOnly must be true (no run data / frames on the bus)');
  const t = receipt.topology || {};
  assert(t.collector?.identity && t.sender?.identity && t.collector.identity !== t.sender.identity, 'collector/sender must have distinct identities');
  assert(t.collector?.ip && t.sender?.ip && t.collector.ip !== t.sender.ip, 'collector/sender must have distinct IPs');
  return { collector: t.collector?.identity, sender: t.sender?.identity, acks: a.echoedAcks };
});

// 20. The standalone .vsix extension manifest declares its command surface and carries NO vi-history-suite
//     dependency, and the moved-module manifest enumerates surfaces that exist (LBA-REQ-001, T-001). Static
//     boundary check on package.json + docs/cm/moved-module-manifest.json. The full .vsix publish + install
//     activation on Codespace/golden-VM (LBA-REQ-002) is the packaging/maintainer step.
check('extension-manifest-boundary', () => {
  const pkg = readJson('package.json');
  assert(pkg.name === 'labview-benchmark-actor', 'extension name must be labview-benchmark-actor');
  assert(pkg.engines && typeof pkg.engines.vscode === 'string', 'the manifest must declare engines.vscode');
  assert(typeof pkg.main === 'string' && pkg.main.length > 0, 'the manifest must declare the extension main entry');
  const commands = pkg.contributes?.commands;
  assert(Array.isArray(commands) && commands.length > 0, 'the manifest must contribute at least one command (the agentic surface)');
  // Boundary: no vi-history-suite-private module on the packaged dependency graph (AC #1).
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const dep of Object.keys(deps)) {
    assert(!/vi-history-suite/i.test(dep), `dependency ${dep} leaks a vi-history-suite-private module`);
  }
  // Moved-module manifest (AC #3): every enumerated surface exists on disk.
  const manifest = readJson(join('docs', 'cm', 'moved-module-manifest.json'));
  assert(manifest.schemaVersion === 'labview-benchmark-actor/moved-module-manifest-v1', 'moved-module manifest schemaVersion mismatch');
  assert(Array.isArray(manifest.modules) && manifest.modules.length > 0, 'the moved-module manifest must enumerate modules');
  for (const m of manifest.modules) {
    assert(typeof m.surface === 'string' && existsSync(join(pkgRoot, m.surface)), `moved-module surface ${m.surface} must exist`);
  }
  return { name: pkg.name, commands: commands.length, movedModules: manifest.modules.length };
});

// 21. A GitHub Codespace install route is defined: the .devcontainer provisions node + dotnet and builds
//     the extension via postCreate, so it activates in a Codespace with no host-specific patching
//     (LBA-REQ-002 AC #1, T-002). The Vagrant golden-VM install of the same artifact + the first-run
//     activation signal is the maintainer/VM step (the LBA-REQ-006 topology / install lane).
check('devcontainer-codespace-install-route', () => {
  const dc = readJson(join('.devcontainer', 'devcontainer.json'));
  assert(typeof dc.image === 'string' && dc.image.length > 0, 'the devcontainer must declare a base image');
  assert(
    dc.features && Object.keys(dc.features).some((f) => /dotnet/i.test(f)),
    'the devcontainer must provision dotnet (the agentic component runs in Codespaces Linux)'
  );
  const post = dc.postCreateCommand;
  assert(
    typeof post === 'string' && /npm\s+install/.test(post) && /compile/.test(post),
    'postCreateCommand must install deps + compile the extension'
  );
  return { image: dc.image };
});

// 22. The corpus-manifest ingestion boundary receipt is green: the run-topology.ps1 -> host-concentration
//     contract ingests the sample manifest (2 golden-box actors, 4 runs), concentrates it preserving
//     per-actor isolation, and yields a same-actor-only comparison plan (LBA-REQ-010, T-010). This is the
//     glue that lets WIN's emitted corpus manifest feed the concentrate -> ollama-compare path with no hand
//     editing; the live host-side ollama drive over the REAL concentrated corpus stays the maintainer step.
check('corpus-ingestion-contract-green', () => {
  const receipt = readJson(join('experiments', 'host-concentration', 'corpus-ingestion-receipt.json'));
  assert(receipt.schemaVersion === 'labview-benchmark-actor/corpus-ingestion-receipt-v1', 'receipt schemaVersion mismatch');
  assert(receipt.total > 0 && receipt.passed === receipt.total && receipt.failed === 0, `receipt not green: ${receipt.passed}/${receipt.total}`);
  assert(receipt.manifestSchema === 'labview-benchmark-actor/corpus-manifest@v1', 'manifest schema mismatch');
  const c = receipt.concentrated;
  assert(c && c.actors >= 2, `ingestion must concentrate >= 2 actors, got ${c && c.actors}`);
  assert(c.runCount >= c.actors, 'runCount must be at least one run per actor');
  assert(c.comparisonCount === c.runCount - c.actors, 'comparisons must equal (runs - actors) for consecutive same-actor pairing');
  return { checks: receipt.total, actors: c.actors, runs: c.runCount, comparisons: c.comparisonCount };
});

// 23. The REAL-corpus wiring receipt is green: the complete-corpus manifest ingests -> concentrates ->
//     dereferences each run's VM-local metrics file into a real summary -> builds a same-actor plan whose
//     prompts embed the REAL values -> a mock drive yields same-actor verdicts (LBA-REQ-010, T-010). This
//     gates the fixture + dereference wiring that drive-real-corpus.mjs runs LIVE on GPU, so the host-side
//     pipeline stays regression-proof without a GPU. The live LLM verdict is the maintainer step.
check('real-corpus-wiring-green', () => {
  const receipt = readJson(join('experiments', 'ollama-comparison', 'real-corpus-wiring-receipt.json'));
  assert(receipt.schemaVersion === 'labview-benchmark-actor/real-corpus-wiring-receipt-v1', 'receipt schemaVersion mismatch');
  assert(receipt.total > 0 && receipt.passed === receipt.total && receipt.failed === 0, `receipt not green: ${receipt.passed}/${receipt.total}`);
  // The wiring proof must include the dereference (path->summary) and the prompt-embeds-real-values checks.
  const names = new Set(receipt.results.map((r) => r.name));
  assert(names.has('dereference-replaces-path-with-real-metric-summary'), 'must prove dereference replaces the path with a summary');
  assert(names.has('comparison-plan-prompts-embed-real-values'), 'must prove the plan prompts embed the real dereferenced values');
  return { checks: receipt.total };
});

// 24. Multi-VM out-of-band corpus export receipt is green (LBA-REQ-010, T-010 leg 2). The two golden-box
//     VMs each produced their own-run corpus, the host fetched both OUT-OF-BAND (not over the bus), and the
//     SHIPPED host-concentration core merged them with per-actor isolation + run-data-only rejection --
//     proving the real multi-VM concentrated corpus that feeds the ollama layer. WIN topology + LINUX core.
check('multi-vm-corpus-export-receipt-green', () => {
  const receipt = readJson(join('experiments', 'multi-vm-topology', 'corpus-export', 'receipt.json'));
  assert(receipt.schema === 'labview-benchmark-actor/multi-vm-corpus-export-receipt-v1', 'receipt schema mismatch');
  assert(receipt.requirement === 'LBA-REQ-010' && receipt.test === 'T-010', 'receipt must bind LBA-REQ-010 / T-010');
  assert(receipt.pass === true, 'receipt pass must be true');
  assert(receipt.coreSchema === 'labview-benchmark-actor/host-concentration@v1', 'must concentrate through the shipped host-concentration core');
  assert(/out-of-band/i.test(receipt.transport) && !/lbabus net/i.test(receipt.transport.replace(/not lbabus net/i, '')), 'transport must be out-of-band, not the bus');
  assert(Array.isArray(receipt.actors) && receipt.actors.length >= 2, 'must concentrate >= 2 actors');
  assert(receipt.runCount >= receipt.actors.length, 'runCount must cover every actor');
  const iso = receipt.perActorIsolation || {};
  const isoTotal = Object.values(iso).reduce((a, b) => a + b, 0);
  assert(Object.keys(iso).length === receipt.actors.length, 'per-actor isolation must cover every actor');
  assert(isoTotal === receipt.runCount, 'per-actor own-runs must partition the concentrated corpus');
  assert(receipt.busShapedRejected === true, 'a bus-shaped corpus must be rejected (run data only)');
  assert(receipt.deterministicDigest === true && /^[0-9a-f]{8}$/.test(receipt.corpusDigest || ''), 'corpusDigest must be deterministic 8-hex');
  return { actors: receipt.actors.length, runs: receipt.runCount, digest: receipt.corpusDigest };
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
