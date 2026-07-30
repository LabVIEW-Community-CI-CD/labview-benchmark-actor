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
import { ingestShortPackets, MPRR_RING_SCHEMA, TICKS_PER_MS, DEFAULT_BLOCK_DURATION_MS, DEFAULT_BLOCK_DURATION_TICKS, ADMISSION_CAPACITY_HEADROOM, AUTHORITATIVE_BOUNDARY_VARIATION_PCT, NORMAL_LOAD_BOUNDARY_VARIATION_PCT, createShortRing, CLI_DEFAULT_CAPACITY_BYTES } from './mprr-ring/mprrRing.mjs';
import { projectViewerSeries, seriesHash } from './mprr-ring/mprrViewerSeries.mjs';
import { correlateDualStream } from './mprr-ring/mprrDualPacket.mjs';
import { summarizeViAnalyzerReport } from './vi-analyzer/viAnalyzerResult.mjs';
import { validateViAnalyzerReport } from './vi-analyzer/validate-vi-analyzer-report.mjs';
import { parseAsciiReport, parseSummary } from './vi-analyzer/parse-vi-analyzer-ascii.mjs';
import { verifyManifest as verifyExtensionAgentsManifest, agentsSha256, readManifest as readExtensionAgentsManifest, AGENTS_MD as EXTENSION_AGENTS_MD } from '../scripts/agentsManifest.mjs';
import { RATE_PROFILES, runProfile } from './mprr-ring/mprrPacketHarness.mjs';
import { sealBootBenchmark } from './mprr-boot-benchmark/seal-boot-benchmark.mjs';
import { parseSerialLog, parseSerialMarkerLine } from './mprr-boot-benchmark/serial-marker.mjs';
import { parseJournalMonotonic } from './mprr-boot-benchmark/journal-monotonic.mjs';
import { createVmwareBackend, vmwareSerialConfigVmx, vmwareVncConfigVmx, upsertVmxConfig } from './mprr-boot-benchmark/capture-backend-vmware.mjs';
import { bootBenchmarkDiff } from './mprr-boot-benchmark/boot-benchmark-diff.mjs';
import { bootbenchDiff } from './mesh-runs/bootbench-diff.mjs';
import { PACKET_BYTES, PACKET_VERSION, OFFSETS, MILESTONE_IDS, encodeCaptureFrame, decodeCaptureFrame, writeCaptureFrame, readCaptureFrames } from './mprr-capture-ring/capture-ring.mjs';
import { ringFrameFromDescriptor, makeRingSink } from './mprr-capture-ring/vmware-ring-capture.mjs';
import { createVboxVncSource, VBOX_DEFAULT_VNC_PORT, sampleDescriptor } from './mprr-capture-ring/vbox-vnc-source.mjs';
import { execFileSync } from 'node:child_process';

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

// 21. A GitHub Codespace install route is defined via a PREBUILT dev container image: the recipe
//     (.devcontainer/build/devcontainer.json) provisions node + dotnet and is built + published to GHCR
//     by CI (.github/workflows/devcontainer-prebuild.yml); the runtime .devcontainer/devcontainer.json
//     references that published image and builds the extension via postCreate, so it activates in a
//     Codespace with no host-specific patching (LBA-REQ-002 AC #1, T-002). The Vagrant golden-VM install
//     of the same artifact + the first-run activation signal is the maintainer/VM step (the LBA-REQ-006
//     topology / install lane).
check('devcontainer-codespace-install-route', () => {
  // Runtime config: references the prebuilt image and builds the extension via postCreate.
  const dc = readJson(join('.devcontainer', 'devcontainer.json'));
  assert(typeof dc.image === 'string' && dc.image.length > 0, 'the runtime devcontainer must declare an image');
  const post = dc.postCreateCommand;
  assert(
    typeof post === 'string' && /npm\s+install/.test(post) && /compile/.test(post),
    'postCreateCommand must install deps + compile the extension'
  );
  // dotnet is provisioned by the RECIPE that CI bakes into the prebuilt image the runtime references.
  const recipe = readJson(join('.devcontainer', 'build', 'devcontainer.json'));
  assert(typeof recipe.image === 'string' && recipe.image.length > 0, 'the recipe must declare a base image');
  assert(
    recipe.features && Object.keys(recipe.features).some((f) => /dotnet/i.test(f)),
    'the recipe must provision dotnet (baked into the prebuilt image the agentic component runs in)'
  );
  // The prebuild route must be wired: CI builds FROM the recipe and publishes the image the runtime pulls.
  const wf = readFileSync(join('.github', 'workflows', 'devcontainer-prebuild.yml'), 'utf8');
  assert(/\.devcontainer\/build\/devcontainer\.json/.test(wf), 'the prebuild workflow must build from the recipe');
  assert(wf.includes(dc.image.replace(/:[^:/]*$/, '')), 'the prebuild workflow must publish the image the runtime references');
  return { runtimeImage: dc.image, recipeImage: recipe.image };
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

// 24. Multi-VM out-of-band corpus export receipt is green (LBA-REQ-010, T-010 leg 2). The two golden-box VMs
//     each produced their own-run corpus, the host fetched both OUT-OF-BAND (WinRM, not the bus) and emitted
//     the corpus-manifest@v1 that flows through the SHIPPED ingestCorpusManifest boundary (concentrateManifest
//     + dereferenceMetrics), yielding per-actor isolation, real dereferenced metrics, and a same-actor plan.
//     This is the REAL multi-VM concentrated corpus LINUX's fixtures stand in for -- drive-ready for the live
//     ollama drive (drive-real-corpus.mjs --manifest), which is the remaining maintainer/GPU step.
check('multi-vm-corpus-export-receipt-green', () => {
  const receipt = readJson(join('experiments', 'multi-vm-topology', 'corpus-export', 'receipt.json'));
  assert(receipt.schema === 'labview-benchmark-actor/multi-vm-corpus-export-receipt-v1', 'receipt schema mismatch');
  assert(receipt.requirement === 'LBA-REQ-010' && receipt.test === 'T-010', 'receipt must bind LBA-REQ-010 / T-010');
  assert(receipt.pass === true, 'receipt pass must be true');
  assert(receipt.manifestSchema === 'labview-benchmark-actor/corpus-manifest@v1', 'must emit the corpus-manifest@v1 shape');
  assert(receipt.coreSchema === 'labview-benchmark-actor/host-concentration@v1', 'must concentrate through the shipped host-concentration core');
  assert(/ingestCorpusManifest/.test(receipt.boundary || ''), 'must flow through the shipped ingestCorpusManifest boundary');
  assert(/out-of-band/i.test(receipt.transport) && !/lbabus net/i.test(receipt.transport.replace(/not lbabus net/i, '')), 'transport must be out-of-band, not the bus');
  assert(Array.isArray(receipt.actors) && receipt.actors.length >= 2, 'must concentrate >= 2 actors');
  assert(receipt.runCount >= 2 * receipt.actors.length, 'each actor needs >= 2 runs (a baseline + a candidate to compare)');
  const iso = receipt.perActorIsolation || {};
  const isoTotal = Object.values(iso).reduce((a, b) => a + b, 0);
  assert(Object.keys(iso).length === receipt.actors.length, 'per-actor isolation must cover every actor');
  assert(isoTotal === receipt.runCount, 'per-actor own-runs must partition the concentrated corpus');
  assert(receipt.busShapedRejected === true, 'a bus-shaped corpus must be rejected (run data only)');
  assert(receipt.deterministicDigest === true && /^[0-9a-f]{8}$/.test(receipt.corpusDigest || ''), 'corpusDigest must be deterministic 8-hex');
  assert(receipt.dereferencedMetrics === true, 'the host must dereference each run VM-local metrics file (the out-of-band read)');
  assert(receipt.comparisonPlan?.sameActorOnly === true && receipt.comparisonPlan.comparisonCount >= receipt.actors.length, 'must build a same-actor comparison plan over the real corpus');
  assert(receipt.driveReady === true && /drive-real-corpus\.mjs/.test(receipt.driveCommand || ''), 'the manifest must be drive-ready for the live ollama drive');
  // Leg 3 needs the drive-ready corpus itself COMMITTED (manifest + metrics), so the maintainer runs the live
  // GPU drive on a host WITHOUT these Windows VMs -- assert it is present and every metricsRef resolves + is real.
  const exportRootRel = join('experiments', 'multi-vm-topology', 'corpus-export', 'exported-corpus');
  const exportedManifestRel = join(exportRootRel, 'manifest.json');
  assert(existsSync(join(pkgRoot, exportedManifestRel)), 'the drive-ready exported corpus manifest must be committed for the maintainer GPU drive');
  const exported = readJson(exportedManifestRel);
  assert(exported.schema === 'labview-benchmark-actor/corpus-manifest@v1', 'exported manifest must be corpus-manifest@v1');
  assert(Array.isArray(exported.corpora) && exported.corpora.length >= 2, 'exported corpus must carry >= 2 per-actor corpora');
  let committedMetricFiles = 0;
  for (const corpusEntry of exported.corpora) {
    for (const run of corpusEntry.runs) {
      const metricRel = join(exportRootRel, run.metricsRef);
      assert(existsSync(join(pkgRoot, metricRel)), `exported metricsRef must resolve to a committed file: ${run.metricsRef}`);
      const m = readJson(metricRel);
      assert(
        typeof m.cpuMeanPct === 'number' && typeof m.ramMeanMiB === 'number' && typeof m.durationMs === 'number',
        `committed metrics incomplete for the drive: ${run.metricsRef}`
      );
      committedMetricFiles += 1;
    }
  }
  assert(committedMetricFiles === receipt.runCount, 'every concentrated run must have a committed metrics file for the live drive');
  return { actors: receipt.actors.length, runs: receipt.runCount, digest: receipt.corpusDigest, comparisons: receipt.comparisonPlan.comparisonCount, committedMetrics: committedMetricFiles };
});

// 25. The LBA-REQ-004 benchmark-viewer webview surface is wired and CSP-safe (T-004): the extension
//     contributes the openViewer command, the extension source builds a strict-CSP nonce-scoped webview that
//     loads media/viewer.js, and media/viewer.js delegates ALL cursor math to the shipped viewerCursor core
//     (imported verbatim -- no duplicated snap logic). The interactive browser render/drag is the maintainer step.
check('viewer-webview-surface-wired', () => {
  const pkg = readJson('package.json');
  const commands = (pkg.contributes && Array.isArray(pkg.contributes.commands) ? pkg.contributes.commands : []).map((c) => c.command);
  assert(commands.includes('labviewBenchmarkActor.openViewer'), 'the manifest must contribute the openViewer command');
  const ext = readFileSync(join(pkgRoot, 'src', 'extension.ts'), 'utf8');
  assert(/default-src 'none'/.test(ext) && /script-src 'nonce-/.test(ext), 'the viewer webview must set a strict nonce CSP');
  assert(/viewer\.js/.test(ext), 'the viewer webview must load media/viewer.js');
  const viewer = readFileSync(join(pkgRoot, 'media', 'viewer.js'), 'utf8');
  assert(/from '\.\/viewerCursor\.mjs'/.test(viewer), 'media/viewer.js must import the shipped viewerCursor core (no duplicated snap math)');
  for (const fn of ['createCursor', 'setPointer', 'step', 'jump']) {
    assert(new RegExp(`\\b${fn}\\b`).test(viewer), `media/viewer.js must use the proven ${fn}`);
  }
  return { command: 'openViewer', reusesCursorCore: true };
});

// 27. The benchmark ring-buffer store receipt is green (operator big-drive / cross-plane direction): the store
//     registers LINUX + WIN runs of a shared benchmarkId, reads them back with the ring-buffer REFERENCED (not
//     copied), cross-plane-compares metric deltas, and REJECTS drift (bad plane, missing benchmarkId, a
//     single-plane compare). Deterministic (temp root); the live large captures land on the big drive.
check('benchmark-store-receipt-green', () => {
  const receipt = readJson(join('experiments', 'benchmark-store', 'receipt.json'));
  assert(receipt.schemaVersion === 'labview-benchmark-actor/benchmark-store-receipt-v1', 'receipt schemaVersion mismatch');
  assert(receipt.total > 0 && receipt.passed === receipt.total && receipt.failed === 0, `receipt not green: ${receipt.passed}/${receipt.total}`);
  assert(receipt.storeSchema === 'labview-benchmark-actor/benchmark-store@v1', 'store schema mismatch');
  const c = receipt.sampleCompare;
  assert(c && c.schema === 'labview-benchmark-actor/cross-plane-compare@v1', 'sample cross-plane-compare schema mismatch');
  assert(c.deltas && typeof (c.deltas.cpuMeanPct && c.deltas.cpuMeanPct.delta) === 'number', 'compare must report a LINUX-vs-WIN cpu delta');
  assert(c.digests && c.digests.seriesHash && c.digests.seriesHash.match === true,
    'compare must confirm the deterministic seriesHash matches cross-plane');
  return { checks: receipt.total, benchmark: c.benchmarkId };
});
check('mprr-short-ring-model-green', () => {
  // Re-validate the absorbed mprr zero-copy short-ring model directly (import + ingest the fixture) so every
  // CI run on BOTH planes exercises the ring/block/boundary/admission authority, not a static receipt.
  const fixture = readJson(join('experiments', 'mprr-ring', 'fixtures', 'short-packet-run.json'));
  const opts = { blockDurationTicks: fixture.blockDurationTicks, capacityBytes: fixture.capacityBytes };
  const a = ingestShortPackets(fixture.packets, opts);
  const b = ingestShortPackets(fixture.packets, opts);
  assert(JSON.stringify(a) === JSON.stringify(b), 'mprr ingest is not deterministic');
  assert(a.schema === MPRR_RING_SCHEMA, 'mprr ring schema mismatch');
  assert(a.authoritative === true, 'block-aligned fixture must be authoritative');
  assert(a.worstBoundaryVariationPct === 0, 'aligned fixture boundary variation must be 0');
  assert(a.admission.admitted === true, 'fixture must pass admission control');
  assert(a.series.length === fixture.packets.length, 'series must cover every packet');
  // The viewer-series projection (what the shipped viewer renders) is deterministic + hashes stably -- the
  // cross-plane visual anchor (identical packets => identical series => identical hash on both planes).
  const s1 = projectViewerSeries(a);
  const s2 = projectViewerSeries(b);
  assert(JSON.stringify(s1) === JSON.stringify(s2), 'viewer-series projection not deterministic');
  assert(seriesHash(s1) === seriesHash(s2) && /^[0-9a-f]{64}$/.test(seriesHash(s1)), 'seriesHash unstable');
  return { blocks: a.blockCount, packets: a.packetCount };
});
check('mprr-dual-packet-degradation-green', () => {
  // SHORT-packet continuity is protected BEFORE long completeness (MPRR-REQ-094/110/111): with no pressure
  // every long is admitted (authoritative); under pressure longs are DEFERRED (missing-long-payload) but every
  // short is still counted; shorts over capacity FAIL CLOSED (never overwrite a pinned short).
  const frames = Array.from({ length: 8 }, (_, i) => ({ frameIndex: i, shortBytes: 100, longBytes: 400 }));
  const ok = correlateDualStream(frames, { capacityBytes: 100000 });
  assert(ok.authoritative === true && ok.frames.every((f) => f.driftClass === 'none'), 'no-pressure authoritative');
  const degraded = correlateDualStream(frames, { capacityBytes: 2000 });
  assert(degraded.shortTotal === 800, 'shorts stay protected under pressure');
  assert(degraded.authoritative === false && degraded.admittedLong === 1200, 'longs deferred under pressure');
  const blocked = correlateDualStream(frames.map((f) => ({ ...f, shortBytes: 600 })), { capacityBytes: 4096 });
  assert(blocked.outcome === 'short-protection-blocked', 'shorts over capacity fail closed');
  return { frames: degraded.frameCount, authoritativeFrames: degraded.authoritativeFrames };
});
check('vi-analyzer-result-model-green', () => {
  // The VI Analyzer result model (operator VI-Analyzer directive) is deterministic + order-independent, so a
  // VI Analyzer run is cross-plane comparable: both planes summarizing the same report => same resultHash.
  const report = readJson(join('experiments', 'vi-analyzer', 'fixtures', 'sample-report.json'));
  const a = summarizeViAnalyzerReport(report);
  const b = summarizeViAnalyzerReport(report);
  assert(a.schema === 'labview-benchmark-actor/vi-analyzer-result@v2', 'vi-analyzer schema');
  assert(a.resultHash === b.resultHash && /^[0-9a-f]{64}$/.test(a.resultHash), 'resultHash deterministic 64-hex');
  assert(a.totalTests === 8 && a.failedTests === 2 && a.errorTests === 1 && a.pass === false, 'counts + verdict');
  assert(a.totalFindings === 3, 'findings enumerated');
  return { findings: a.totalFindings, tests: a.totalTests };
});
check('vi-analyzer-report-schema-green', () => {
  // The normalized VI Analyzer report is the LBA-REQ-015 cross-plane INPUT contract: WIN's parser must emit this
  // exact shape so the resultHash matches LINUX on the first compare. The committed JSON Schema documents it and
  // the dep-free validator (WIN's pre-send self-check) enforces it with path-annotated errors.
  const schema = readJson(join('experiments', 'vi-analyzer', 'vi-analyzer-report.schema.json'));
  assert(schema.$id === 'labview-benchmark-actor/vi-analyzer-report@v2', 'schema $id');
  assert(Array.isArray(schema.required) && schema.required.includes('summary') && schema.required.includes('findings'), 'schema requires summary + findings');
  const resultEnum = schema.properties.findings.items.properties.result.enum;
  assert(JSON.stringify(resultEnum) === JSON.stringify(['fail', 'error']), 'finding result enum fail|error');
  // Both the with-findings fixture and the all-pass fixture validate OK.
  const fixture = readJson(join('experiments', 'vi-analyzer', 'fixtures', 'sample-report.json'));
  const good = validateViAnalyzerReport(fixture);
  assert(good.ok === true && good.errors.length === 0, `fixture must validate: ${good.errors.join('; ')}`);
  const allpass = readJson(join('experiments', 'vi-analyzer', 'fixtures', 'sample-report-allpass.json'));
  assert(validateViAnalyzerReport(allpass).ok === true, 'all-pass fixture must validate');
  // Teeth: a malformed report (unknown key, bad result enum, empty test, summary/findings inconsistency) is rejected.
  const bad = validateViAnalyzerReport({
    summary: { passed: 5, failed: 2, error: 0 },
    findings: [
      { viPath: 'A.vi', test: 'T', result: 'skipped', extra: 1 },
      { viPath: 'A.vi', test: '', result: 'fail' },
    ],
  });
  assert(bad.ok === false && bad.errors.length === 4, `malformed report rejected with 4 errors, got ${bad.errors.length}`);
  return { schemaId: schema.$id, fixtureValid: good.ok };
});
check('vi-analyzer-ascii-parser-green', () => {
  // The reference ASCII parser (WIN's convenience) turns a REAL LabVIEWCLI RunVIAnalyzer ASCII report into the
  // v2 shape. Proven: an all-pass completion line -> summary + empty findings; a with-findings report ->
  // consistent findings. Both validate and summarize to a resultHash.
  const allpass = parseAsciiReport('VI Analyzer completed. 452 tests passed, 0 failed, 0 skipped, 0 unloadable, 0 error\n', 'lv_icon_editor.viancfg');
  assert(allpass.summary.passed === 452 && allpass.summary.failed === 0 && allpass.findings.length === 0, 'all-pass completion line parsed');
  assert(validateViAnalyzerReport(allpass).ok === true, 'parsed all-pass report validates');
  const withF = parseAsciiReport(
    'VI Analyzer completed. 5 tests passed, 2 failed, 0 skipped, 0 unloadable, 1 error\n\nFailed Tests (sorted by VI)\nMain.vi\n  Spelling\nresource/plugins/lv_icon.vi\n  Spelling\n\nTesting Errors\nMain.vi\n  VI Documentation\n',
    'icon.viancfg',
  );
  assert(withF.summary.failed === 2 && withF.summary.error === 1, 'with-findings counts parsed');
  assert(withF.findings.length === 3, `3 findings extracted, got ${withF.findings.length}`);
  const v = validateViAnalyzerReport(withF);
  assert(v.ok === true, `parsed with-findings report validates (consistency): ${v.errors.join('; ')}`);
  const s = summarizeViAnalyzerReport(withF);
  assert(/^[0-9a-f]{64}$/.test(s.resultHash), 'parsed report yields a resultHash');
  // The REAL LabVIEWCLI ASCII format is line-per-count ("452 tests passed." / "0 tests produced error." /
  // "0 tests were unloadable." distinct from "0 VIs were unloadable"). Prove the parser handles it: WIN's
  // real all-pass output -> the pinned df9c8d1e; and a non-zero sample disambiguates the phrasings.
  const winReal = parseAsciiReport('VI Analyzer completed.\n452 tests passed.\n0 tests failed.\n0 tests skipped.\n0 VIs were unloadable.\n0 tests were unloadable.\n0 tests were unrunable.\n0 tests produced error.\n', 'lv_icon_editor.viancfg');
  assert(winReal.summary.passed === 452 && winReal.findings.length === 0, 'WIN real all-pass format parses');
  assert(summarizeViAnalyzerReport(winReal).resultHash === 'df9c8d1ef67461637ee2b841a980da4a59164caff2d6df07eb916ac99453d75d', 'WIN real format -> pinned cross-plane resultHash');
  const nz = parseSummary('448 tests passed.\n3 tests failed.\n1 tests skipped.\n0 VIs were unloadable.\n2 tests were unloadable.\n0 tests were unrunable.\n1 tests produced error.\n');
  assert(nz.passed === 448 && nz.failed === 3 && nz.error === 1 && nz.skipped === 1 && nz.unloadable === 2, `real line-per-count non-zero parse: ${JSON.stringify(nz)}`);
  return { allPassTests: allpass.summary.passed, findings: withF.findings.length };
});
check('vi-analyzer-real-report-cross-plane-green', () => {
  // LBA-REQ-015 Proven evidence. The committed REAL VI Analyzer report (WIN's attested all-pass icon-editor run
  // via LabVIEWCLI RunVIAnalyzer: 452 passed / 0 failed, bus discussion #1 @ 2026-07-28T20:47:35Z) validates and
  // summarizes to a PINNED resultHash. This gate runs on BOTH ubuntu-latest and windows-latest in CI, so both
  // operating systems asserting the SAME resultHash IS the cross-plane (cross-OS) parity proof: two planes
  // summarizing the same real report produce the same resultHash (the LBA-REQ-015 acceptance).
  const report = readJson(join('experiments', 'vi-analyzer', 'icon-editor-report.json'));
  const v = validateViAnalyzerReport(report);
  assert(v.ok === true, `real report must validate: ${v.errors.join('; ')}`);
  const s = summarizeViAnalyzerReport(report);
  assert(s.pass === true && s.passedTests === 452 && s.failedTests === 0 && s.errorTests === 0, 'real all-pass counts (452 passed / 0 failed / 0 error)');
  const EXPECTED = 'df9c8d1ef67461637ee2b841a980da4a59164caff2d6df07eb916ac99453d75d';
  assert(s.resultHash === EXPECTED, `real report resultHash ${s.resultHash} MUST equal the cross-plane anchor ${EXPECTED} on every plane/OS`);
  // Primary source: WIN's raw LabVIEWCLI completion output, parsed, reproduces the SAME pinned resultHash --
  // tying the real tool output end-to-end to the committed report on every OS.
  const rawWin = readFileSync(join(pkgRoot, 'experiments', 'vi-analyzer', 'icon-editor-vi-analyzer-completion-WIN.txt'), 'utf8');
  const parsedWin = parseAsciiReport(rawWin, report.config);
  assert(summarizeViAnalyzerReport(parsedWin).resultHash === EXPECTED, 'WIN raw completion output parses to the pinned cross-plane resultHash');
  return { resultHash: s.resultHash, tests: s.totalTests };
});
check('extension-agents-manifest-green', () => {
  // The extension-embedded AGENTS.md (issue #98) is pinned by extension-agents/agents.manifest.json
  // { schema, version, sha256 } over the canonical body -- a user-facing agent-instructions surface versioned
  // on its OWN semver (separate from collab-cli + the extension code). The drift gate is a pure
  // manifest.sha256 == sha256(AGENTS.md) + valid-semver check (WIN's #98 enhancement -- no header parsing).
  const v = verifyExtensionAgentsManifest();
  assert(v.ok === true, `extension AGENTS.md manifest invalid: ${v.errors.join('; ')}`);
  const manifest = readExtensionAgentsManifest();
  assert(manifest.schema === 'labview-benchmark-actor/extension-agents@v1', 'manifest schema');
  assert(/^\d+\.\d+\.\d+$/.test(manifest.version), `manifest version must be x.y.z semver (got ${manifest.version})`);
  const body = readFileSync(EXTENSION_AGENTS_MD, 'utf8');
  assert(agentsSha256(body) === manifest.sha256, 'manifest sha256 matches the AGENTS.md canonical body');
  // Teeth: any content edit changes the canonical sha256, so a stale manifest fails the gate.
  assert(agentsSha256(`${body}\nDRIFT`) !== manifest.sha256, 'an AGENTS.md edit changes the sha256 (gate has teeth)');
  return { version: manifest.version, sha256: manifest.sha256.slice(0, 12) };
});
check('mprr-packet-harness-profiles-green', () => {
  // The mprr rate profiles (MPRR-REQ-115-119) drive the absorbed ring across load shapes: steady is
  // authoritative; reclaim-pressure trips admission control on a small ring.
  const P = { count: 24, frameIntervalTicks: 1_000_000, baseBytes: 120, blockDurationTicks: 3_000_000 };
  assert(RATE_PROFILES.length === 5, 'five rate profiles');
  const steady = runProfile('steady', P);
  assert(steady.authoritative === true && steady.worstBoundaryVariationPct === 0, 'steady authoritative');
  const pressure = runProfile('reclaim-pressure', { ...P, capacityBytes: 4096 });
  assert(pressure.admission.outcome === 'admission-control-blocked', 'reclaim-pressure trips admission');
  return { profiles: RATE_PROFILES.length };
});
check('cross-plane-comparison-proven-green', () => {
  // LBA-REQ-014 Proven evidence: the committed cross-plane comparison receipt pairs the real LINUX and WIN mprr
  // runs; the deterministic seriesHash MUST match (the acceptance) and every numeric metric delta is 0.
  const r = readJson(join('experiments', 'benchmark-store', 'cross-plane-comparison-receipt.json'));
  assert(r.schema === 'labview-benchmark-actor/cross-plane-comparison-receipt@v1', 'comparison receipt schema');
  assert(r.requirement === 'LBA-REQ-014' && r.benchmarkId === 'mprr-short-ring-fixture', 'targets LBA-REQ-014 mprr benchmark');
  assert(r.seriesHashMatch === true, 'the deterministic seriesHash must match cross-plane (LBA-REQ-014 acceptance)');
  assert(r.comparison && r.comparison.digests.seriesHash.match === true, 'digest seriesHash match');
  const deltas = r.comparison.deltas;
  for (const k of Object.keys(deltas)) {
    assert(deltas[k].delta === 0, `metric ${k} must be identical cross-plane (delta 0), got ${deltas[k].delta}`);
  }
  return { linux: r.linuxRunId, win: r.winRunId };
});
// The MCP server surface (VS Code 1.101 mcpServerDefinitionProviders) is a build-time TS -> out/mcp
// artifact; this gate asserts the STATIC contract (build-independent, matching the CI lane which does not
// compile). The DYNAMIC JSON-RPC round-trip is gated by `npm test` (test/mcp-server.mjs: pure-core dispatch
// + a real spawned stdio round-trip).
check('mcp-server-surface-contract', () => {
  const pkg = readJson('package.json');
  const providers = pkg.contributes?.mcpServerDefinitionProviders;
  assert(Array.isArray(providers) && providers.length === 1, 'manifest must contribute exactly one MCP server definition provider');
  const manifestId = providers[0].id;
  assert(typeof manifestId === 'string' && manifestId.length > 0, 'the MCP provider contribution needs an id');
  // manifest id <-> runtime provider id binding (VS Code requires them equal to bind the contribution).
  const providerSrc = readFileSync(join(pkgRoot, 'src', 'mcp', 'benchmarkActorMcpServerProvider.ts'), 'utf8');
  const idMatch = /BENCHMARK_ACTOR_MCP_PROVIDER_ID\s*=\s*'([^']+)'/.exec(providerSrc);
  assert(idMatch && idMatch[1] === manifestId, `provider id constant must equal the manifest id (${manifestId})`);
  assert(/runBenchmarkActorMcpServer\.js/.test(providerSrc) && /'out'/.test(providerSrc), 'provider must launch the bundled out/mcp entrypoint');
  // Tool registry: the 4 tools + the pinned MCP protocol version.
  const coreSrc = readFileSync(join(pkgRoot, 'src', 'mcp', 'benchmarkActorMcpServer.ts'), 'utf8');
  for (const t of ['get_host_capabilities', 'get_benchmark_series', 'poll_coordination_bus', 'post_coordination_note']) {
    assert(coreSrc.includes(`name: '${t}'`), `tool ${t} must be in the registry`);
  }
  assert(/BENCHMARK_ACTOR_MCP_PROTOCOL_VERSION\s*=\s*'2025-06-18'/.test(coreSrc), 'MCP protocol version must be pinned to 2025-06-18');
  // Packaging (issue #123): the entrypoint ships (out/ not ignored) and source stays out.
  const ignore = readFileSync(join(pkgRoot, '.vscodeignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
  assert(ignore.includes('src/**'), '.vscodeignore must exclude src/**');
  assert(!ignore.some((l) => l === 'out/**' || l === 'out/'), '.vscodeignore must NOT exclude out/ (the MCP entrypoint must ship)');
  // #123 packaging-leak guard (static, every-PR half; the empirical `vsce ls` allow-set is the agent-last-gate's
  // vsix-allow-set check at release/staging). The heavy non-runtime trees -- above all the reviewer VM disk
  // behind the 14 GB leak -- MUST stay excluded from the .vsix, and this runs on both OS runners.
  for (const deny of ['reviewer-workstation/**', '**/.vagrant/**', 'node_modules/**', 'experiments/**', 'tools/**', 'docs/**', 'cleanroom/**', 'scripts/**']) {
    assert(ignore.includes(deny), `.vscodeignore must exclude ${deny} (#123 packaging-leak guard)`);
  }
  // The dynamic protocol round-trip is wired into npm test.
  assert(/test\/mcp-server\.mjs/.test(pkg.scripts?.test ?? ''), 'npm test must run test/mcp-server.mjs');
  return { providerId: manifestId, tools: 4, protocol: '2025-06-18' };
});
// mprr is ABSORBED as a self-owned model (ADR-0009): the docs must not reintroduce the retired
// "external canonical dependency/reference" framing, and the de-branded experiments must read the
// LBA_* env var. Locks the absorption + de-brand so they cannot silently rot (mirrors docs-stamp).
check('mprr-absorbed-self-owned-not-external', () => {
  // (a) The absorption ADR exists with the right heading.
  const adr = join(pkgRoot, 'docs', 'architecture', 'adr', 'ADR-0009-absorb-mprr-model-self-owned.md');
  assert(existsSync(adr), 'ADR-0009 (mprr absorption) must exist');
  assert(readFileSync(adr, 'utf8').startsWith('# ADR-0009:'), 'ADR-0009 heading must start with "# ADR-0009:"');
  // (b) The retired framing labels must not reappear in the normative docs.
  const readme = readFileSync(join(pkgRoot, 'README.md'), 'utf8');
  const srs = readFileSync(join(pkgRoot, 'docs', 'requirements', 'srs.md'), 'utf8');
  const adr5 = readFileSync(join(pkgRoot, 'docs', 'architecture', 'adr', 'ADR-0005-image-storage-mprr-ringbuffer-cleanroom.md'), 'utf8');
  const adr7 = readFileSync(join(pkgRoot, 'docs', 'architecture', 'adr', 'ADR-0007-image-derived-timing-binary-strip.md'), 'utf8');
  assert(!/##\s*External dependency/.test(readme), 'README must not carry an "## External dependency" section (absorbed, ADR-0009)');
  assert(!/\*\*External canonical dependency:\*\*/.test(srs), 'srs.md must not carry the "External canonical dependency" label (absorbed, ADR-0009)');
  assert(!/External canonical reference:/.test(adr5 + adr7), 'ADR-0005/0007 must not carry the "External canonical reference" label (absorbed, ADR-0009)');
  // (c) The absorbed model is positively cited.
  assert(/Absorbed model/.test(readme) && /ADR-0009/.test(readme), 'README must cite the absorbed model + ADR-0009');
  assert(/ADR-0009/.test(srs), 'srs.md must cite ADR-0009');
  // (d) The de-branded experiments read the LBA_* env var (VIHS_* kept only as a back-compat fallback).
  const ocr = readFileSync(join(pkgRoot, 'experiments', 'ocr-primitive-proof', 'ocr-driver.js'), 'utf8');
  const conf = readFileSync(join(pkgRoot, 'experiments', 'self-test-conformance', 'produce-conformance.cjs'), 'utf8');
  assert(/LBA_MPRR_ROOT/.test(ocr) && /LBA_MPRR_ROOT/.test(conf), 'de-branded experiments must read LBA_MPRR_ROOT');
  assert(/LBA_CONFORMANCE_OUT/.test(conf), 'conformance generator must read LBA_CONFORMANCE_OUT');
  // (e) The back-compat fallback is retained so existing VIHS_MPRR_ROOT callers keep working.
  assert(/VIHS_MPRR_ROOT/.test(ocr) && /VIHS_MPRR_ROOT/.test(conf), 'legacy VIHS_MPRR_ROOT must remain as a back-compat fallback');
  // Teeth: the guard regexes actually catch the retired framing if it is reintroduced.
  assert(/##\s*External dependency/.test('## External dependency'), 'guard must catch a reintroduced "## External dependency" section');
  assert(/\*\*External canonical dependency:\*\*/.test('**External canonical dependency:** mprr'), 'guard must catch a reintroduced srs label');
  assert(/External canonical reference:/.test('- External canonical reference: mprr'), 'guard must catch a reintroduced ADR reference label');
  return { adr: 'ADR-0009', deBrandedEnv: ['LBA_MPRR_ROOT', 'LBA_CONFORMANCE_OUT'], backCompat: 'VIHS_MPRR_ROOT' };
});
// The absorbed ring is a FAITHFUL mirror only while its GOVERNED constants equal the real mprr spec.
// Verified against the local svelderrainruiz/mprr source: MPRR-REQ-106 (45 s block, <=1% normal / >5%
// non-authoritative) + Program.cs GovernedDefaultBlockDurationMilliseconds=45_000; MPRR-REQ-110 admission +
// Program.cs Math.Ceiling(window * 1.10); the writer's mprr-self-test-synthetic-monotonic-100ns tick
// (RelativeMilliseconds * 10_000). Pinning them here fails closed if the absorbed mirror drifts (ADR-0009).
check('mprr-absorbed-constants-match-mprr-spec', () => {
  assert(TICKS_PER_MS === 10_000n, `100ns tick: TICKS_PER_MS must be 10_000n, got ${TICKS_PER_MS}`);
  assert(DEFAULT_BLOCK_DURATION_MS === 45_000, `MPRR-REQ-106 block duration must be 45_000 ms, got ${DEFAULT_BLOCK_DURATION_MS}`);
  assert(DEFAULT_BLOCK_DURATION_TICKS === 450_000_000n, `block duration must be 450_000_000 ticks, got ${DEFAULT_BLOCK_DURATION_TICKS}`);
  assert(NORMAL_LOAD_BOUNDARY_VARIATION_PCT === 1.0, `MPRR-REQ-106 normal-load boundary target must be 1.0 pct, got ${NORMAL_LOAD_BOUNDARY_VARIATION_PCT}`);
  assert(AUTHORITATIVE_BOUNDARY_VARIATION_PCT === 5.0, `MPRR-REQ-106 non-authoritative boundary must be 5.0 pct, got ${AUTHORITATIVE_BOUNDARY_VARIATION_PCT}`);
  assert(ADMISSION_CAPACITY_HEADROOM === 1.1, `MPRR-REQ-110 admission headroom must be 1.1 (10 pct), got ${ADMISSION_CAPACITY_HEADROOM}`);
  return { blockMs: DEFAULT_BLOCK_DURATION_MS, headroomPct: (ADMISSION_CAPACITY_HEADROOM - 1) * 100, ticksPerMs: Number(TICKS_PER_MS) };
});

// boot-benchmark recorder seam (experiments/mprr-boot-benchmark): the boot-as-benchmark sibling of the
// manual-procedure-record method. Seals a synthetic mesh-actor boot and pins the clock-tagged spans + the
// fail-closed correlation gate + the serial/journald parsers, so the dual-clock design cannot silently rot.
check('boot-benchmark-seal-spans-and-fail-closed', () => {
  const gray = () => new Uint8Array([128, 128, 128, 255]); // 1x1 gray frame (fingerprint/integrity only)
  const frames = [];
  for (let i = 0; i < 6; i += 1) frames.push({ hostMonotonicMs: 100 + i * 100, rgba: gray(), width: 1, height: 1 });
  const base = {
    iteration: 'gate', sessionId: 'gate', hypervisor: 'virtualbox', plane: 'LINUX',
    capture: { backend: 'vbox-screenshotpng', transport: 'VBoxManage controlvm screenshotpng', cadenceHz: 2 },
    procedure: { id: 'mesh-actor-boot', milestones: ['BOOT-START', 'LBABUS-BUILD-START', 'LBABUS-BUILT', 'MESH-OK'] },
    hostT0MonotonicMs: 0,
    frames,
    serialMarkers: [
      { caseId: 'BOOT-START', serialMonotonicMs: 50, hostArrivalMonotonicMs: 100 },
      { caseId: 'LBABUS-BUILD-START', serialMonotonicMs: 1000, hostArrivalMonotonicMs: 200 },
      { caseId: 'LBABUS-BUILT', serialMonotonicMs: 9000, hostArrivalMonotonicMs: 500 },
      { caseId: 'MESH-OK', serialMonotonicMs: 9500, hostArrivalMonotonicMs: 600 },
    ],
    guestTiming: { 'BOOT-START': 50, 'LBABUS-BUILD-START': 1000, 'LBABUS-BUILT': 9000, 'MESH-OK': 9500 },
  };
  const rec = sealBootBenchmark(base);
  assert(rec.schema === 'labview-benchmark-actor/boot-benchmark-v1', 'boot-benchmark schema id');
  assert(rec.anchor.correlation.allMilestonesPinned === true, 'all milestones must pin');
  assert(rec.seal.rawDiscarded === true && /^[0-9a-f]{64}$/.test(rec.seal.recordHash), 'sealed + recordHash');
  assert(rec.frames.every((f) => !('rgba' in f) && !('png' in f)), 'raw pixels must be discarded on seal');
  const span = (id) => rec.spans.find((s) => s.id === id);
  assert(span('buildMs').ms === 8000 && span('buildMs').clock === 'guest' && span('buildMs').scope === 'cross-plane',
    'buildMs must be 8000ms guest/cross-plane');
  assert(span('meshFormMs').ms === 500 && span('meshFormMs').scope === 'cross-plane', 'meshFormMs guest/cross-plane');
  assert(span('bootToMeshMs').clock === 'host' && span('bootToMeshMs').scope === 'within-plane',
    'bootToMeshMs must be host/within-plane (includes firmware; not cross-plane comparable)');
  // fail-closed determinism: a missing milestone pin must NOT seal
  let threw = false;
  try { sealBootBenchmark({ ...base, serialMarkers: base.serialMarkers.slice(0, 3) }); } catch { threw = true; }
  assert(threw, 'a missing serial pin must fail closed (NOT sealed)');
  // parsers (the two milestone channels)
  const t = parseJournalMonotonic('[   9.000000] h u[1]: lbabus built -> /usr/local/bin/lbabus\n[   9.500000] h m[1]: MESH OK');
  assert(t['LBABUS-BUILT'] === 9000 && t['MESH-OK'] === 9500, 'journald short-monotonic parser maps milestones');
  const m = parseSerialMarkerLine('LBABENCH MESH-OK mono=9.5');
  assert(m && m.caseId === 'MESH-OK' && m.serialMonotonicMs === 9500, 'serial LBABENCH marker parse');
  assert(parseSerialLog('noise\nLBABENCH BOOT-START mono=0.05\nLBABENCH BOOT-START mono=9').length === 1, 'serial log first-per-case');
  // Emit-contract drift guard: the canonical helper AND the copy embedded in provision-lbabus-fromsource.sh
  // must BOTH write the LBABENCH mono= wire line, guard the serial write on /dev/ttyS0, and log the
  // authoritative journald line — so the two milestone channels cannot silently diverge.
  const emitCanon = readFileSync(join(pkgRoot, 'experiments', 'mprr-boot-benchmark', 'emit-boot-marker.sh'), 'utf8');
  const provScript = readFileSync(join(pkgRoot, 'cleanroom', 'ubuntu-labview', 'provision-lbabus-fromsource.sh'), 'utf8');
  for (const [n, body] of [['canonical', emitCanon], ['provisioned', provScript]]) {
    assert(body.includes('LBABENCH ${CASE_ID} mono='), `${n} emit must write the LBABENCH mono= wire line`);
    assert(body.includes('[ -w /dev/ttyS0 ]'), `${n} emit must guard the serial write on /dev/ttyS0`);
    assert(body.includes('logger -t lbabench'), `${n} emit must log the authoritative journald line`);
  }
  // Full LINUX suite (seal + spans + fail-closed + parsers + VBox backend argv + the boot-recorder driver's
  // `await capture()` sync/async equivalence + cross-iteration delta) as a subprocess, so the whole recorder
  // core is gated in CI on both planes (mirrors the VMware VNC gate below).
  execFileSync(process.execPath, [join(here, 'mprr-boot-benchmark', 'verify-boot-benchmark.mjs')], { stdio: 'pipe' });
  return { buildMs: span('buildMs').ms, meshFormMs: span('meshFormMs').ms, bootToMeshMs: span('bootToMeshMs').ms, suite: 'verify-boot-benchmark subprocess' };
});

// boot-benchmark WIN/VMware capture backend (mprr-boot-benchmark/capture-backend-vmware.mjs): the VMware side
// of the shared capture seam. In-process gates the sync contract + .vmx serial/VNC config + vmx upsert (the
// rot-prone surface, matching the LINUX seal gate's in-process style); then runs the full async RFB-decode
// suite as a subprocess so the VNC framebuffer grab is gated in CI on both planes too.
check('boot-benchmark-vmware-vnc-backend', () => {
  const exec = (file, a) => (a.at(-1) === 'list'
    ? { status: 0, stdout: 'Total running VMs: 1\nC:/x.vmx\n', stderr: '' }
    : { status: 0, stdout: '', stderr: '' });
  const be = createVmwareBackend({ vmx: 'C:/x.vmx', vncPort: 5901, exec });
  assert(be.backend === 'vmware-vnc', 'vmware capture backend id');
  assert(be.probe().ok === true, 'probe -> running when vmx in `vmrun list`');
  assert(createVmwareBackend({ vmx: 'C:/absent.vmx', exec }).probe().state === 'stopped', 'probe -> stopped when absent');
  assert(vmwareSerialConfigVmx({ hostFile: '/tmp/s' }).some(([k, v]) => k === 'serial0.fileType' && v === 'file'),
    'serial0 file sink (VMware analog of --uartmode1 file)');
  assert(vmwareVncConfigVmx({ port: 5901 }).some(([k, v]) => k === 'RemoteDisplay.vnc.enabled' && v === 'TRUE'),
    'RemoteDisplay.vnc enabled (power-on framebuffer, not Tools-gated captureScreen)');
  const vmx = upsertVmxConfig('serial0.present = "FALSE"\n', [['serial0.present', 'TRUE']]);
  assert(/serial0\.present = "TRUE"/.test(vmx) && (vmx.match(/serial0\.present/g) || []).length === 1,
    'vmx upsert replaces in place (no duplicate key)');
  // full async RFB (VNC) decode against a scripted mock server — subprocess so the async path is gated too
  execFileSync(process.execPath, [join(here, 'mprr-boot-benchmark', 'verify-boot-benchmark-vmware.mjs')], { stdio: 'pipe' });
  return { backend: 'vmware-vnc', vncGrab: 'RFB subprocess 23/23' };
});

// boot-benchmark cross-iteration diff (mprr-boot-benchmark/boot-benchmark-diff.mjs): the WIN consumer side.
// Timing is the HARD GATE (guest-clock cross-plane spans); the host-clock within-plane span is REFUSED across
// hypervisors (it would diff firmware, not the build); the visual dhash-64 delta is a witness, not the gate.
check('boot-benchmark-cross-iteration-diff', () => {
  const rec = (o) => ({
    schema: 'labview-benchmark-actor/boot-benchmark-v1', iteration: o.it, hypervisor: o.hv ?? 'vmware',
    fingerprintAlgo: 'dhash-64', fingerprintSpecVersion: 1,
    frames: [{ index: 0, hostMonotonicMs: 0, settled: true, caseId: 'MESH-OK', perceptualFingerprint: o.fp ?? '0000000000000000', integrityHash: 'a'.repeat(64) }],
    spans: [
      { id: 'buildMs', from: 'LBABUS-BUILD-START', to: 'LBABUS-BUILT', clock: 'guest', scope: 'cross-plane', ms: o.build },
      { id: 'bootToMeshMs', from: 'hostT0', to: 'MESH-OK', clock: 'host', scope: 'within-plane', ms: o.boot ?? 20000 },
    ],
    visual: { gated: false, perMilestone: [{ caseId: 'MESH-OK', hammingTolerance: 8, roiMask: null }] },
  });
  assert(bootBenchmarkDiff(rec({ it: 'a', build: 8000 }), rec({ it: 'b', build: 12000 })).verdict === 'REGRESSION',
    'a guest-clock buildMs regression (8000->12000) fails the timing gate');
  const xp = bootBenchmarkDiff(rec({ it: 'a', hv: 'virtualbox', build: 8000, boot: 20000 }), rec({ it: 'b', hv: 'vmware', build: 8000, boot: 40000 }));
  assert(xp.verdict === 'PASS' && xp.timing.incomparable.includes('bootToMeshMs'),
    'a within-plane host span is REFUSED across hypervisors (firmware not diffed)');
  const vd = bootBenchmarkDiff(rec({ it: 'a', build: 8000, fp: '0000000000000000' }), rec({ it: 'b', build: 8000, fp: 'ffffffffffffffff' }));
  assert(vd.verdict === 'PASS' && vd.visual.verdict === 'WITNESS_DELTA', 'visual delta is a witness, not the gate');
  // full 25/25 diff suite as a subprocess (mirrors the VMware backend gate)
  execFileSync(process.execPath, [join(here, 'mprr-boot-benchmark', 'verify-boot-benchmark-diff.mjs')], { stdio: 'pipe' });
  return { diff: 'boot-benchmark-diff@1', suite: 'subprocess 25/25' };
});

// cross-plane co-run EVIDENCE (mprr-boot-benchmark/fixtures): re-validate the committed live records so the
// PASS can't silently rot. Re-runs bootBenchmarkDiff on LINUX's real VBox record + WIN's real VMware record
// (both collab-cli-v0.11.0, BUILD-leg) and asserts it still matches the committed cross-plane-diff-receipt.
check('boot-benchmark-cross-plane-co-run-receipt', () => {
  const dir = join(here, 'mprr-boot-benchmark', 'fixtures');
  const vbox = JSON.parse(readFileSync(join(dir, 'vbox-boot-collab-cli-v0.11.0.json'), 'utf8'));
  const vmware = JSON.parse(readFileSync(join(dir, 'vmware-boot-collab-cli-v0.11.0.json'), 'utf8'));
  const receipt = JSON.parse(readFileSync(join(dir, 'cross-plane-diff-receipt.json'), 'utf8'));
  const diff = bootBenchmarkDiff(vbox, vmware);
  assert(diff.verdict === 'PASS', `cross-plane co-run must be PASS (got ${diff.verdict})`);
  assert(diff.verdict === receipt.verdict, `verdict drift vs committed receipt (${diff.verdict} vs ${receipt.verdict})`);
  const build = diff.timing.spans.find((s) => s.id === 'buildMs');
  assert(build && build.scope === 'cross-plane' && build.status === 'match',
    'buildMs must be the guest/cross-plane span and match within tolerance');
  assert(vbox.seal.recordHash === receipt.records.A.recordHash && vmware.seal.recordHash === receipt.records.B.recordHash,
    'receipt recordHashes must match the committed fixtures (no fixture/receipt drift)');
  return { verdict: diff.verdict, buildMs: `${build.msA}->${build.msB} (${build.deltaMs}ms/${build.status})` };
});

// Container-vs-container 4-milestone (bootbench): re-run the bootbench cross-plane diff on the committed WIN +
// LINUX bootbench fixtures + assert it still PASSes and matches the committed receipt (no fixture/receipt drift).
check('bootbench-cross-plane-diff-receipt', () => {
  const dir = join(here, 'mesh-runs', 'fixtures');
  const win = JSON.parse(readFileSync(join(dir, 'win-bootbench-4milestone.json'), 'utf8'));
  const linux = JSON.parse(readFileSync(join(dir, 'linux-bootbench-4milestone.json'), 'utf8'));
  const receipt = JSON.parse(readFileSync(join(dir, 'cross-plane-bootbench-diff-receipt.json'), 'utf8'));
  const diff = bootbenchDiff(win, linux);
  assert(diff.verdict === 'PASS', `bootbench cross-plane must be PASS (got ${diff.verdict})`);
  assert(diff.verdict === receipt.verdict, `verdict drift vs committed receipt (${diff.verdict} vs ${receipt.verdict})`);
  const build = diff.timing.spans.find((s) => s.id === 'buildMs');
  const mesh = diff.timing.spans.find((s) => s.id === 'meshFormMs');
  assert(build && build.scope === 'cross-plane' && build.status === 'match',
    'buildMs must be the guest/cross-plane span and match within tolerance');
  assert(mesh && mesh.witness === true, 'meshFormMs must be the witness span');
  assert(build.deltaMs === receipt.timing.buildMs.deltaMs && mesh.deltaMs === receipt.timing.meshFormMs.deltaMs,
    'span deltas must match the committed receipt (no fixture/receipt drift)');
  return { verdict: diff.verdict, buildMs: `${build.msA}->${build.msB} (${build.deltaMs}ms/${build.status})`, meshFormMs: `${mesh.deltaMs}ms/${mesh.status}` };
});

// Capture-ring ingest adapter (mprr-capture-ring/capture-ring.mjs): the SHARED 24-byte capture-frame contract
// both planes serialize against (LINUX VBox VNC source, WIN VMware VNC source). In-process gates the rot-prone
// surface — the exact 24-byte little-endian layout + packetVersion/reserved bytes, DataView-LE decode at an
// UNALIGNED offset (where a BigUint64Array view would throw), the MILESTONE_IDS single-source map, and the
// OPTIONAL-dhash milestone-only marker round-tripping through a real ring — then runs the full synthetic-frame
// suite as a subprocess (mirrors the boot-benchmark gates) so the whole adapter is gated in CI on both planes.
check('capture-ring-ingest-adapter', () => {
  // Exact 24-byte little-endian layout + self-describing version/reserved bytes.
  const buf = encodeCaptureFrame({ timingTicks64: 0x0102030405060708n, frameIndex: 1, dhash64: 0x1112131415161718n, caseId: 'MESH-OK', settled: true });
  assert(buf.byteLength === PACKET_BYTES, 'capture record must be exactly 24 bytes');
  assert(buf[OFFSETS.timingTicks64] === 0x08 && buf[OFFSETS.timingTicks64 + 7] === 0x01, 'timingTicks64 stored little-endian');
  assert(buf[OFFSETS.dhash64] === 0x18 && buf[OFFSETS.dhash64 + 7] === 0x11, 'dhash64 stored little-endian');
  assert(buf[OFFSETS.packetVersion] === PACKET_VERSION && buf[OFFSETS.reserved] === 0, 'packetVersion(=1)/reserved(=0) bytes present (self-describing record)');
  // MILESTONE_IDS single source (LBABUS- prefix on BUILD-START/BUILT so the recorder reconstructs LBABENCH caseIds).
  assert(MILESTONE_IDS[2] === 'LBABUS-BUILD-START' && MILESTONE_IDS[3] === 'LBABUS-BUILT' && MILESTONE_IDS[4] === 'MESH-OK',
    'MILESTONE_IDS pins the LBABUS- caseIds');
  // DataView-LE decodes at an UNALIGNED offset where a BigUint64Array view would throw (the ring is byte-offset
  // addressed, so a record can land at any physical offset). Place the record at odd offset 3 and decode it.
  const scratch = new Uint8Array(PACKET_BYTES + 3);
  scratch.set(buf, 3);
  const view = scratch.subarray(3, 3 + PACKET_BYTES);
  assert(view.byteOffset % 8 !== 0, 'scratch view is at a non-8-aligned offset');
  let bigUintThrew = false;
  try { new BigUint64Array(view.buffer, view.byteOffset, 1); } catch { bigUintThrew = true; }
  assert(bigUintThrew, 'BigUint64Array would throw at the unaligned offset (why DataView access is mandatory)');
  const dv = decodeCaptureFrame(view);
  assert(dv.caseId === 'MESH-OK' && dv.settled === true && dv.hasFrame === true, 'DataView decodes the record at the unaligned offset');
  // OPTIONAL dhash: a milestone-only marker (dhash64 == 0, milestoneId > 0) round-trips through a real ring.
  const ring = createShortRing(CLI_DEFAULT_CAPACITY_BYTES);
  const s = ring.state().headPublished;
  const e = writeCaptureFrame(ring, { timingTicks64: 5n, frameIndex: 0, caseId: 'LBABUS-BUILT' }).absoluteEndOffset;
  const [rec] = readCaptureFrames(ring, s, e);
  assert(rec.hasFrame === false && rec.dhash64 === 0n && rec.caseId === 'LBABUS-BUILT',
    'milestone-only marker (optional dhash) round-trips through the ring');
  // full synthetic-frame suite (round-trip + unaligned/wrap + fail-closed) as a subprocess
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'verify-capture-ring.mjs')], { stdio: 'pipe' });
  return { packet: `${PACKET_BYTES}B v${PACKET_VERSION}`, access: 'DataView-LE', suite: 'verify-capture-ring subprocess 10/10' };
});

// WIN wiring: the VMware VNC streaming source -> makeRingSink -> the shared capture ring. Gates the seam that a
// live-shaped vmware-vnc-source descriptor (dhash64 as 16-hex, milestoneId, settled) maps + round-trips through
// the 24-byte ring byte-for-byte, that a visual frame can ride a MESH-OK milestone marker, and that an EMPTY
// (uniform all-zero-dhash, no milestone) sample is SKIPPED rather than tripping the adapter's fail-closed guard.
check('capture-ring-vmware-wiring', () => {
  const ring = createShortRing(CLI_DEFAULT_CAPACITY_BYTES);
  const sink = makeRingSink(ring);
  sink.onFrame({ timingTicks64: 12345n, frameIndex: 7, dhash64: 'a1b2c3d4e5f60718', milestoneId: 0, settled: true });   // pure visual
  sink.onFrame({ timingTicks64: 20000n, frameIndex: 8, dhash64: 'a1b2c3d4e5f60718', milestoneId: 4, settled: false });  // visual riding MESH-OK
  sink.onFrame({ timingTicks64: 30000n, frameIndex: 9, dhash64: '0000000000000000', milestoneId: 0 });                  // empty -> skipped
  const { written, skipped } = sink.stats();
  assert(written === 2 && skipped === 1, `sink must write 2 + skip 1 empty (got ${written}/${skipped})`);
  const decoded = readCaptureFrames(ring, sink.writes[0].absoluteStartOffset, sink.writes.at(-1).absoluteEndOffset);
  assert(decoded.length === 2, 'two records round-trip');
  assert(decoded[0].timingTicks64 === 12345n && decoded[0].frameIndex === 7 && decoded[0].dhashHex === 'a1b2c3d4e5f60718' && decoded[0].settled === true && decoded[0].hasFrame === true,
    'visual frame: timing/index/dhash(hex<->u64)/settled round-trip');
  assert(decoded[1].milestoneId === 4 && decoded[1].caseId === 'MESH-OK' && decoded[1].hasFrame === true,
    'a visual frame riding the MESH-OK milestone marker round-trips');
  assert(ringFrameFromDescriptor({ dhash64: '0000000000000000', milestoneId: 0 }) === null, 'empty descriptor maps to null (skipped, not fail-closed)');
  return { written, skipped, marker: decoded[1].caseId };
});

// LINUX wiring: the VirtualBox VNC source (vbox-vnc-source.mjs) rides the SAME shared RFB core (vnc-source.mjs)
// as WIN's VMware source, so it emits byte-identical capture-ring descriptors. In-process gates the VBox VNC
// port default + a descriptor -> makeRingSink -> ring round-trip (dhash hex<->u64 + a MESH-OK marker + settled),
// then runs the full fake-socket source suite (port default + round-trip + cross-plane byte-identity) as a
// subprocess (mirrors the boot-benchmark + capture-ring-ingest-adapter gates).
check('capture-ring-vbox-source', () => {
  assert(VBOX_DEFAULT_VNC_PORT === 5900, 'VBox VNC source defaults to the standard VNC port');
  // A descriptor as the VBox source emits it (dhash64 as 16-hex) maps through makeRingSink + round-trips.
  const fb = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < fb.length; i += 4) { fb[i] = (i * 7) & 255; fb[i + 1] = (i * 13) & 255; fb[i + 2] = (i * 29) & 255; fb[i + 3] = 255; }
  const desc = sampleDescriptor(fb, 16, 16, { frameIndex: 3, t0Ms: 1000, nowMs: 1050, milestoneId: 4, settled: 1 });
  assert(typeof desc.dhash64 === 'string' && desc.dhash64.length === 16, 'descriptor carries dhash64 as 16-hex');
  const ring = createShortRing(CLI_DEFAULT_CAPACITY_BYTES);
  const sink = makeRingSink(ring);
  sink.onFrame(desc);
  const [rec] = readCaptureFrames(ring, sink.writes[0].absoluteStartOffset, sink.writes.at(-1).absoluteEndOffset);
  assert(rec.dhashHex === desc.dhash64 && rec.timingTicks64 === desc.timingTicks64 && rec.frameIndex === 3,
    'VBox descriptor round-trips through the ring (dhash hex<->u64, timing, index)');
  assert(rec.milestoneId === 4 && rec.caseId === 'MESH-OK' && rec.settled === true, 'MESH-OK marker + settled round-trip');
  // full fake-socket suite (port default + round-trip + cross-plane byte-identity) as a subprocess
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'vbox-vnc-source.selftest.mjs')], { stdio: 'pipe' });
  return { port: VBOX_DEFAULT_VNC_PORT, marker: rec.caseId, suite: 'vbox-vnc-source subprocess 3/3' };
});

// README stays Marketplace-safe: repo-relative links 404 on the listing page.
// Shift-left of the agent last gate's `readme-marketplace-safe` check so every PR's
// CI catches a broken listing link before it can reach the final pre-publish gate.
check('readme-marketplace-safe-links', () => {
  const readme = readFileSync(join(pkgRoot, 'README.md'), 'utf8');
  const rel = [...readme.matchAll(/\]\(([^)]+)\)/g)]
    .map((m) => m[1].trim())
    .filter((t) => !/^https?:/.test(t) && !t.startsWith('#') && !t.startsWith('mailto:'));
  assert(rel.length === 0,
    `README has ${rel.length} repo-relative link(s) that 404 on the Marketplace listing: ${rel.slice(0, 4).join(', ')}${rel.length > 4 ? ' ...' : ''}`);
  return { links: 'all absolute or anchors' };
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
