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

import { readFileSync, readdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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
import { recordFromRing } from './mprr-capture-ring/capture-ring-recorder.mjs';
import { fiducialDhash } from './mprr-capture-ring/fiducial-vnc-server.mjs';
import { createVboxVncSource, VBOX_DEFAULT_VNC_PORT, sampleDescriptor } from './mprr-capture-ring/vbox-vnc-source.mjs';
import { DUAL_CLOCK_TICKS, buildDecodeTable, correlateVisualDualClock } from './mprr-capture-ring/visual-dual-clock.mjs';
import { workloadCrossPlaneReceipt } from './mprr-capture-ring/workload-cross-plane.mjs';
import { detectSettle } from './mprr-capture-ring/settle-detect.mjs';
import { buildWorkloadRecord } from './mprr-capture-ring/workload-benchmark.mjs';
import { buildTrend } from './mprr-capture-ring/trend.mjs';
import { buildBenchmarkPanelHtml, buildTrendPanelHtml, scrubberModelFromTrend, dhashGridCells } from './mprr-capture-ring/benchmark-panels.mjs';
import { buildBenchmarkFrameScrubberHtml } from './dashboard-slider/buildBenchmarkFrameScrubberHtml.mjs';
import { buildLaunchCapture } from './mprr-capture-ring/launch-capture.mjs';
import { buildFrameCorrelatorHtml } from './mprr-capture-ring/frame-correlator.mjs';
import { crossPlaneTrendReceipt } from './mprr-capture-ring/cross-plane-trend.mjs';
import { buildResourceUsageCorrelation } from './resource-usage-correlation/resourceUsageCorrelation.mjs';
import { verifyDepManifest } from './labview-authoring/verify-dep-manifest.mjs';
import { crossPlaneResourceCompare } from './mprr-capture-ring/resource-cross-plane.mjs';
import { validateEphemeralMeshReceipt } from './ephemeral-mesh/ephemeralMesh.mjs';
import { execFileSync } from 'node:child_process';
import { compareWitnesses } from './acg-quorum/compare-witnesses.mjs';
import { verifyBeforeConsume } from './acg-provenance/attest.mjs';
import { assessIndependence, enrolledEnvironmentSet } from './acg-independence/independence.mjs';
import { buildVerdictBeacon, MeshLedger, quorumFromLedger } from './acg-mesh/verdict-beacon.mjs';
import { bundleDigest } from './acg-provenance/attest.mjs';
import { gateReleasePublish } from './acg-reviewer/sign-off.mjs';
import { runGrid } from './acg-grid/grid.mjs';
import { verifySignedTreeHead, verifyReleaseInclusion } from './acg-transparency/transparency-log.mjs';

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

// 6b. Test<->requirement correspondence (ISO/IEC/IEEE 42010 correspondence graph, ADR-0013): every governed
//     test file corresponds to >=1 requirement (rule TR-1, fail-closed); the engine also prints the advisory
//     ADR<->requirement (AD-1) and requirement<->view (VW-1) census. Fails iff a fail-closed rule is broken.
check('test-requirement-correspondence', () => {
  execFileSync(process.execPath, [join(here, 'reqs-coverage', 'verify-correspondences.mjs')], { stdio: 'pipe' });
  return { engine: 'reqs-coverage/verify-correspondences.mjs' };
});

// 6c. Requirements quality (ISO/IEC/IEEE 29148:2018): every governed requirement-register row in
//     docs/requirements/srs.md states exactly ONE `shall` (§5.2.5 Singular) and avoids ambiguous `and/or`
//     logic (§5.2.7). Dependency-free local mirror of repo-standards-review's requirements_quality_check.py
//     (singular-shall), scoped to the governed 5-column table so the 3-column traceability rows are skipped.
check('requirements-quality-29148', () => {
  const srs = readFileSync(join(pkgRoot, 'docs', 'requirements', 'srs.md'), 'utf8');
  const violations = [];
  let governedRows = 0;
  for (const line of srs.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) continue;                       // skip 3-column traceability rows
    if (!/^[A-Z0-9-]*REQ-\d+$/.test(cells[0])) continue;  // skip header / separator / non-ID rows
    const [id, statement] = cells;
    governedRows++;
    const shallCount = (statement.match(/\bshall\b/gi) || []).length;
    if (shallCount !== 1) violations.push(`${id}: ${shallCount}x shall (29148 §5.2.5 Singular requires exactly one)`);
    if (/\band\s*\/\s*or\b/i.test(statement)) violations.push(`${id}: contains "and/or" (29148 §5.2.7 — split into multiple requirements)`);
  }
  assert(governedRows > 0, 'no governed requirement rows found in docs/requirements/srs.md');
  assert(violations.length === 0, `requirements-quality violations:\n    - ${violations.join('\n    - ')}`);
  return { governedRows };
});

// 6d. Traceability matrix is generated + current (LBA-REQ-022, ADR-0013 Stage 3): the derived requirement <->
//     view <-> decision <-> test matrix must match its canonical sources. Fails closed if the committed
//     docs/requirements/traceability-matrix.md drifts (run generate-traceability.mjs to refresh + commit).
check('traceability-matrix-current', () => {
  execFileSync(process.execPath, [join(here, 'reqs-coverage', 'generate-traceability.mjs'), '--check'], { stdio: 'pipe' });
  return { generator: 'reqs-coverage/generate-traceability.mjs' };
});

// 6e. Information for users (ISO/IEC/IEEE 26514:2022, LBA-REQ-034): the bounded information PRODUCT set is
//     COMPLETE -- every required item present + non-trivial, the command reference covers EVERY contributed VS
//     Code command, the conformance boundary is stated, and the navigation hub indexes the set. Fail-closed:
//     the selftest also proves an empty set flags every missing item + any uncovered command.
check('information-for-users-26514', () => {
  execFileSync(process.execPath, [join(here, 'information-for-users', 'verify-information-for-users.selftest.mjs')], { stdio: 'pipe' });
  return { standard: 'ISO/IEC/IEEE 26514:2022', selftest: 'verify-information-for-users 2/2 (committed conformant + fail-closed)' };
});

// 6f. Test & assurance report is generated + current (ISO/IEC/IEEE 29119-3 test report + ISO 10007 status
//     accounting, LBA-REQ-035): the executed-verification-evidence + configuration-status-accounting record
//     must match the apparatus it describes (gate inventory + correspondence rules + coverage floors + RTM +
//     ADRs). Fails closed if docs/testing/test-report.md drifts. The selftest also proves currency,
//     deterministic rendering, and that the drift compare fails closed on any mutation.
check('test-report-current', () => {
  execFileSync(process.execPath, [join(here, 'reqs-coverage', 'generate-test-report.selftest.mjs')], { stdio: 'pipe' });
  return { standard: 'ISO/IEC/IEEE 29119-3 + ISO 10007', selftest: 'generate-test-report 4/4 (current + deterministic + fail-closed)' };
});

// 6g. Release procedure references resolve (ISO/IEC/IEEE 15289 procedure + 12207/10007 release process,
//     LBA-REQ-036): the step-by-step release procedure (docs/release/release-procedure.md) must stay honest --
//     every workflow/script/action path it cites resolves on disk and every required release invariant
//     (SemVer tag on main, bidirectional agreement, keyless signing, transparency-log inclusion,
//     verify-before-install) is named. Fail-closed via the selftest (committed conformant + a missing
//     cited file or a dropped invariant is rejected).
check('release-procedure-references-resolve', () => {
  execFileSync(process.execPath, [join(here, 'release', 'verify-release-procedure.selftest.mjs')], { stdio: 'pipe' });
  return { standard: 'ISO/IEC/IEEE 15289 + 12207', selftest: 'verify-release-procedure 3/3 (conformant + fail-closed)' };
});

// 6h. Continuous compliance self-audit (CAPSTONE, LBA-REQ-037): score THIS repo against the
//     repo-standards-review five-lens rubric (REQ/ARCH/TEST/CM/DOC) at clause-evidence granularity and
//     assert 25/25 at target. Fails closed if any lens drops below target -- deleting an information item,
//     unwiring a gate, or dropping a clause anchor turns the build red. Closes audit finding F4 (non-gated
//     conformance) for ALL standards: full compliance is verified continuously, not just present. The
//     selftest also proves the scoring fails closed on any single missing clause-evidence item.
check('continuous-compliance-self-audit', () => {
  execFileSync(process.execPath, [join(here, 'compliance', 'verify-compliance-posture.selftest.mjs')], { stdio: 'pipe' });
  return { standard: 'repo-standards-review five-lens rubric', selftest: 'verify-compliance-posture 4/4 (25/25 conformant + fail-closed)' };
});

// 6i. LabVIEW activation confirmation (LBA-REQ-038, realizes ADR-0023 Phase 1): the first delivered slice of
//     personal golden-VM onboarding. A headless KNOWN-ANSWER probe VI (LabVIEWCLI RunVI on the shipped
//     AddTwoNumbers.vi) must return the expected sum for the install to count as activated; the committed
//     REAL capture deterministically rebuilds the receipt offline (no LabVIEW in CI) and the confirmation
//     FAILS CLOSED on a non-zero exit, a wrong value, a missing success line, or a tampered receipt.
check('activation-receipt-confirms-activation', () => {
  execFileSync(process.execPath, [join(here, 'activation', 'buildActivationReceipt.selftest.mjs')], { stdio: 'pipe' });
  return { standard: 'ADR-0023 Phase 1', selftest: 'buildActivationReceipt 5/5 (real replay + fail-closed)' };
});

// 6j. Mesh-actor registration gated on activation (LBA-REQ-039, realizes ADR-0023 Phase 1): a golden VM is
//     enrolled in mesh-actors.csv ONLY after its activation-receipt@1 confirms activation. An unactivated or
//     tampered receipt is refused and the registry is left untouched; registration is idempotent by
//     role+actor_id. This binds confirmation and enrollment into one fail-closed chain.
check('mesh-actor-registration-requires-activation', () => {
  execFileSync(process.execPath, [join(here, 'activation', 'registerMeshActor.selftest.mjs')], { stdio: 'pipe' });
  return { standard: 'ADR-0023 Phase 1', selftest: 'registerMeshActor 4/4 (activated registers + fail-closed refusal)' };
});

// 6k. Agent tooling selftest (scripts/lba.mjs): the agent-facing governance + verification helper is
//     DESIGNED TO BE ITERATIVELY REFINED by each agent. This gate keeps it working across refinements --
//     pipeline scripts + governance-surface files resolve, the id helpers advance, and govern-check both
//     confirms a fully-governed requirement and fails closed on a missing one. Extend the tool freely;
//     the gate catches regressions.
check('agent-tooling-selftest', () => {
  execFileSync(process.execPath, [join(pkgRoot, 'scripts', 'lba.mjs'), 'selftest'], { stdio: 'pipe' });
  return { tool: 'scripts/lba.mjs', note: 'iteratively-refined agent governance + verification helper' };
});

// 6l. Distributed parallel workload across an N-instance pool (LBA-REQ-040, ADR-0028): the committed receipt
//     of a real run -- this host + N codespace/VM workers each ran a DISJOINT, capacity-weighted shard of the
//     self-test workload CONCURRENTLY, every instance ripgrep-only -- must validate: the capacity-weighted
//     split re-derived from the recorded weights reproduces the shards, they are disjoint + cover every task,
//     the instances are distinct, and every task passed. Offline replay of the committed real receipt.
check('distributed-parallel-workload', () => {
  execFileSync(process.execPath, [join(here, 'parallel', 'verify-parallel-workload.selftest.mjs')], { stdio: 'pipe' });
  return { standard: 'ADR-0028 distributed workload', selftest: 'verify-parallel-workload 4/4 (N instances, capacity-weighted, disjoint, rg-only)' };
});

// 6m. Capability-aware routing (LBA-REQ-041, ADR-0029): extends the distributed executor so each task runs
//     ONLY on an instance with the capability it requires -- a real LabVIEW task (LabVIEWCLI RunVI) is routed
//     to the LabVIEW-capable host, node tasks spread across the pool, every instance ripgrep-only. The
//     committed real receipt must validate: capability-correct placement, deterministic re-route, disjoint +
//     full coverage, distinct instances, all passed. Offline replay + fail-closed selftest.
check('capability-aware-routing', () => {
  execFileSync(process.execPath, [join(here, 'parallel', 'verify-capability-routing.selftest.mjs')], { stdio: 'pipe' });
  return { standard: 'ADR-0029 capability routing', selftest: 'verify-capability-routing 5/5 (LabVIEW->host, fail-closed)' };
});

// 6n. Cross-plane LabVIEW liveness (LBA-REQ-042, ADR-0030): the fleet has >= 2 independent, activated,
//     operational LabVIEW planes -- this host + a LabVIEW VM (the Phase 1 golden VM) each ran the
//     known-answer activation probe (LabVIEWCLI RunVI) concurrently and returned the answer. The committed
//     real receipt must validate: >= 2 distinct planes, each returned its known answer + is activated, all
//     live. Offline replay + fail-closed selftest.
check('cross-plane-labview-liveness', () => {
  execFileSync(process.execPath, [join(here, 'activation', 'verify-cross-plane-liveness.selftest.mjs')], { stdio: 'pipe' });
  return { standard: 'ADR-0030 cross-plane liveness', selftest: 'verify-cross-plane-liveness 4/4 (2 activated LabVIEW planes)' };
});

// 6o. Cross-plane VI Analyzer determinism (LBA-REQ-043, ADR-0031): the SAME VI Analyzer config run on >= 2
//     independent LabVIEW planes (this host + a LabVIEW VM) produces the SAME deterministic resultHash --
//     real, reproducible cross-plane benchmark equivalence (the North Star). The committed real receipt must
//     validate: >= 2 distinct planes, each with a resultHash, ALL identical (consensus). Offline replay.
check('cross-plane-vi-analyzer-determinism', () => {
  execFileSync(process.execPath, [join(here, 'vi-analyzer', 'verify-cross-plane-comparison.selftest.mjs')], { stdio: 'pipe' });
  return { standard: 'ADR-0031 cross-plane determinism', selftest: 'verify-cross-plane-comparison 4/4 (matching resultHash across planes)' };
});

// 6p. Provisioner installs LabVIEW + VIPM (LBA-REQ-044, ADR-0023 Phase 1): the from-scratch Ubuntu golden-VM
//     provisioner (cleanroom/ubuntu-labview/provision-guest.sh) must install BOTH LabVIEW 2026 Community (NI
//     apt repo, committed key) AND VIPM (the JKI .deb, idempotent + deps resolved). The committed live
//     receipt confirms VIPM was installed on the real scratch VM. Fail-closed if either install is missing.
check('provisioner-installs-labview-and-vipm', () => {
  execFileSync(process.execPath, [join(here, 'provisioner', 'verify-provisioner-labview-vipm.selftest.mjs')], { stdio: 'pipe' });
  return { standard: 'ADR-0023 Phase 1', selftest: 'verify-provisioner-labview-vipm 4/4 (LabVIEW + VIPM)' };
});

// 6q. Human-assisted VM bridge (LBA-REQ-045, ADR-0032): the shared-tmux bridge (tools/vm-bridge/vm-bridge.sh)
//     lets an automation agent drive the golden VM's interactive shell while a HUMAN types any password/token
//     directly on the VM -- credentials never transit the agent or the model. Fail-closed if the bridge could
//     ingest a secret, or if the live receipt shows the agent answered a credential prompt.
check('vm-bridge-human-assisted-secret-safety', () => {
  execFileSync(process.execPath, [join(here, 'vm-bridge', 'verify-vm-bridge.selftest.mjs')], { stdio: 'pipe' });
  return { standard: 'ADR-0032 human-in-the-loop secret safety', selftest: 'verify-vm-bridge 4/4 (agent drives VM; human types secrets)' };
});

// 6r. VIPM functionally installs a community package (LBA-REQ-046, ADR-0023 Phase 1): on the from-scratch
//     golden VM, VIPM (Community Edition) installs the operator-designated self-test package g-cli
//     (wiresmith_technology_lib_g_cli) plus its dependency closure into LabVIEW's vi.lib. The committed
//     receipt records each package's files-installed manifest + the vi.lib file growth; fail-closed if any
//     package did not install cleanly or no files landed in vi.lib.
check('vipm-functional-package-install', () => {
  execFileSync(process.execPath, [join(here, 'vipm-install', 'verify-vipm-package-install.selftest.mjs')], { stdio: 'pipe' });
  return { standard: 'ADR-0023 Phase 1 (functional VIPM)', selftest: 'verify-vipm-package-install 8/8 (g-cli + deps installed into vi.lib)' };
});

// 6s. Live golden-VM status + idle-time analysis (LBA-REQ-047, ADR-0023 Phase 1): the live monitor
//     (tools/experiments/vm-live-status/vm-live-status.sh, not gated) streams the VM's CPU busy% over the
//     bridge so no long stretch of "dead time" is invisible; this gate proves the committed REAL timeline
//     receipt's idle-time analysis (idle vs busy spans, idle%, longest idle run) re-derives exactly from its
//     samples. Fail-closed on a stale/tampered analysis, tampered digest, or a degenerate series.
check('vm-live-status-idle-analysis', () => {
  execFileSync(process.execPath, [join(here, 'vm-live-status', 'verify-vm-live-status.selftest.mjs')], { stdio: 'pipe' });
  return { standard: 'ADR-0023 Phase 1 (live VM visibility)', selftest: 'verify-vm-live-status 7/7 (real idle-time analysis, fail-closed)' };
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

// The codespace cleanroom witness (Actor Corroboration Grid, ADR-0014/ADR-0015) runs the SAME gate-suite as
// the VM, so the committed standalone cleanroom/ubuntu-labview/lba/gate-suite.sh MUST stay byte-identical to
// the copy the VM emits via the provision-lbabus-fromsource.sh `<<'GATESH'` heredoc -- one source of truth,
// fail-closed on drift (so the VM path and the codespace witness cannot diverge without CI catching it).
check('cleanroom-gate-suite-shared-in-sync', () => {
  // Line-ending-tolerant: git may check these out CRLF on Windows, which is a checkout artifact, not real
  // drift -- normalize to LF before parsing the heredoc markers + comparing (the identity that matters is
  // content, not the EOL). Without this, a trailing `\r` breaks the `<<'GATESH'` / `GATESH` line matches.
  const norm = (s) => s.replace(/\r\n/g, '\n');
  const prov = norm(readFileSync(join(pkgRoot, 'cleanroom', 'ubuntu-labview', 'provision-lbabus-fromsource.sh'), 'utf8'));
  const lines = prov.split('\n');
  const start = lines.findIndex((l) => l.endsWith("<<'GATESH'"));
  const end = lines.findIndex((l, i) => i > start && l === 'GATESH');
  assert(start >= 0 && end > start, 'the GATESH heredoc must be present in provision-lbabus-fromsource.sh');
  const heredocBody = lines.slice(start + 1, end).join('\n') + '\n';
  const shared = norm(readFileSync(join(pkgRoot, 'cleanroom', 'ubuntu-labview', 'lba', 'gate-suite.sh'), 'utf8'));
  assert(shared === heredocBody, 'cleanroom/ubuntu-labview/lba/gate-suite.sh drifted from the VM GATESH heredoc body');
  return { bodyLines: end - start - 1 };
});

// The Actor Corroboration Grid codespace witness (ADR-0014/ADR-0015): its devcontainer + bootstrap-validate must
// stay well-formed -- noble base (parity with the VBox golden VM), postCreate runs bootstrap-validate, and the
// bootstrap builds lbabus from source AND runs the SHARED gate-suite (not a private copy). Pure string/JSON
// checks (Windows-safe -- no bash invocation, CRLF-tolerant substring matches).
check('codespace-witness-bootstrap-valid', () => {
  const dc = JSON.parse(readFileSync(join(pkgRoot, '.devcontainer', 'cleanroom-witness', 'devcontainer.json'), 'utf8'));
  assert(String(dc.postCreateCommand || '').includes('bootstrap-validate.sh'), 'the witness devcontainer runs bootstrap-validate on postCreate');
  assert(/ubuntu-24\.04/.test(String(dc.image || '')), 'the witness devcontainer is Ubuntu 24.04 (noble) to match the VBox golden VM');
  const bs = readFileSync(join(pkgRoot, 'cleanroom', 'ubuntu-labview', 'codespace', 'bootstrap-validate.sh'), 'utf8');
  assert(bs.startsWith('#!/usr/bin/env bash'), 'bootstrap-validate.sh has a bash shebang');
  assert(bs.includes('set -euo pipefail'), 'bootstrap-validate.sh runs in strict mode');
  assert(bs.includes('cleanroom/ubuntu-labview/lba/gate-suite.sh'), 'the witness runs the SHARED gate-suite (single source), not a copy');
  assert(bs.includes('dotnet publish') && bs.includes('LbaBus.csproj'), 'the witness builds lbabus from source');
  return { devcontainer: 'noble', runsSharedGateSuite: true };
});

// The ACG codespace-witness PREBUILD workflow (ADR-0014/ADR-0015): a REAL container build of the witness
// devcontainer that runs bootstrap-validate (postCreate) and asserts the gate-suite receipt is `pass` -- the CI
// reproducibility proof behind the codespace witness. Assert it stays wired to the witness devcontainer + bootstrap
// and still validates the receipt verdict (CRLF-normalized: Windows checkout is CRLF; substring matches only).
check('codespace-witness-prebuild-workflow-wired', () => {
  const wf = readFileSync(join(pkgRoot, '.github', 'workflows', 'codespace-witness-prebuild.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert(wf.includes('devcontainers/ci@'), 'the prebuild builds via the devcontainers/ci action');
  assert(wf.includes('.devcontainer/cleanroom-witness/devcontainer.json'), 'the prebuild targets the cleanroom-witness devcontainer');
  assert(wf.includes('cleanroom/ubuntu-labview/codespace'), 'the prebuild re-runs when the witness bootstrap changes');
  assert(wf.includes('gate-suite-receipt.json') && wf.includes('verdict'), 'the prebuild validates the witness gate-suite receipt verdict');
  assert(/verdict\s*!==\s*"pass"/.test(wf), 'the prebuild FAILS CLOSED unless the witness verdict is pass');
  return { workflow: 'codespace-witness-prebuild', buildsWitnessContainer: true };
});

// The Actor Corroboration Grid quorum (ADR-0015, LBA-REQ-024): the tiered-anchor, graded-majority compare that
// turns witness bundles into a corroboration verdict must hold -- run its dependency-free self-test as a subprocess.
check('acg-quorum-compare-witnesses', () => {
  execFileSync(process.execPath, [join(here, 'acg-quorum', 'compare-witnesses.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'compare-witnesses 7/7' };
});

// The ACG witness-bundle assembler (ADR-0014/ADR-0015, LBA-REQ-024): composing a witness's gate/render/capability
// receipts into the canonical bundle the quorum ingests must FAIL CLOSED on any missing release-gating anchor and
// corroborate end to end through the quorum -- run its dependency-free self-test as a subprocess.
check('acg-quorum-assemble-witness', () => {
  execFileSync(process.execPath, [join(here, 'acg-quorum', 'assemble-witness.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'assemble-witness 9/9' };
});

// Live corroboration evidence (ADR-0014/ADR-0015, LBA-REQ-024): the committed witness bundles from the REAL
// {CODESPACE, LINUX} grid must still corroborate. Re-derive the verdict from the committed bundles and assert it
// matches the committed corroboration receipt (tamper-evident: a doctored release anchor changes the verdict), and
// that every OS-independent (release-critical) anchor -- plus the Linux render -- is identical across the witnesses.
// The Ubuntu codename MAY differ (noble codespace vs the host's own Ubuntu) -- that divergence is graded, not fatal.
check('acg-quorum-live-corroboration', () => {
  const codespace = readJson('experiments/acg-quorum/witnesses/codespace.bundle.json');
  const host = readJson('experiments/acg-quorum/witnesses/host-linux.bundle.json');
  const receipt = readJson('experiments/acg-quorum/corroboration-receipt.json');
  const verdict = compareWitnesses([codespace, host]);
  assert(verdict.verdict === 'pass', `live corroboration verdict is ${verdict.verdict}`);
  assert(
    verdict.verdict === receipt.verdict && verdict.confidence === receipt.confidence && verdict.consensusVerdict === receipt.consensusVerdict,
    'the committed corroboration receipt must match the re-derived verdict'
  );
  assert(JSON.stringify(verdict.consensus) === JSON.stringify(receipt.consensus), 'the committed consensus anchors must match the re-derived ones');
  assert(verdict.divergences.length === receipt.divergences.length, 'the committed divergences must match the re-derived ones');
  // Every OS-independent (release-critical) anchor must corroborate -- never appear as a divergence -- and so must the Linux render.
  for (const k of ['version', 'sourceCommit', 'verdict', 'seriesHash', 'pngSha256']) {
    assert(verdict.consensus[k] != null, `consensus is missing the ${k} anchor`);
    assert(verdict.divergences.every((d) => d.anchor !== k), `the ${k} anchor must corroborate across the witnesses`);
  }
  return { verdict: verdict.verdict, confidence: +verdict.confidence.toFixed(4), witnesses: verdict.witnesses, tolerated: verdict.divergences.map((d) => d.anchor) };
});

// ACG provenance + attestation engine (ADR-0016, LBA-REQ-025): the enforceable "verify before consume" core --
// Ed25519 enrolled-key witness attestations that fail closed on tamper / un-enrolled identity / rogue key / bad
// signature, and a consume decision that blocks unless every attestation verifies, the witnesses are distinct
// enrolled identities (ADR-0017), and the re-computed quorum passes -- run its dependency-free self-test.
check('acg-provenance-attest', () => {
  execFileSync(process.execPath, [join(here, 'acg-provenance', 'attest.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'attest 10/10' };
});

// LBA-REQ-011 (extended): click-to-marker on the raw benchmark data with a +/-200 ms image-grab tolerance.
// A pointer CLICK resolves to an epoch-ms instant, writes a marker into the launch metadata, and post-processing
// grabs the captured frame image nearest that instant ONLY within the tolerance (never a wrong-frame image).
// Also drift-guards the all-performance-counter correlation schema (>= 20 counters cataloged, 200 ms tolerance).
check('frame-markers-image-grab', () => {
  execFileSync(process.execPath, [join(here, 'resource-usage-correlation', 'frameMarkers.selftest.mjs')], { stdio: 'pipe' });
  const schema = JSON.parse(readFileSync(join(here, 'resource-usage-correlation', 'performance-counter-schema.json'), 'utf8'));
  assert(schema.markers && schema.markers.toleranceMs === 200, 'performance-counter schema marker tolerance must be 200 ms');
  const counters = Object.values(schema.counterCatalog || {}).reduce((a, c) => a + c.length, 0);
  assert(counters >= 20, `performance-counter schema must catalog the broad counter set (got ${counters})`);
  return { selftest: 'frameMarkers 12/12', counters };
});

// LBA-REQ-011 (extended, cross-platform + EXACTLY 12 FPS): the full-counter correlation engine + the deterministic
// frame-locked Linux /proc sampler, proven on REAL data (the exact-12-FPS Linux capture + the real LINUX & WIN
// launch fixtures). Drift-guards the committed capture being EXACTLY 12 FPS (1:1 with the 12 FPS long packets).
check('performance-counter-correlation-real', () => {
  execFileSync(process.execPath, [join(here, 'resource-usage-correlation', 'performanceCounterCorrelation.selftest.mjs')], { stdio: 'pipe' });
  const cap = JSON.parse(readFileSync(join(here, 'resource-usage-correlation', 'fixtures', 'linux-proc-12fps-capture.json'), 'utf8'));
  assert(cap.measured && cap.measured.exactly12fps === true, 'the committed Linux capture must be EXACTLY 12 FPS');
  assert(Math.abs(cap.frameIntervalMs - 1000 / 12) < 1e-6, 'frame interval must be exactly 1000/12 ms');
  assert(cap.measured.maxPhaseErrorMs <= 5, `frame-lock phase error must be tight (<=5 ms), got ${cap.measured.maxPhaseErrorMs}`);
  return { selftest: 'performanceCounterCorrelation 4/4 (REAL data)', effectiveFps: cap.measured.effectiveFps };
});

// LBA-REQ-011 (extended, LIVE end-to-end): the capture->correlate driver proven on a committed REAL receipt -- an
// EXACTLY-12-FPS /proc capture with a REAL CPU+disk burst fired at the trigger frame -- must show the correlation
// SURFACING the trigger (an expected counter rose past its detection threshold) with the frame-lock held at the median.
check('performance-counter-correlation-live-trigger', () => {
  execFileSync(process.execPath, [join(here, 'resource-usage-correlation', 'captureAndCorrelate.selftest.mjs')], { stdio: 'pipe' });
  const r = JSON.parse(readFileSync(join(here, 'resource-usage-correlation', 'fixtures', 'linux-proc-12fps-correlated-trigger.json'), 'utf8'));
  assert(r.capture.measured.exactly12fps === true, 'the live capture must be EXACTLY 12 FPS');
  assert(Math.abs(r.capture.frameIntervalMs - 1000 / 12) < 1e-6, 'frame interval must be exactly 1000/12 ms');
  assert(r.capture.measured.medianPhaseErrorMs <= 5, `median frame-lock error must stay tight under load (<=5 ms), got ${r.capture.measured.medianPhaseErrorMs}`);
  assert(r.detection.triggerDetected === true && Array.isArray(r.detection.detectedBy) && r.detection.detectedBy.length >= 1, 'the real burst must be detected across the trigger');
  return { detectedBy: r.detection.detectedBy.map((d) => d.key), effectiveFps: r.capture.measured.effectiveFps };
});

// LBA-REQ-011 (extended, LIVE end-to-end INTEGRATION): the REAL Linux sampler -> buildLaunchCapture -> v2
// correlator chain, proven on a committed receipt captured on this host -- the exact-12-FPS /proc counters survive
// the shipped capture assembler onto EVERY frame and reach the shipped correlator webview model.
check('live-v2-capture-real', () => {
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'liveV2Capture.selftest.mjs')], { stdio: 'pipe' });
  const r = JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', 'live-v2-capture-receipt.json'), 'utf8'));
  assert(r.measured && r.measured.exactly12fps === true, 'the real sampler locked to EXACTLY 12 FPS');
  assert(r.recordSchema === 'labview-benchmark-actor/launch-capture@1', 'the assembler produced a launch-capture@1 record');
  assert(r.everyFrameHasCounters === true && r.correlatorRendersCounters === true, 'counters survive sampler -> assembler -> correlator');
  assert(Array.isArray(r.counterKeys) && r.counterKeys.length >= 12, `the full Linux counter catalog reached the record (${r.counterKeys && r.counterKeys.length})`);
  return { chain: 'linuxProcSampler -> buildLaunchCapture -> frame-correlator', counters: r.counterKeys.length, frames: r.frameCount };
});

// LBA-REQ-011 (extended, mesh-stress-signature@v1): the performance-SIGNATURE extractor -- per-counter features
// + across-repeat stability (signature vs noise by coefficient-of-variation) + MAD outliers + cross-counter
// outlier co-occurrence (+/-200 ms) + autocorrelation periodicity -- proven on synthetic cases + the REAL
// exact-12-FPS Linux /proc capture split into repeats. Pure, dependency-free; the foundation of the mesh ladder.
check('mesh-stress-signature-extractor', () => {
  execFileSync(process.execPath, [join(here, 'mesh-stress-signature', 'signatureExtractor.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'signatureExtractor 5/5', schema: 'mesh-stress-signature@v1' };
});

// LBA-REQ-011 (extended, mesh-stress-signature@v1): the CALIBRATION-CURVE fitter -- fit stressRung -> expected +
// tolerance band per counter-feature from the per-rung signatures, score the monotone/separable/repeatable design
// invariants, and the inverse read (observed signature -> inferred rung). Proven on a synthetic idle..saturate ladder.
check('mesh-stress-signature-calibrator', () => {
  execFileSync(process.execPath, [join(here, 'mesh-stress-signature', 'calibrationCurveFitter.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'calibrationCurveFitter 4/4', schema: 'mesh-stress-calibration@v1' };
});

// LBA-REQ-011 (extended, mesh-stress-signature@v1): the stress ORCHESTRATOR -- the COMMANDED side of the ladder:
// monotone levels (cap down, workload up) + per-actor VirtualBox throttle (--cpuexecutioncap / --bandwidthctl) +
// guest/host stress-ng commands + a ladder plan pinning each actor to a DIFFERENT level (a horizontal slice).
check('mesh-stress-orchestrator', () => {
  execFileSync(process.execPath, [join(here, 'mesh-stress-signature', 'stressOrchestrator.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'stressOrchestrator 5/5', schema: 'mesh-stress-orchestrator@v1' };
});

// LBA-REQ-011 (extended): the in-guest Linux /proc sampler emits the v2 counters{} catalog (key-for-key at PARITY
// with the host linuxProcSampler), so a Linux actor produces the same performance-counter-correlation@v2 shape a
// Windows PDH actor does. Replays a committed REAL live capture from in-guest-resource-sampler.py.
check('in-guest-sampler-v2', () => {
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'inGuestSamplerV2.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'inGuestSamplerV2 2/2 (REAL)', schema: 'in-guest-resource-sampler@v2' };
});

// LBA-REQ-011 (extended, cross-platform + EXACTLY 12 FPS): the WINDOWS PDH sampler (System.Diagnostics.Performance-
// Counter, WALL-CLOCK frame-locked -- Get-Counter/typeperf floor at 1 Hz), proven on a committed REAL capture from
// the golden Windows VM: EXACTLY 12 FPS + the v2 counters{} catalog + cross-plane parity with linuxProcSampler on
// the shared keys + the series flows through the v2 correlation engine.
check('win-pdh-sampler-12fps', () => {
  execFileSync(process.execPath, [join(here, 'resource-usage-correlation', 'winPdhSampler.selftest.mjs')], { stdio: 'pipe' });
  const cap = JSON.parse(readFileSync(join(here, 'resource-usage-correlation', 'fixtures', 'win-pdh-12fps-capture.json'), 'utf8'));
  assert(cap.plane === 'WIN' && cap.measured.exactly12fps === true, 'the committed Windows PDH capture must be EXACTLY 12 FPS');
  assert(Array.isArray(cap.counterKeys) && cap.counterKeys.length >= 12, `the Windows PDH catalog (${cap.counterKeys && cap.counterKeys.length} keys)`);
  return { selftest: 'winPdhSampler 4/4 (REAL)', plane: 'WIN', effectiveFps: cap.measured.effectiveFps, keys: cap.counterKeys.length };
});

// LBA-REQ-032 (mesh-stress-signature@v1, LIVE): the full stress ladder calibrated END TO END on REAL data -- each
// rung applied REAL scaled CPU load, linuxProcSampler captured a REAL exact-12-FPS series, the extractor built the
// per-rung signatures, and the fitter fit the ladder with the monotone/separable/repeatable invariants HOLDING +
// a held-out rung inverse-reading back to itself. Replays the committed live receipt.
check('mesh-live-ladder-real', () => {
  execFileSync(process.execPath, [join(here, 'mesh-stress-signature', 'liveLadderRun.selftest.mjs')], { stdio: 'pipe' });
  const r = JSON.parse(readFileSync(join(here, 'mesh-stress-signature', 'fixtures', 'mesh-live-ladder-receipt.json'), 'utf8'));
  assert(r.invariants.monotone === 1 && r.invariants.separable === true && r.invariants.repeatable === true, 'the live ladder design invariants must hold on real data');
  assert(r.inverseRead.heldOutRung === r.inverseRead.inferredRung, 'a held-out rung must inverse-read back to itself');
  return { rungs: r.ladder.levels.length, salient: r.salientDimensions.length, cpuCurve: (r.cpuTotalPctMeanCurve || []).map((c) => c.expected) };
});

// LBA-REQ-032 (overview.md §3.6 / VW-1): the mesh-stress calibration ANALYSIS VIEW renders the committed live
// ladder receipt into an inert (script-free) HTML surface -- the commanded ladder, the cpuTotalPct calibration
// curve + tolerance band, the monotone/separable/repeatable invariants, the separability, and the inverse read.
check('mesh-calibration-view', () => {
  execFileSync(process.execPath, [join(here, 'mesh-stress-signature', 'meshCalibrationView.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'meshCalibrationView 6/6', surface: 'script-free HTML' };
});

// LBA-REQ-032 (mesh-stress-signature@v1, LIVE + CONCURRENT): the SIMULTANEOUS mesh -- 5 actors, each pinned to a
// disjoint core pool and commanded to a DIFFERENT rung AT ONCE, are each sampled on their own exact-12-FPS /proc
// series, and every actor is inverse-read back to its OWN rung. Replays the committed concurrent receipt.
check('mesh-concurrent-actors-real', () => {
  execFileSync(process.execPath, [join(here, 'mesh-stress-signature', 'concurrentMeshRun.selftest.mjs')], { stdio: 'pipe' });
  const r = JSON.parse(readFileSync(join(here, 'mesh-stress-signature', 'fixtures', 'mesh-concurrent-actors-receipt.json'), 'utf8'));
  assert(r.measured.exactly12fps === true && r.concurrency.allActorsSampledEveryFrame === true, 'the actors must be sampled simultaneously at exactly 12 FPS');
  assert(r.allActorsRecovered === true && r.perActorInverseRead.every((x) => x.correct), 'every concurrently-stressed actor must inverse-read back to its own rung');
  return { actors: r.perActorInverseRead.length, recovered: r.allActorsRecovered, cpuMeans: r.actors.map((a) => a.cpuPoolPctMean) };
});

// LBA-REQ-032 (mesh-stress-signature@v1, LIVE + WINDOWS VM): a REAL golden-box Win11 VM calibrated as a mesh
// actor -- winMeshActorCapture.ps1 drove the running VM through busy=0..4 via VBoxManage guestcontrol (each an
// exact-12-FPS PDH capture), and runWinVmLadder builds the per-rung signatures + fits + inverse-reads every rung.
// Recomputes from the committed real captures (offline, no VM).
check('win-vm-mesh-ladder-real', () => {
  execFileSync(process.execPath, [join(here, 'mesh-stress-signature', 'winVmLadderRun.selftest.mjs')], { stdio: 'pipe' });
  const r = JSON.parse(readFileSync(join(here, 'mesh-stress-signature', 'fixtures', 'win-vm-ladder-receipt.json'), 'utf8'));
  assert(r.invariants.monotone === 1 && r.invariants.separable === true && r.invariants.repeatable === true, 'the golden VM ladder invariants must hold on real data');
  assert(r.allRungsRecovered === true, 'every rung must inverse-read back to itself on the real VM');
  return { plane: r.vm.plane, cpuCurve: (r.cpuTotalPctMeanCurve || []).map((c) => c.expected), salient: r.salientDimensions.length };
});

// LBA-REQ-032 (mesh-stress-signature@v1, LIVE + CONCURRENT WINDOWS VMs): two real Win11 VMs (golden + a linked
// clone) stressed SIMULTANEOUSLY at different rungs, each PDH-sampled on its own exact-12-FPS series; the
// golden-VM calibration correctly ORDERS which VM is more stressed in every concurrent pairing. Recomputes from
// the committed real captures (offline, no VM).
check('win-vm-concurrent-mesh-real', () => {
  execFileSync(process.execPath, [join(here, 'mesh-stress-signature', 'concurrentVmMesh.selftest.mjs')], { stdio: 'pipe' });
  const r = JSON.parse(readFileSync(join(here, 'mesh-stress-signature', 'fixtures', 'win-vm-concurrent-receipt.json'), 'utf8'));
  assert(r.allPairingsSimultaneous === true, 'the VM pairings must be captured simultaneously');
  assert(r.allPairingsRankedCorrectly === true, 'every concurrent pairing must correctly order which VM is more stressed');
  return { pairings: r.pairings.length, ranked: r.allPairingsRankedCorrectly, exact: `${r.exactRungMatches}/${r.totalReadings}` };
});

// LBA-REQ-032 (overview.md §3.6 / VW-1): the concurrent mesh BOARD renders a committed concurrent-actors
// receipt into an inert (script-free) HTML surface -- one tile per simultaneous actor with its stress bar +
// inverse-read rung + recovered mark, plus the simultaneity/invariant badges.
check('mesh-board-view', () => {
  execFileSync(process.execPath, [join(here, 'mesh-stress-signature', 'meshBoardView.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'meshBoardView 6/6', surface: 'script-free HTML board' };
});

// Live verify-before-consume evidence (ADR-0016, LBA-REQ-025): the committed enrolled-key attestations over the
// real {CODESPACE, LINUX} witness bundles must still verify. Re-run verify-before-consume over the committed
// bundles + attestations + enrollment allowlist and assert it matches the committed consume decision -- tamper-
// evident: doctoring a bundle breaks its signature, and a non-enrolled key or a doctored allowlist blocks consume.
check('acg-provenance-verify-before-consume', () => {
  const allowlist = readJson('experiments/acg-provenance/enrollment/allowlist.json');
  const witnesses = [
    { bundle: readJson('experiments/acg-quorum/witnesses/codespace.bundle.json'), attestation: readJson('experiments/acg-provenance/attestations/codespace.attestation.json') },
    { bundle: readJson('experiments/acg-quorum/witnesses/host-linux.bundle.json'), attestation: readJson('experiments/acg-provenance/attestations/host-linux.attestation.json') },
  ];
  const receipt = readJson('experiments/acg-provenance/consume-decision-receipt.json');
  const decision = verifyBeforeConsume({ witnesses, allowlist });
  assert(decision.consume === true, `verify-before-consume blocked: ${decision.reasons.join('; ')}`);
  assert(decision.consume === receipt.consume && JSON.stringify(decision.reasons) === JSON.stringify(receipt.reasons), 'the committed consume decision must match the re-derived one');
  assert(decision.witnesses.length >= 2 && decision.witnesses.every((w) => w.ok), 'every enrolled witness attestation must verify');
  assert(new Set(decision.witnesses.map((w) => w.identity)).size === decision.witnesses.length, 'the witness identities must be distinct');
  return { consume: decision.consume, witnesses: decision.witnesses.map((w) => w.identity) };
});

// ACG witness-independence engine (ADR-0017, LBA-REQ-026): a quorum is independent only when it spans >= quorumMin
// DISTINCT ENROLLED environments each with a recorded identity; non-enrolled, duplicate-environment, and
// identity-less witnesses do not count -- run its dependency-free self-test as a subprocess.
check('acg-independence-quorum', () => {
  execFileSync(process.execPath, [join(here, 'acg-independence', 'independence.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'independence 9/9' };
});

// Live witness-independence evidence (ADR-0017, LBA-REQ-026): the committed {CODESPACE, LINUX} grid must span
// distinct enrolled environments, each with the identity recorded in its provenance (ADR-0016 attestation).
// Re-assess independence over the committed bundles + attestation identities + enrolled-environments and assert
// it matches the committed independence receipt (tamper-evident: a duplicate/non-enrolled environment fails closed).
check('acg-independence-live', () => {
  const enrollment = readJson('experiments/acg-independence/enrolled-environments.json');
  const witnesses = [
    { bundle: readJson('experiments/acg-quorum/witnesses/codespace.bundle.json'), identity: readJson('experiments/acg-provenance/attestations/codespace.attestation.json').witnessIdentity },
    { bundle: readJson('experiments/acg-quorum/witnesses/host-linux.bundle.json'), identity: readJson('experiments/acg-provenance/attestations/host-linux.attestation.json').witnessIdentity },
  ];
  const receipt = readJson('experiments/acg-independence/independence-receipt.json');
  const verdict = assessIndependence(witnesses, { enrolledEnvironments: enrolledEnvironmentSet(enrollment) });
  assert(verdict.independent === true, `the live grid is not independent: ${verdict.reasons.join('; ')}`);
  assert(JSON.stringify(verdict) === JSON.stringify(receipt), 'the committed independence receipt must match the re-derived verdict');
  assert(verdict.counted.length >= 2 && verdict.counted.every((c) => c.identity), 'every counted witness must have a recorded identity');
  return { independent: verdict.independent, environments: verdict.distinctEnrolledEnvironments };
});

// ACG governance: PRs target develop, not main (ADR-0021, LBA-REQ-030). The base-branch policy -- non-release
// heads may not target main; only release/* and hotfix/* do (main never takes develop directly) -- must hold.
check('acg-governance-pr-base-branch', () => {
  execFileSync(process.execPath, [join(here, 'acg-governance', 'pr-base-branch-guard.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'pr-base-branch-guard 11/11' };
});

// The base-branch guard WORKFLOW (ADR-0021, LBA-REQ-030) must stay wired: it runs on pull requests targeting main
// and invokes the guard script, so a mis-based PR onto main fails closed (CRLF-normalized; substring checks only).
check('acg-governance-pr-base-branch-workflow-wired', () => {
  const wf = readFileSync(join(pkgRoot, '.github', 'workflows', 'pr-base-branch-guard.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert(/pull_request:/.test(wf) && /branches:\s*\[\s*main\s*\]/.test(wf), 'the guard triggers on pull requests targeting main');
  assert(wf.includes('experiments/acg-governance/pr-base-branch-guard.mjs'), 'the workflow invokes the base-branch guard script');
  assert(wf.includes('github.base_ref') && wf.includes('github.head_ref'), 'the workflow passes the PR base/head refs to the guard');
  return { workflow: 'pr-base-branch-guard', guardsMain: true };
});

// ACG mesh verdict beacon + ledger (ADR-0019, LBA-REQ-028): a witness verdict must beacon as a valid bus-msg@1
// NOTE, survive the real 4-byte-framed wire, fail closed on malformed frames, and the ledger must dedup + feed the
// quorum -- run its dependency-free self-test as a subprocess.
check('acg-mesh-verdict-beacon', () => {
  execFileSync(process.execPath, [join(here, 'acg-mesh', 'verdict-beacon.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'verdict-beacon 8/8' };
});

// Live mesh loopback evidence (ADR-0019, LBA-REQ-028): the committed loopback receipt -- the real {codespace, host}
// verdicts beaconed over bus-msg@1 and collected in the ledger -- must re-derive deterministically from the
// committed bundles (tamper-evident: the ledgerHash + mesh quorum are recomputed from the same beacons/bundles).
check('acg-mesh-loopback-evidence', () => {
  const codespace = readJson('experiments/acg-quorum/witnesses/codespace.bundle.json');
  const host = readJson('experiments/acg-quorum/witnesses/host-linux.bundle.json');
  const receipt = readJson('experiments/acg-mesh/mesh-loopback-receipt.json');
  const notice = (id, b) => ({ identity: id, plane: b.plane, os: b.os, verdict: b.gate.verdict, digest: bundleDigest(b), seriesHash: b.screenshot.seriesHash, sourceCommit: b.gate.lbabus.sourceCommit });
  const led = new MeshLedger();
  led.record(buildVerdictBeacon(notice('acg-witness:codespace', codespace), { seq: 1 }));
  led.record(buildVerdictBeacon(notice('acg-witness:host-linux', host), { seq: 2 }));
  const out = quorumFromLedger(led, { bundlesByDigest: { [bundleDigest(codespace)]: codespace, [bundleDigest(host)]: host } });
  assert(out.quorum.verdict === 'pass', `mesh quorum is ${out.quorum.verdict}`);
  assert(out.resolved === 2 && out.missing.length === 0 && out.mismatched.length === 0, 'both beaconed witnesses must resolve to their bundles');
  assert(out.ledgerHash === receipt.ledgerHash, 'the committed mesh ledgerHash must match the re-derived one');
  assert(out.quorum.verdict === receipt.meshQuorum.quorum.verdict && out.resolved === receipt.meshQuorum.resolved, 'the committed mesh receipt must match the re-derived verdict');
  return { quorum: out.quorum.verdict, resolved: out.resolved, ledgerHash: out.ledgerHash.slice(0, 12) };
});

// ACG MCP orchestration surface (ADR-0020, LBA-REQ-029): the grid tools must be discoverable + invocable over the
// JSON-RPC 2.0 MCP contract (initialize / tools/list / tools/call) composing the engines, and the stdio server must
// answer a real spawned round-trip -- run its dependency-free self-test as a subprocess.
check('acg-mcp-grid-surface', () => {
  execFileSync(process.execPath, [join(here, 'acg-mcp', 'grid-tools.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'grid-tools 10/10' };
});

// ACG reviewer station + human sign-off (ADR-0018, LBA-REQ-027): a corroborated release must be blocked from
// publishing until a recorded, enrolled, approving human sign-off accompanies the exact machine-quorum verdict --
// and the sign-off must not substitute for the quorum -- run its dependency-free self-test as a subprocess.
check('acg-reviewer-sign-off', () => {
  execFileSync(process.execPath, [join(here, 'acg-reviewer', 'sign-off.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'sign-off 10/10' };
});

// Live release-decision evidence (ADR-0018, LBA-REQ-027): the real corroborated release must be BLOCKED pending a
// human sign-off. Re-derive the LBA-REQ-027 gate over the committed machine-quorum verdict with no sign-off and
// assert the machine quorum passed but publish is blocked -- matching the committed release-decision receipt.
check('acg-reviewer-release-decision', () => {
  const quorumVerdict = readJson('experiments/acg-quorum/corroboration-receipt.json');
  const receipt = readJson('experiments/acg-reviewer/release-decision-receipt.json');
  const decision = gateReleasePublish({ quorumVerdict, signOffs: [] });
  assert(decision.quorumPass === true, 'the committed corroboration must pass the machine quorum');
  assert(decision.publish === false, 'publish must be blocked with no recorded human sign-off');
  assert(decision.publish === receipt.decision.publish && decision.quorumPass === receipt.decision.quorumPass, 'the committed release decision must match the re-derived one');
  return { publish: decision.publish, quorumPass: decision.quorumPass };
});

// The Actor Corroboration Grid END-TO-END (ADR-0014, LBA-REQ-023, the umbrella): the whole gate -- independence +
// quorum + attestation + mesh + human sign-off composed into one release decision -- must hold and fail closed on
// any failing stage. Run its dependency-free self-test as a subprocess.
check('acg-grid-e2e', () => {
  execFileSync(process.execPath, [join(here, 'acg-grid', 'grid.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'grid 6/6' };
});

// Live end-to-end grid evidence (ADR-0014, LBA-REQ-023): the REAL {codespace, host} grid must corroborate the
// release through every MACHINE stage (independence + quorum + attestation + mesh) and be held only at the human
// sign-off gate. Re-derive runGrid over the committed witnesses + attestations + enrollment and assert
// machineCorroborated with released blocked pending sign-off -- matching the committed grid-run receipt.
check('acg-grid-run-live', () => {
  const witnesses = [
    { bundle: readJson('experiments/acg-quorum/witnesses/codespace.bundle.json'), attestation: readJson('experiments/acg-provenance/attestations/codespace.attestation.json') },
    { bundle: readJson('experiments/acg-quorum/witnesses/host-linux.bundle.json'), attestation: readJson('experiments/acg-provenance/attestations/host-linux.attestation.json') },
  ];
  const result = runGrid({ witnesses, allowlist: readJson('experiments/acg-provenance/enrollment/allowlist.json'), enrollment: readJson('experiments/acg-independence/enrolled-environments.json'), signOffs: [] });
  const receipt = readJson('experiments/acg-grid/grid-run-receipt.json');
  assert(result.machineCorroborated === true, 'the real grid must corroborate through every machine stage');
  for (const s of ['independence', 'quorum', 'attestation', 'mesh']) assert(result.stages[s].ok === true, `machine stage ${s} must pass`);
  assert(result.released === false, 'released must be blocked pending a human sign-off');
  assert(result.machineCorroborated === receipt.result.machineCorroborated && result.released === receipt.result.released, 'the committed grid-run receipt must match the re-derived run');
  return { machineCorroborated: result.machineCorroborated, released: result.released };
});

// The Merkle TRANSPARENCY LOG (ADR-0022, LBA-REQ-031, the rekor analogue): RFC 6962 domain-separated hashing,
// inclusion + append-only consistency proofs, and Ed25519 signed tree heads -- the machine core of
// verify-before-install. Run its dependency-free self-test as a subprocess.
check('acg-transparency-log', () => {
  execFileSync(process.execPath, [join(here, 'acg-transparency', 'transparency-log.selftest.mjs')], { stdio: 'pipe' });
  return { selftest: 'transparency-log 26/26' };
});

// Live transparency-log evidence (ADR-0022, LBA-REQ-031): the REAL {codespace, host} attestations must be
// INCLUDED in the Ed25519-signed Merkle transparency log, and verify-before-install must admit each. Re-derive
// every inclusion against the committed signed root, verify the signed tree head against the enrolled log key,
// and match the committed verify-before-install decision -- fully offline.
check('acg-transparency-log-live', () => {
  const attestations = [
    readJson('experiments/acg-provenance/attestations/codespace.attestation.json'),
    readJson('experiments/acg-provenance/attestations/host-linux.attestation.json'),
  ];
  const proof = readJson('experiments/acg-transparency/release-transparency-receipt.json');
  const allowlist = readJson('experiments/acg-transparency/enrollment/log-allowlist.json');
  const decisionReceipt = readJson('experiments/acg-transparency/inclusion-decision-receipt.json');
  const logPublicKeyPem = allowlist[proof.signedTreeHead.logIdentity];
  assert(!!logPublicKeyPem, 'the signing log identity must be enrolled in the log allowlist');
  assert(verifySignedTreeHead(proof.signedTreeHead, { publicKeyPem: logPublicKeyPem }), 'the signed tree head must verify against the enrolled log key');
  const decisions = attestations.map((attestation, i) => verifyReleaseInclusion({ attestation, inclusion: proof.inclusions[i], signedTreeHead: proof.signedTreeHead, logPublicKeyPem }));
  for (const d of decisions) assert(d.included === true, `attestation must be included in the transparency log (${d.reason || ''})`);
  assert(decisionReceipt.allIncluded === true && decisions.length === decisionReceipt.decisions.length, 'the committed verify-before-install decision must match the re-derived one');
  return { size: proof.signedTreeHead.size, allIncluded: decisions.every((d) => d.included) };
});

// Verify-before-install end-to-end (ADR-0022, LBA-REQ-031): the reviewer-workstation verifier must ADMIT the
// real release-provenance bundle (>= quorumMin witnesses attested + logged) and BLOCK a tampered one. Spawn it
// exactly as the reviewer box would.
check('acg-transparency-verify-before-install', () => {
  const cli = join(here, 'acg-transparency', 'verify-release-inclusion.mjs');
  const provPath = join(here, 'acg-transparency', 'release-provenance-bundle.json');
  execFileSync(process.execPath, [cli, '--provenance', provPath], { stdio: 'pipe' }); // exit 0 = admit
  const bundle = readJson('experiments/acg-transparency/release-provenance-bundle.json');
  bundle.witnesses[0].inclusion.leaf = '0'.repeat(64);
  const tampered = join(tmpdir(), `acg-tampered-prov-${process.pid}.json`);
  writeFileSync(tampered, JSON.stringify(bundle));
  let blocked = false;
  try {
    execFileSync(process.execPath, [cli, '--provenance', tampered], { stdio: 'pipe' });
  } catch {
    blocked = true;
  } finally {
    rmSync(tampered, { force: true });
  }
  assert(blocked, 'verify-before-install must BLOCK a tampered provenance bundle');
  return { admit: true, tamperBlocked: blocked };
});

// The reviewer-workstation provisioner must WIRE verify-before-install (ADR-0022, LBA-REQ-031): it verifies the
// release corroboration provenance and BLOCKS the .vsix install on failure. Drift gate over provision.ps1
// (CRLF-normalized substring checks; fail-closed).
check('acg-transparency-verify-before-install-wired', () => {
  const norm = readFileSync(join(pkgRoot, 'reviewer-workstation', 'provision.ps1'), 'utf8').replace(/\r\n/g, '\n');
  assert(norm.includes('verify-release-inclusion.mjs'), 'provision.ps1 must invoke the verify-before-install verifier');
  const guardAt = norm.indexOf('Assert-ReleaseProvenance -ExtTag');
  const installAt = norm.indexOf('Install-ExtensionForInteractiveUser $vsix');
  assert(guardAt > 0 && installAt > 0 && guardAt < installAt, 'verify-before-install must run BEFORE the .vsix install');
  assert(norm.includes('verify-before-install BLOCKED'), 'provision.ps1 must fail closed (block) when the provenance does not verify');
  return { wired: true };
});

// LBA-REQ-025 sigstore-KEYLESS + public-rekor tier (ADR-0016): the keyless-attest workflow must be wired to
// keyless-sign the release-provenance bundle with cosign under an Actions OIDC identity (a short-lived Fulcio
// certificate + an entry in the public rekor log). Drift gate over the workflow (CRLF-normalized substring
// checks; fail-closed). The LIVE Fulcio/rekor signature is the CI step (needs OIDC + network), demonstrated by
// dispatching the workflow -- it cannot be re-derived offline, unlike the self-hosted transparency log.
check('acg-keyless-attest-workflow-wired', () => {
  const wf = readFileSync(join(pkgRoot, '.github', 'workflows', 'acg-keyless-attest.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert(/id-token:\s*write/.test(wf), 'the workflow must request the OIDC id-token (keyless signing)');
  assert(/sigstore\/cosign-installer/.test(wf), 'the workflow must install cosign');
  assert(/cosign sign-blob/.test(wf), 'the workflow must keyless-sign the provenance bundle with cosign');
  assert(/release-provenance-bundle\.json/.test(wf), 'the workflow must sign the release-provenance bundle');
  assert(/--bundle release-provenance\.sigstore/.test(wf), 'the workflow must emit the sigstore bundle (Fulcio cert + rekor entry)');
  assert(/gh release create/.test(wf), 'the workflow must CREATE the release with the provenance assets attached (immutable-release-safe)');
  return { wired: true };
});

// LBA-REQ-025 / ADR-0016: the REAL release lanes must keyless-attest their artifacts. A shared composite action
// keyless-signs each staged artifact (cosign, Actions OIDC -> Fulcio cert + public rekor), and both release
// workflows invoke it under `id-token: write` before creating the release (assets attached at creation,
// immutable-safe). Drift gate over the action + both workflows (CRLF-normalized substring checks; fail-closed).
check('release-lanes-keyless-attested', () => {
  const action = readFileSync(join(pkgRoot, '.github', 'actions', 'keyless-attest', 'action.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert(/using:\s*composite/.test(action), 'the keyless-attest action must be a composite action');
  assert(/sigstore\/cosign-installer/.test(action), 'the keyless-attest action must install cosign');
  assert(/cosign sign-blob/.test(action), 'the keyless-attest action must keyless-sign the artifacts with cosign');
  for (const wf of ['extension-release.yml', 'collab-cli-release.yml']) {
    const text = readFileSync(join(pkgRoot, '.github', 'workflows', wf), 'utf8').replace(/\r\n/g, '\n');
    assert(/id-token:\s*write/.test(text), `${wf} must grant the OIDC id-token for keyless signing`);
    assert(/uses:\s*\.\/\.github\/actions\/keyless-attest/.test(text), `${wf} must invoke the keyless-attest action before creating the release`);
  }
  // The extension lane's live path under the org tag-creation ruleset: workflow_dispatch builds + keyless-signs
  // and UPLOADS the signed .vsix as a run artifact (a maintainer then cuts the immutable release locally with a
  // bypass token). Drift-guard both so the ruleset-safe lane cannot silently regress to the dead push-tag path.
  const extWf = readFileSync(join(pkgRoot, '.github', 'workflows', 'extension-release.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert(/workflow_dispatch:/.test(extWf), 'extension-release.yml must expose workflow_dispatch (the org-ruleset-safe live release path)');
  assert(/uses:\s*actions\/upload-artifact/.test(extWf), 'extension-release.yml must upload the keyless-signed .vsix as a run artifact so the maintainer can cut the immutable release');
  return { lanes: ['extension-release', 'collab-cli-release'], attested: true };
});

// LBA-REQ-025 / ADR-0016: the reviewer-workstation must cosign-VERIFY the .vsix's keyless signature (a Fulcio
// certificate whose identity is pinned to the extension-release workflow + the GitHub Actions OIDC issuer + a
// public rekor entry) BEFORE installing it. Network-gated on the reviewer box; drift gate over provision.ps1
// (CRLF-normalized substring checks; fail-closed) asserts the verify runs before the install.
check('reviewer-workstation-keyless-verify-wired', () => {
  const norm = readFileSync(join(pkgRoot, 'reviewer-workstation', 'provision.ps1'), 'utf8').replace(/\r\n/g, '\n');
  assert(/cosign verify-blob/.test(norm), 'provision.ps1 must cosign verify-blob the .vsix keyless signature');
  assert(/certificate-identity-regexp/.test(norm) && /extension-release/.test(norm), 'the cosign verify must pin the extension-release workflow certificate identity');
  assert(/token\.actions\.githubusercontent\.com/.test(norm), 'the cosign verify must pin the GitHub Actions OIDC issuer');
  const verifyAt = norm.indexOf('Assert-VsixKeylessSignature -ExtTag');
  const installAt = norm.indexOf('Install-ExtensionForInteractiveUser $vsix');
  assert(verifyAt > 0 && installAt > 0 && verifyAt < installAt, 'the cosign keyless verify must run BEFORE the .vsix install');
  assert(/keyless verify-before-install BLOCKED/.test(norm), 'provision.ps1 must fail closed (block) when the keyless signature does not verify');
  return { wired: true };
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

// 17b. The collab-cli CLI embeds the CANONICAL requirements (SRS + RTM) BY REFERENCE, so `lbabus docs
//      show srs|rtm` surfaces the exact requirements THIS build carries and they stay aligned with the
//      build. Static wiring guard (dep-free, no dotnet): the embed cannot silently regress; the embed
//      round-trip itself is the ci-docs / verify-linux gate.
check('collab-cli-embeds-canonical-requirements', () => {
  const csproj = readFileSync(join(pkgRoot, 'tools', 'collab-cli', 'LbaBus.csproj'), 'utf8');
  for (const [inc, logical] of [
    ['../../docs/requirements/srs.md', 'docs.requirements.srs.md'],
    ['../../docs/requirements/rtm.csv', 'docs.requirements.rtm.csv'],
  ]) {
    assert(csproj.includes(`Include="${inc}"`), `csproj must embed ${inc} by reference`);
    assert(csproj.includes(`<LogicalName>${logical}</LogicalName>`), `csproj must pin the ${logical} manifest name`);
  }
  // The canonical sources the CLI embeds must exist on disk.
  for (const rel of ['srs.md', 'rtm.csv']) {
    assert(existsSync(join(pkgRoot, 'docs', 'requirements', rel)), `docs/requirements/${rel} must exist`);
  }
  // The docs command registry must key both requirement docs so `docs show srs|rtm` resolves.
  const docs = readFileSync(join(pkgRoot, 'tools', 'collab-cli', 'Docs.cs'), 'utf8');
  for (const id of ['"srs"', '"rtm"', '"guide"']) {
    assert(docs.includes(id), `Docs.cs registry must define the ${id} doc`);
  }
  return { embedded: ['srs', 'rtm'], surfacedBy: 'lbabus docs show <id>' };
});

// 17c. GitFlow branch governance (LBA-REQ-016) is documented so the authoritative repo-standards-review CM
//      gate stays PASS: the CM plan must state all three branch rules (the 9 GitFlow signals), the merge
//      method by branch type, and ADR-0010 must record the decision. Dep-free static guard against regression.
check('gitflow-branch-governance-documented', () => {
  const cm = readFileSync(join(pkgRoot, 'docs', 'cm', 'cm-plan.md'), 'utf8');
  assert(/feature branches.*from\s+`?develop`?/i.test(cm) && /feature branches.*(into|target)\s+`?develop`?/i.test(cm), 'CM plan must state feature branches from + back into develop');
  assert(/release branches.*from\s+`?develop`?/i.test(cm) && /release branches.*(into|to)\s+`?main`?/i.test(cm) && /release branches.*(into|to)\s+`?develop`?/i.test(cm), 'CM plan must state release branches from develop to main + develop');
  assert(/delete .*release.*(after|until).*(both|required) merges complete/i.test(cm), 'CM plan must state release-branch deletion after both merges complete');
  assert(/hotfix branches.*from\s+`?main`?/i.test(cm) && /hotfix branches.*(into|to)\s+`?main`?/i.test(cm), 'CM plan must state hotfix branches from + into main');
  assert(/merge method/i.test(cm) && /squash/i.test(cm) && /--no-ff|merge commit/i.test(cm), 'CM plan must document the merge method by branch type (squash for feature; --no-ff merge commit for release/hotfix back-merges)');
  assert(existsSync(join(pkgRoot, 'docs', 'architecture', 'adr', 'ADR-0010-gitflow-branch-governance.md')), 'ADR-0010 must record the GitFlow decision');
  return { rules: ['feature', 'release', 'hotfix', 'merge-method'], adr: 'ADR-0010' };
});

// 17d. Coverage gate (LBA-REQ-016 CM / ISO-IEC-IEEE 29119): the committed Cobertura coverage artifact meets
//      the parametrized floor in coverage-thresholds.json (the PR Coverage Gate workflow enforces it live and
//      `npm run coverage:bump` ratchets the floor up gradually). Dep-free static check.
check('coverage-artifact-meets-floor', () => {
  const floor = readJson('coverage-thresholds.json').floor;
  const xml = readFileSync(join(pkgRoot, 'coverage', 'cobertura-coverage.xml'), 'utf8');
  const m = xml.match(/line-rate="([0-9.]+)"/);
  assert(m, 'coverage/cobertura-coverage.xml must carry a line-rate');
  const linePct = Number(m[1]) * 100;
  assert(linePct >= floor.lines, `coverage line-rate ${linePct.toFixed(2)}% must meet the parametrized floor ${floor.lines}%`);
  const wf = join(pkgRoot, '.github', 'workflows', 'coverage.yml');
  assert(existsSync(wf), 'the PR Coverage Gate workflow (.github/workflows/coverage.yml) must exist');
  assert(/name:\s*PR Coverage Gate/.test(readFileSync(wf, 'utf8')), 'workflow must publish the "PR Coverage Gate / coverage" context');
  return { linePct: +linePct.toFixed(2), floor: floor.lines };
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

// Recorder-as-consumer (mprr-capture-ring/capture-ring-recorder.mjs): reconstruct a boot-benchmark-v1 record
// off the ring's decoded frames. Milestone markers -> guest-clock spans (buildMs/meshFormMs cross-plane), the
// settled visual frame nearest each milestone -> a per-milestone pin. Gates the in-process reconstruction +
// self-diff, then subprocess-runs the three async capture-ring self-tests (RFB parser + wiring + recorder) so
// the socket/stream paths are CI-covered too.
check('capture-ring-recorder', () => {
  const MS = 10_000;
  const ring = createShortRing(CLI_DEFAULT_CAPACITY_BYTES);
  const w = [];
  const put = (f) => w.push(writeCaptureFrame(ring, f));
  put({ timingTicks64: 0, caseId: 'BOOT-START' });
  put({ timingTicks64: 100 * MS, caseId: 'LBABUS-BUILD-START' });
  put({ timingTicks64: 100 * MS, frameIndex: 3, dhashHex: '2222222222222222', settled: true });
  put({ timingTicks64: 5000 * MS, frameIndex: 4, dhashHex: '3333333333333333', settled: true });
  put({ timingTicks64: 5000 * MS, caseId: 'LBABUS-BUILT' });
  put({ timingTicks64: 7000 * MS, frameIndex: 6, dhashHex: '4444444444444444', settled: true });
  put({ timingTicks64: 7000 * MS, caseId: 'MESH-OK' });
  const rec = recordFromRing(ring, w[0].absoluteStartOffset, w.at(-1).absoluteEndOffset, { plane: 'WIN', hypervisor: 'docker-wsl2' });
  const span = (id) => rec.spans.find((s) => s.id === id);
  assert(span('buildMs').ms === 4900 && span('buildMs').scope === 'cross-plane' && span('buildMs').clock === 'guest', 'buildMs=4900 guest cross-plane');
  assert(span('meshFormMs').ms === 2000, 'meshFormMs=2000 from the MESH-OK - LBABUS-BUILT markers');
  assert(rec.frames.find((f) => f.caseId === 'LBABUS-BUILT').perceptualFingerprint === '3333333333333333', 'BUILT settled visual pin reconstructed from the ring');
  assert(bootBenchmarkDiff(rec, rec).verdict === 'PASS', 'reconstructed record self-diffs PASS through bootBenchmarkDiff');
  for (const t of ['vmware-vnc-source.selftest.mjs', 'vmware-ring-capture.selftest.mjs', 'capture-ring-recorder.selftest.mjs']) {
    execFileSync(process.execPath, [join(here, 'mprr-capture-ring', t)], { stdio: 'pipe' });
  }
  return { buildMs: span('buildMs').ms, meshFormMs: span('meshFormMs').ms, subprocessSelftests: 3 };
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

// Fiducial ground truth (mprr-capture-ring/fiducial-vnc-server.mjs): a host-controlled "stopwatch" fiducial
// whose every tick is deterministic + non-uniform (so no frame is skipped as an all-zero no-frame sentinel).
// In-process asserts those properties, then runs the REAL server<->client<->ring round-trip self-test as a
// subprocess — the strongest capture validation (a live RFB peer, not a fake socket) and the ground-truth
// FIDELITY proof (each captured tick's dhash == the known fiducial), i.e. mprr's stopwatch/fiducial for the ring.
check('capture-ring-fiducial-groundtruth', () => {
  assert(fiducialDhash(3) === fiducialDhash(3), 'fiducial is deterministic (same tick -> same dhash)');
  for (let t = 0; t < 16; t++) { assert(fiducialDhash(t) !== '0000000000000000', `fiducial tick ${t} is non-uniform (dhash != the no-frame sentinel)`); }
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'fiducial-capture.selftest.mjs')], { stdio: 'pipe' });
  return { ticks: 16, suite: 'fiducial-capture subprocess (real RFB server<->client<->ring fidelity) 3/3' };
});

// Fiducial CROSS-PLANE receipt: both capture paths — WIN VMware (RFB None-auth) + LINUX VBox (RFB VNC-auth,
// #186) — capture the SAME host-advanced fiducial timeline over real sockets and must produce dhash sequences
// IDENTICAL to each other AND to the ground truth (the visual analog of the bootbench cross-plane diff, but
// deterministic — no VM). In-process re-checks the committed receipt (no fiducial/core drift) + runs the live
// dual-auth re-capture as a subprocess.
check('capture-ring-fiducial-cross-plane', () => {
  const receipt = JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', 'fiducial-cross-plane-receipt.json'), 'utf8'));
  assert(receipt.verdict === 'IDENTICAL', `cross-plane fiducial must be IDENTICAL (got ${receipt.verdict})`);
  const gt = receipt.ticks.map((t) => fiducialDhash(t));
  assert(gt.every((h, i) => h === receipt.groundTruth[i]), 'committed ground truth still equals the recomputed fiducial (no drift)');
  assert(receipt.win.dhashSeq.every((h, i) => h === gt[i]) && receipt.linux.dhashSeq.every((h, i) => h === gt[i]),
    'both None-auth (VMware) and VNC-auth (VBox) capture paths == ground truth');
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'fiducial-cross-plane.mjs')], { stdio: 'pipe' });
  return { ticks: receipt.ticks.length, verdict: receipt.verdict, paths: 'none-auth(VMware) == vnc-auth(VBox) == ground truth' };
});

// Visual dual-clock (mprr-capture-ring/visual-dual-clock.mjs): the guest renders a fiducial "stopwatch" on its
// OWN display advanced on the GUEST monotonic clock; the host captures over VNC + DECODES which step each frame
// shows, pairing guest-display-time -> host-capture-time (the visual analog of the boot-benchmark dual-clock,
// read straight off the pixels). In-process gates tick-distinctness + the correlation math (synthetic guest log
// + capture stream); subprocess runs the full correlator suite (jitter recovery + drift + fail-closed).
check('capture-ring-visual-dual-clock', () => {
  const table = buildDecodeTable();
  assert(table.size === DUAL_CLOCK_TICKS.length, 'dual-clock ticks must decode distinctly at the guest resolution');
  // synthetic: guest advances every 250ms; host captures each +30ms (constant latency) -> zero drift + spread.
  const guestSteps = DUAL_CLOCK_TICKS.map((tick, step) => ({ step, tick, guestMonoMs: 1000 + step * 250 }));
  const captured = [];
  for (const [dhashHex, { step }] of table) captured.push({ hostMs: 500000 + step * 250 + 30, dhashHex });
  const rec = correlateVisualDualClock({ guestSteps, captured });
  assert(rec.pairedSteps === DUAL_CLOCK_TICKS.length && rec.driftMs.spreadMs === 0,
    'constant capture latency -> all steps pair with zero (host-guest) drift spread');
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'verify-visual-dual-clock.mjs')], { stdio: 'pipe' });
  return { steps: DUAL_CLOCK_TICKS.length, correlate: 'guest-display -> host-capture', suite: 'verify-visual-dual-clock subprocess 5/5' };
});

// Combined visual dual-clock (mprr-capture-ring/combined-visual-dual-clock.mjs): the CAPSTONE receipt composing
// both halves of the cross-plane VISUAL ring — IDENTITY (#187: the None-auth + VNC-auth capture paths are
// byte-identical == ground truth) AND CORRELATION (#188: the captured pixels carry a recoverable guest clock,
// every step decoded + paired guest-display -> host-capture). In-process re-checks the committed receipt
// (deterministic structure), then re-runs the live loopback capstone (real sockets) as a subprocess.
check('capture-ring-combined-visual-dual-clock', () => {
  const receipt = JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', 'combined-visual-dual-clock-receipt.json'), 'utf8'));
  assert(receipt.verdict === 'PASS', `combined capstone must be PASS (got ${receipt.verdict})`);
  assert(receipt.identity.verdict === 'IDENTICAL', 'identity half: None-auth(VMware) == VNC-auth(VBox) == ground truth');
  assert(receipt.correlation.pairedSteps === DUAL_CLOCK_TICKS.length && receipt.correlation.allStepsDecoded === true,
    `correlation half: all ${DUAL_CLOCK_TICKS.length} guest steps decoded from the pixels + paired`);
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'combined-visual-dual-clock.mjs')], { stdio: 'pipe' });
  return { verdict: receipt.verdict, identity: receipt.identity.verdict, steps: receipt.correlation.pairedSteps };
});

// Workload cross-plane receipt (mprr-capture-ring/workload-cross-plane.mjs): the cross-plane comparison of a
// visual-ring WORKLOAD benchmark (e.g. a LabVIEW IDE launch) -- diff two sealed workload records (boot-
// benchmark-v1 with a guest launchMs span) via bootBenchmarkDiff. The launch span is a WITNESS (cross-
// hypervisor substrate bias), so a large launch delta is REPORTED, never hard-failed. Gates the diff machinery
// on synthetic records AND on the REAL WIN + LINUX LabVIEW-launch records (both planes captured LIVE): the
// committed receipt can't silently rot.
check('capture-ring-workload-cross-plane', () => {
  const rec = (plane, hv, launchMs) => ({ schema: 'labview-benchmark-actor/boot-benchmark-v1', iteration: `${plane}-lv`, plane, hypervisor: hv, workload: 'labview-ide-launch', fingerprintAlgo: 'dhash-64', frames: [{ caseId: 'READY', counter: 0, settled: true, perceptualFingerprint: 'a1b2c3d4e5f60718', fingerprintAlgo: 'dhash-64' }], spans: [{ id: 'launchMs', ms: launchMs, clock: 'guest', scope: 'cross-plane' }] });
  const r = workloadCrossPlaneReceipt(rec('WIN', 'vmware', 8200), rec('LINUX', 'virtualbox', 6100));
  assert(r.verdict === 'PASS' && r.launch.witness === true && r.launch.msA === 6100 && r.launch.msB === 8200 && r.launch.deltaMs === 2100, 'launchMs witness diff (LINUX 6100 -> WIN 8200)');
  const big = workloadCrossPlaneReceipt(rec('WIN', 'vmware', 20000), rec('LINUX', 'virtualbox', 6100));
  assert(big.verdict === 'PASS' && big.timing.witnessDeltas.includes('launchMs') && big.timing.regressed.length === 0, 'a big cross-hypervisor launch delta is reported (witness), not failed');
  // REAL cross-plane evidence: the two LIVE LabVIEW-launch records (WIN VMware VNC + LINUX VBox VNC) -> receipt.
  const fx = (n) => JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', n), 'utf8'));
  const winRec = fx('labview-launch-record-win.json');
  const linuxRec = fx('labview-launch-record.json');
  assert(winRec.plane === 'WIN' && winRec.hypervisor === 'vmware-vnc' && linuxRec.plane === 'LINUX' && linuxRec.hypervisor === 'vbox-vnc', 'the two real records are the WIN(VMware) + LINUX(VBox) planes');
  // Cross-plane VISUAL fidelity: both planes' LabVIEW Getting-Started window settled to the SAME dhash pin.
  assert(winRec.frames[0].perceptualFingerprint === linuxRec.frames[0].perceptualFingerprint, 'both planes settle on the identical LabVIEW Getting-Started dhash pin');
  const real = workloadCrossPlaneReceipt(winRec, linuxRec);
  assert(real.verdict === 'PASS' && real.launchSpanId === 'launchMs' && real.launch.witness === true && real.launch.status === 'match', 'the real LabVIEW-launch cross-plane receipt is a witnessed PASS/match');
  assert(real.launch.msA === linuxRec.spans[0].ms && real.launch.msB === winRec.spans[0].ms, 'the receipt carries both planes\' real launchMs (LINUX baseline, WIN candidate)');
  const committed = fx('workload-cross-plane-receipt.json');
  assert(JSON.stringify(committed) === JSON.stringify(real), 'the committed cross-plane receipt matches a fresh recompute (no rot)');
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'workload-cross-plane.selftest.mjs')], { stdio: 'pipe' });
  return { launchSpan: 'launchMs (witness)', real: `LINUX ${real.launch.msA} -> WIN ${real.launch.msB}  Δ${real.launch.deltaMs}ms  ${real.launch.status}`, pin: winRec.frames[0].perceptualFingerprint };
});

// Settle detection (mprr-capture-ring/settle-detect.mjs): the deterministic "UI ready" pin a visual-ring
// WORKLOAD benchmark (e.g. a LabVIEW IDE launch) times against — the first frame of the maximal STABLE dhash
// tail (final steady state), tolerance-absorbing small jitter + failing closed while still changing. In-process
// smoke + subprocess the full synthetic self-test.
check('capture-ring-settle-detect', () => {
  const stable = detectSettle([{ ms: 0, dhashHex: 'ff'.repeat(8) }, { ms: 100, dhashHex: '00'.repeat(8) }, { ms: 200, dhashHex: '00'.repeat(8) }, { ms: 300, dhashHex: '00'.repeat(8) }, { ms: 400, dhashHex: '00'.repeat(8) }, { ms: 500, dhashHex: '00'.repeat(8) }], { window: 5 });
  assert(stable.settled && stable.settleFrameIndex === 1 && stable.settleMs === 100, 'settle pin = the first frame of the stable tail');
  const changing = detectSettle([{ ms: 0, dhashHex: '0000000000000000' }, { ms: 100, dhashHex: '1111111111111111' }, { ms: 200, dhashHex: '2222222222222222' }], { window: 5 });
  assert(!changing.settled, 'still changing at capture end -> fails closed');
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'settle-detect.selftest.mjs')], { stdio: 'pipe' });
  return { primitive: 'detectSettle (final steady state)', suite: 'settle-detect subprocess 5/5' };
});

// Visual-ring WORKLOAD benchmark (mprr-capture-ring/workload-benchmark.mjs): assemble a boot-benchmark-v1 record
// for a REAL workload captured through the ring (e.g. a LabVIEW IDE launch) — WIN's settle detector finds the
// UI-READY pin, launchMs = settle - workload-start (HOST-observed, within-plane like bootToMeshMs). In-process
// builds a synthetic launch record + self-diffs it through bootBenchmarkDiff; subprocess runs the full suite.
check('capture-ring-workload-benchmark', () => {
  const fr = (ms, dhashHex) => ({ ms, dhashHex });
  const frames = [fr(1000000, '0000000000000000'), fr(1000800, '00000000000000ff'), fr(1001600, '0000ffffffffffff')];
  for (let i = 0; i < 10; i += 1) frames.push(fr(1002400 + i * 83, 'ffffffffffffffff'));
  const rec = buildWorkloadRecord({ frames, workloadStartMs: 1000000, meta: { plane: 'LINUX', workload: 'labview-ide-launch' }, settle: { window: 8, toleranceHamming: 2 } });
  const launch = rec.spans.find((s) => s.id === 'launchMs');
  assert(launch && launch.scope === 'cross-plane' && launch.ms === 2400, 'launchMs = settle - workload-start (cross-plane witness)');
  assert(rec.frames[0].caseId === 'UI-READY' && rec.frames[0].settled === true, 'the UI-READY visual pin is sealed');
  assert(bootBenchmarkDiff(rec, rec).verdict === 'PASS', 'the workload record self-diffs PASS through bootBenchmarkDiff');
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'verify-workload-benchmark.mjs')], { stdio: 'pipe' });
  return { workload: 'labview-ide-launch', launchMs: launch.ms, suite: 'verify-workload-benchmark subprocess 3/3' };
});

// LabVIEW launch RECEIPT: a REAL LabVIEW 2026 IDE launch captured LIVE through the visual ring on VBox (the
// guest's LabVIEW Getting-Started window, rendered on the console X + captured over VNC; launchMs = the settled
// UI - the launch trigger). Re-validates the committed record's structure + self-diffs it through
// bootBenchmarkDiff (deterministic), so the real-workload evidence can't silently rot.
check('capture-ring-labview-launch-receipt', () => {
  const rec = JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', 'labview-launch-record.json'), 'utf8'));
  assert(rec.schema === 'labview-benchmark-actor/boot-benchmark-v1' && rec.workload === 'labview-ide-launch', 'a LabVIEW IDE-launch record');
  const launch = rec.spans.find((s) => s.id === 'launchMs');
  assert(launch && launch.clock === 'host' && launch.scope === 'cross-plane' && launch.ms > 0, 'launchMs is a positive host-observed cross-plane span');
  assert(rec.frames[0].caseId === 'UI-READY' && rec.frames[0].settled === true, 'the UI-READY visual pin is sealed');
  assert(rec.sourceDetail.stableTailFrames >= rec.sourceDetail.settleOpts.window, 'the UI reached a stable tail >= the settle window');
  assert(bootBenchmarkDiff(rec, rec).verdict === 'PASS', 'the real LabVIEW launch record self-diffs PASS through bootBenchmarkDiff');
  return { workload: rec.workload, launchMs: launch.ms, stableTail: `${rec.sourceDetail.stableTailFrames}/${rec.sourceDetail.framesCaptured}` };
});

// Continuous/TREND analysis (mprr-capture-ring/trend.mjs): turn repeated visual-ring workload benchmarks (e.g.
// launchMs over N LabVIEW launches) into a trend -- stats + a REGRESSION verdict vs a baseline + a DRIFT slope.
// In-process checks a stable series (PASS), a late spike (REGRESSION), and a slope (drift); subprocess the suite.
check('capture-ring-workload-trend', () => {
  const stable = buildTrend({ series: [2500, 2577, 2540, 2560, 2530], metric: 'launchMs', toleranceMs: 2000 });
  assert(stable.verdict === 'PASS' && stable.regressed === false && stable.baselineMs === 2540, 'a stable launchMs series -> PASS (baseline = median)');
  const spike = buildTrend({ series: [2500, 2530, 2560, 2540, 9000], toleranceMs: 2000 });
  assert(spike.verdict === 'REGRESSION' && spike.latest === 9000, 'a late spike -> REGRESSION vs baseline');
  const drift = buildTrend({ series: [2000, 2500, 3000, 3500, 4000], toleranceMs: 2000, driftThresholdMsPerRun: 300 });
  assert(drift.slopeMsPerRun === 500 && drift.drifting === true, 'a gradual slope -> drift detected');
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'verify-trend.mjs')], { stdio: 'pipe' });
  return { metric: 'launchMs', regression: 'latest > baseline + tol', drift: 'least-squares slope', suite: 'verify-trend subprocess 7/7' };
});

// LabVIEW launch TREND receipt: a REAL continuous run of N LabVIEW IDE launches through the visual ring on VBox
// (launchMs per run). Re-validates the committed trend + RE-DERIVES it from the committed run values
// (deterministic), so the real continuous-benchmark evidence can't silently rot.
check('capture-ring-labview-trend-receipt', () => {
  const t = JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', 'labview-launch-trend.json'), 'utf8'));
  assert(t.schema === 'labview-benchmark-actor/workload-trend@1' && t.metric === 'launchMs' && t.n >= 3, 'a LabVIEW launchMs trend over >= 3 runs');
  assert(Array.isArray(t.values) && t.values.length === t.n && t.values.every((v) => v > 0), 'the run series is present + positive');
  const re = buildTrend({ series: t.values, metric: 'launchMs', toleranceMs: t.toleranceMs, driftThresholdMsPerRun: t.driftThresholdMsPerRun });
  assert(re.verdict === t.verdict && re.stats.mean === t.stats.mean && re.stats.spread === t.stats.spread && re.baselineMs === t.baselineMs && re.slopeMsPerRun === t.slopeMsPerRun,
    'the committed trend re-derives from its run values (no drift in the analysis)');
  return { verdict: t.verdict, runs: t.n, meanMs: t.stats.mean, spreadMs: t.stats.spread, slopeMsPerRun: t.slopeMsPerRun };
});

// WIN LabVIEW launch TREND receipt: the WIN-plane mirror of the LINUX trend -- a REAL continuous run of N LabVIEW
// IDE launches through the visual ring on the VMware clean-room (launchMs per run). Re-validates the committed
// WIN trend + RE-DERIVES it from the committed run values (deterministic), so the real WIN continuous-benchmark
// evidence can't silently rot -- and pairs with the LINUX trend for the cross-plane trend-of-trends.
check('capture-ring-labview-trend-receipt-win', () => {
  const t = JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', 'labview-launch-trend-win.json'), 'utf8'));
  assert(t.schema === 'labview-benchmark-actor/workload-trend@1' && t.metric === 'launchMs' && t.n >= 3, 'a WIN LabVIEW launchMs trend over >= 3 runs');
  assert(t.plane === 'WIN' && t.hypervisor === 'vmware-vnc', 'the WIN/VMware plane');
  assert(Array.isArray(t.values) && t.values.length === t.n && t.values.every((v) => v > 0), 'the run series is present + positive');
  const re = buildTrend({ series: t.values, metric: 'launchMs', toleranceMs: t.toleranceMs, driftThresholdMsPerRun: t.driftThresholdMsPerRun });
  assert(re.verdict === t.verdict && re.stats.mean === t.stats.mean && re.stats.spread === t.stats.spread && re.baselineMs === t.baselineMs && re.slopeMsPerRun === t.slopeMsPerRun,
    'the committed WIN trend re-derives from its run values (no drift in the analysis)');
  return { plane: t.plane, verdict: t.verdict, runs: t.n, meanMs: t.stats.mean, spreadMs: t.stats.spread, slopeMsPerRun: t.slopeMsPerRun };
});

// Benchmark UI surfaces: the single-run panel + the trend panel (both shipped in the extension) build from the
// REAL committed record + trend via the PURE, staged builders. The vertical-line scrubber is exercised here as
// the corroboration-lab predecessor of the shipped frame correlator (gated below). Gates the rot-prone surfaces
// in-proc (strict CSP, real launchMs/verdict, one scrubber point per run, dhash-grid frames) + runs the full
// deterministic panel self-test (dhash-decode drift guard, XSS escaping).
check('capture-ring-benchmark-panels', () => {
  const rec = JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', 'labview-launch-record.json'), 'utf8'));
  const trend = JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', 'labview-launch-trend.json'), 'utf8'));
  // single-run panel: a STATIC strict-CSP webview doc carrying the real launchMs + the UI-READY dhash frame.
  const runHtml = buildBenchmarkPanelHtml(rec, 'g');
  assert(runHtml.includes("default-src 'none'") && !/<script/i.test(runHtml) && runHtml.includes(String(rec.spans[0].ms)) && runHtml.includes('data:image/svg+xml;base64,'),
    'single-run panel is a static strict-CSP doc carrying launchMs + the dhash-grid frame');
  // trend panel: the verdict badge + the run-series svg chart.
  const trendHtml = buildTrendPanelHtml(trend, 'g');
  assert(trendHtml.includes(trend.verdict) && trendHtml.includes('<svg class="chart"') && !/<script/i.test(trendHtml),
    'trend panel renders the verdict + the run chart (static)');
  // frame correlator: one scrubber point per run, each carrying the captured UI-READY dhash frame.
  const pin = rec.frames.find((f) => f && f.settled).perceptualFingerprint;
  const model = scrubberModelFromTrend(trend, { pinDhash: pin });
  assert(model.points.length === trend.n && model.points.every((p) => p.image.startsWith('data:image/svg+xml;base64,')), 'frame correlator has one dhash-grid point per run');
  const scrub = buildBenchmarkFrameScrubberHtml(model, 'g');
  assert(scrub.includes("script-src 'nonce-g'") && scrub.includes('data:image/svg+xml;base64,'), 'frame correlator builds a nonce-scoped scrubber doc');
  // the dhash grid IS the 64-bit perceptual fingerprint (the real UI-READY pin has 5 lit cells).
  assert(dhashGridCells(pin).flat().filter(Boolean).length === 5, 'the UI-READY dhash grid renders the real fingerprint bits');
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'verify-benchmark-panels.mjs')], { stdio: 'pipe' });
  return { surfaces: 'single-run + trend + frame-correlator', launchMs: rec.spans[0].ms, verdict: trend.verdict, suite: 'verify-benchmark-panels subprocess' };
});

// The rebuilt LabVIEW-launch FRAME CORRELATOR shipped in the extension: assemble a launch-capture@1 record
// (mprr dual-packet) from synthetic frames + CPU/RAM/disk samples, build the correlator webview, and gate its
// invariants (nonce CSP with img-src cspSource, three metric curves, the draggable red line), then run the full
// deterministic self-test (drift-guarded against the canonical mprrDualPacket) as a subprocess.
check('capture-ring-frame-correlator', () => {
  const startMs = 1_700_000_000_000;
  const N = 6;
  const frames = Array.from({ length: N }, (_, i) => ({ index: i, imageFile: `frame-${String(i).padStart(5, '0')}.png`, imageBytes: 1000 + i, ms: startMs + Math.round((i * 1000) / 12) }));
  const resourceSamples = Array.from({ length: N }, (_, i) => ({ ms: startMs + Math.round((i * 1000) / 12), cpuPct: 10 + i * 5, ramMb: 2000 + i * 10, diskPct: i * 3 }));
  const cap = buildLaunchCapture({ frames, resourceSamples, startMs, fps: 12, meta: { workload: 'labview-launch', plane: 'WIN' } });
  assert(cap.frameCount === N && cap.fps === 12, 'launch-capture assembles the frames at 12 fps');
  assert(cap.dualPacket.authoritative === true && cap.dualPacket.authoritativeFrames === N, 'the mprr dual-packet is authoritative (every long payload admitted)');
  assert(cap.frames.every((f) => typeof f.cpuPct === 'number' && typeof f.ramMb === 'number' && typeof f.diskPct === 'number'), 'each frame carries its nearest CPU/RAM/disk sample');
  const model = { title: 'gate', fps: cap.fps, selectedIndex: 0, frames: cap.frames.map((f) => ({ index: f.index, tMs: f.tMs, cpuPct: f.cpuPct, ramMb: f.ramMb, diskPct: f.diskPct, imageSrc: 'vscode-webview://x/frame' })) };
  const html = buildFrameCorrelatorHtml(model, 'g', 'vscode-webview://x');
  assert(html.includes("script-src 'nonce-g'") && html.includes('img-src vscode-webview://x data:'), 'correlator is a nonce-scoped doc that only loads VM-local webview images');
  assert(html.includes('#ff3b30') && html.includes("'cpuPct'") && html.includes("'ramMb'") && html.includes("'diskPct'"), 'correlator draws the red line + the legacy CPU/RAM/disk fallback metrics');
  // v2: frames carrying a counters{} object plot the performance-counter curves. Source the REAL exact-12-FPS
  // Linux /proc capture (one sample per 12 FPS frame) and assert the catalog + selected keys reach the webview.
  const v2cap = JSON.parse(readFileSync(join(here, 'resource-usage-correlation', 'fixtures', 'linux-proc-12fps-capture.json'), 'utf8'));
  const v2frames = v2cap.samples.slice(0, 24).map((s, i) => ({ index: i, tMs: s.epochMs - v2cap.epochMsAtFrameZero, counters: s.counters, imageSrc: 'vscode-webview://x/f' }));
  const v2html = buildFrameCorrelatorHtml({ title: 'v2', fps: 12, selectedIndex: 0, frames: v2frames, counterKeys: ['cpuTotalPct', 'memAvailableMb', 'diskWriteBytesPerSec'] }, 'g', 'vscode-webview://x');
  assert(v2html.includes('valueOf') && v2html.includes('useCounters'), 'the shipped correlator runtime is v2-counter capable');
  const v2island = JSON.parse(v2html.match(/<script id="fc-model"[^>]*>([\s\S]*?)<\/script>/)[1].replace(/\\u003c/g, '<'));
  assert(v2island.frames[0].counters && typeof v2island.frames[0].counters.cpuTotalPct === 'number', 'real exact-12-FPS counters are carried into the correlator model');
  assert(Array.isArray(v2island.counterKeys) && v2island.counterKeys.length === 3, 'the selected counterKeys are carried into the runtime');
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'verify-launch-capture.mjs')], { stdio: 'pipe' });
  return { record: 'launch-capture@1', frames: N, v2Counters: v2island.counterKeys.length, dualPacket: cap.dualPacket.outcome, suite: 'verify-launch-capture subprocess' };
});

// LBA-REQ-011 (extended): the frame-correlator CLICK-TO-MARKER wiring. Browser-free self-test (the built document
// embeds the click-to-marker runtime + the authoritative classifyPointerGesture / resolveMarkerImageGrab spec the
// runtime mirrors), plus a REPLAY of the committed REAL-pointer Playwright receipt: a real Chromium CLICK drops
// exactly one marker, grabs the nearest frame image within tolerance, and posts it to the host, while a real DRAG
// scrubs the selected frame and drops NO marker.
check('frame-correlator-click-marker', () => {
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'frameCorrelatorMarkers.selftest.mjs')], { stdio: 'pipe' });
  const r = JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', 'frame-correlator-markers-playwright-receipt.json'), 'utf8'));
  assert(r.schema === 'labview-benchmark-actor/frame-correlator-markers-receipt@v1' && r.requirement === 'LBA-REQ-011', 'committed marker receipt shape');
  assert(r.pass === true, 'the committed real-pointer marker proof must pass');
  const byName = Object.fromEntries((r.checks || []).map((c) => [c.name, c.pass]));
  for (const name of ['click drops exactly one marker', 'click marker image admitted within tolerance', 'click posts a frame-marker to the host', 'drag scrubs the selected frame', 'drag drops no new marker', 'no page errors']) {
    assert(byName[name] === true, `real-pointer proof: ${name}`);
  }
  return { selftest: 'frameCorrelatorMarkers 4/4', playwright: `${(r.checks || []).filter((c) => c.pass).length}/${(r.checks || []).length} real-pointer checks` };
});

// CROSS-PLANE TREND-OF-TRENDS receipt: the WIN launchMs trend vs the LINUX launchMs trend (both REAL, both on
// main). Re-computes the receipt from the two committed trends + asserts it matches the committed receipt
// (no-rot). The cross-hypervisor mean delta is a WITNESS (substrate bias) -- reported, never gated; the gate is
// per-plane regression.
check('capture-ring-cross-plane-trend', () => {
  const winT = JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', 'labview-launch-trend-win.json'), 'utf8'));
  const linuxT = JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', 'labview-launch-trend.json'), 'utf8'));
  const committed = JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', 'cross-plane-trend-receipt.json'), 'utf8'));
  const re = crossPlaneTrendReceipt(winT, linuxT);
  assert(re.schema === 'labview-benchmark-actor/cross-plane-trend-receipt@1' && re.metric === 'launchMs', 'a launchMs cross-plane trend receipt');
  assert(re.verdict === 'PASS' && re.win.verdict === 'PASS' && re.linux.verdict === 'PASS', 'both planes\' trends are non-regressed -> PASS');
  assert(re.witness.status === 'match' && re.witness.faster === 'WIN', 'the cross-hypervisor mean delta is a witnessed match');
  assert(JSON.stringify(committed) === JSON.stringify(re), 'the committed cross-plane trend receipt matches a fresh recompute (no rot)');
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'verify-cross-plane-trend.mjs')], { stdio: 'pipe' });
  return { linuxMean: re.linux.mean, winMean: re.win.mean, meanDeltaMs: re.witness.meanDeltaMs, faster: re.witness.faster, verdict: re.verdict };
});

// LIVE resource correlation (LBA-REQ-011): a REAL LabVIEW launch benchmarked through the visual ring WHILE
// the guest's CPU/RAM/disk were sampled in-guest, correlated to the frame timeline and anchored on the UI-READY
// settle (pre = launching / post = settled). Re-derives the committed pre/post windows from the committed
// host-epoch samples (deterministic no-rot) + runs the full resource-correlated-record self-test.
check('capture-ring-resource-correlation-live', () => {
  const fx = JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', 'labview-launch-resource-correlation.json'), 'utf8'));
  assert(fx.schema === 'labview-benchmark-actor/resource-correlated-launch@1' && fx.plane === 'LINUX' && fx.hypervisor === 'vbox-vnc', 'a real LINUX/vbox resource-correlated launch');
  assert(fx.launchMs > 0 && fx.trigger === 'UI-READY' && fx.preSampleCount > 0 && fx.postSampleCount > 0, 'a real launchMs + UI-READY trigger with pre + post samples');
  assert(Array.isArray(fx.samples) && fx.samples.length === fx.sampleCount, 'the host-epoch sample series is present');
  for (const m of ['cpu', 'ram', 'disk']) {
    assert(fx.windows[m] && fx.windows[m].pre && fx.windows[m].post, `${m} has pre + post windows`);
  }
  const re = buildResourceUsageCorrelation({ frameRateHz: fx.frameRateHz, epochMsAtFrameZero: fx.epochMsAtFrameZero, triggerEpochMs: fx.triggerEpochMs, samples: fx.samples });
  assert(JSON.stringify(re.windows) === JSON.stringify(fx.windows), 'the committed pre/post windows re-derive from the committed samples (no rot)');
  assert(re.preSampleCount === fx.preSampleCount && re.postSampleCount === fx.postSampleCount, 'the pre/post split re-derives');
  execFileSync(process.execPath, [join(here, 'mprr-capture-ring', 'verify-resource-correlated-record.mjs')], { stdio: 'pipe' });
  return { launchMs: fx.launchMs, ramDeltaMean: fx.headline.ramDeltaMean, cpuDeltaMean: fx.headline.cpuDeltaMean, pre: fx.preSampleCount, post: fx.postSampleCount };
});

// WIN LIVE resource correlation (LBA-REQ-011, VMware mirror): a REAL LabVIEW launch benchmarked through the
// visual ring on the VMware clean-room WHILE the guest CPU/RAM/disk were sampled in-guest, against a LEAN
// baseline (gdm stopped) so the pre->post delta is LabVIEW's resident load. Re-derives the committed pre/post
// windows from the committed host-epoch samples (deterministic no-rot).
check('capture-ring-resource-correlation-win', () => {
  const fx = JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', 'labview-launch-resource-correlation-win.json'), 'utf8'));
  assert(fx.schema === 'labview-benchmark-actor/resource-correlated-launch@1' && fx.plane === 'WIN' && fx.hypervisor === 'vmware-vnc', 'a real WIN/vmware resource-correlated launch');
  assert(fx.launchMs > 0 && fx.trigger === 'UI-READY' && fx.preSampleCount > 0 && fx.postSampleCount > 0, 'a real launchMs + UI-READY trigger with pre + post samples');
  assert(Array.isArray(fx.samples) && fx.samples.length === fx.sampleCount, 'the host-epoch sample series is present');
  const re = buildResourceUsageCorrelation({ frameRateHz: fx.frameRateHz, epochMsAtFrameZero: fx.epochMsAtFrameZero, triggerEpochMs: fx.triggerEpochMs, samples: fx.samples });
  assert(JSON.stringify(re.windows) === JSON.stringify(fx.windows), 'the committed WIN pre/post windows re-derive from the committed samples (no rot)');
  assert(fx.headline.ramDeltaMean > 50, 'the lean-baseline launch shows LabVIEW loading resident RAM (> 50 MB)');
  return { launchMs: fx.launchMs, ramDeltaMean: fx.headline.ramDeltaMean, pre: fx.preSampleCount, post: fx.postSampleCount };
});

// CROSS-PLANE resource compare (mprr-capture-ring/resource-cross-plane.mjs): put the WIN(VMware) + LINUX(VBox)
// LabVIEW-launch resource costs side by side (pre/post means + pre->post deltas per metric) and check cross-
// plane agreement. All metrics are WITNESSED (cross-hypervisor resource cost carries substrate bias, reported
// not gated), like workloadCrossPlaneReceipt witnesses a single-run launchMs. Asserts both planes' real records
// compare to a witnessed PASS, RAM load AGREES cross-hypervisor, and the committed receipt doesn't rot.
check('capture-ring-resource-cross-plane', () => {
  const fx = (n) => JSON.parse(readFileSync(join(here, 'mprr-capture-ring', 'fixtures', n), 'utf8'));
  const winRc = fx('labview-launch-resource-correlation-win.json');
  const linuxRc = fx('labview-launch-resource-correlation.json');
  const receipt = crossPlaneResourceCompare(winRc, linuxRc);
  assert(receipt.verdict === 'PASS' && receipt.win.hypervisor === 'vmware-vnc' && receipt.linux.hypervisor === 'vbox-vnc', 'a witnessed WIN(VMware) vs LINUX(VBox) resource compare');
  for (const m of ['cpu', 'ram', 'disk']) assert(receipt.metrics[m].witness === true, `${m} is a witness (reported, never gated)`);
  assert(receipt.metrics.ram.status === 'agree', 'both hypervisors load ~the same resident RAM for a LabVIEW launch (cross-plane agreement)');
  const committed = fx('resource-cross-plane-receipt.json');
  assert(JSON.stringify(committed) === JSON.stringify(receipt), 'the committed resource cross-plane receipt matches a fresh recompute (no rot)');
  return { launchDeltaMs: receipt.launchDeltaMs, ramWin: receipt.metrics.ram.win.deltaMean, ramLinux: receipt.metrics.ram.linux.deltaMean, ramAgree: receipt.metrics.ram.agreementDelta };
});

// Authoring dependency manifest (LBA-REQ-017): the pinned external-dependency manifest for the LabVIEW-authoring
// + lvkit static self-test track (experiments/labview-authoring/) must validate through its dependency-free,
// OFFLINE, fail-closed verifier, and a malformed pin must fail closed. Subprocess-runs the verifier's own
// self-test. Authoring-namespaced + kept out of the benchmark/0.3.0 code+fixtures per the scope guard, but run
// by the one shared per-PR gate runner (so CI actually invokes verify-dep-manifest).
check('authoring-dep-manifest', () => {
  const manifest = JSON.parse(readFileSync(join(here, 'labview-authoring', 'dep-manifest.json'), 'utf8'));
  const r = verifyDepManifest(manifest);
  assert(r.ok, `the committed dep-manifest must validate: ${r.errors.join('; ')}`);
  assert(r.summary.gitRepos >= 2 && r.summary.pipTools >= 1 && r.summary.vipmPackages >= 1, 'the manifest carries the three pinned sections');
  const bad = JSON.parse(JSON.stringify(manifest)); bad.gitRepos[0].pin = 'bad pin!';
  assert(!verifyDepManifest(bad).ok, 'a malformed pin fails closed');
  execFileSync(process.execPath, [join(here, 'labview-authoring', 'verify-dep-manifest.selftest.mjs')], { stdio: 'pipe' });
  return { resolved: r.summary.resolved, tbd: r.summary.tbd, sections: `${r.summary.gitRepos} git / ${r.summary.pipTools} pip / ${r.summary.vipmPackages} vipm` };
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
// Canonical ephemeral mesh (experiments/ephemeral-mesh): the committed receipt attests one full "cattle"
// cycle -- golden snapshot -> linked clone -> boot -> lbabus loopback MESH OK -> DESTROY -- and the shared
// validator re-proves it here fails-closed (no VM needed at gate time). LBA-REQ-006 (clean teardown) +
// LBA-REQ-007 (comms-only), ADR-0003/0004.
check('ephemeral-mesh-receipt-green', () => {
  const receipt = readJson('experiments/ephemeral-mesh/receipt.json');
  const summary = validateEphemeralMeshReceipt(receipt);
  // Teeth: the validator rejects a receipt that claims reboot-survival, an undestroyed clone, or no MESH OK.
  let rejected = 0;
  for (const mutate of [
    (r) => { r.lifecycle.survivesReboot = true; },
    (r) => { r.lifecycle.destroyed = false; },
    (r) => { r.loopbackMesh.meshOk = false; },
  ]) {
    const bad = JSON.parse(JSON.stringify(receipt));
    mutate(bad);
    try { validateEphemeralMeshReceipt(bad); } catch { rejected += 1; }
  }
  assert(rejected === 3, 'validator must reject reboot-survival / undestroyed / mesh-not-ok receipts');
  return { plane: summary.plane, bootSeconds: summary.bootSeconds, meshOk: summary.meshOk, destroyed: summary.destroyed };
});
// Typed source->sink strict serialization (experiments/ephemeral-mesh, P2): the committed typed receipt attests
// a sink SERIALIZED 2 sources' streams into a dense ingestSeq log, closed by a terminal DONE per stream; the
// shared validator re-derives it fails-closed here (spec docs/proposals/mesh-node-types.md 4.3). LBA-REQ-006/007.
check('ephemeral-mesh-typed-receipt-green', () => {
  const receipt = readJson('experiments/ephemeral-mesh/receipt-typed.json');
  const summary = validateEphemeralMeshReceipt(receipt);
  assert(summary.meshMode === 'typed', 'meshMode must be typed');
  // Teeth: the validator rejects unordered mode, a source that listened, a missing terminal DONE, non-dense ingestSeq.
  let rejected = 0;
  for (const mutate of [
    (r) => { r.serializationMode = 'unordered'; },
    (r) => { r.nodes.find((n) => n.nodeType === 'source').activity.listened = true; },
    (r) => { const s = r.nodes.find((n) => n.nodeType === 'sink'); s.orderedReceipt.frameLog = s.orderedReceipt.frameLog.filter((f) => f.frameType !== 'DONE'); },
    (r) => { const s = r.nodes.find((n) => n.nodeType === 'sink'); s.orderedReceipt.frameLog[1].ingestSeq = 999; },
  ]) {
    const bad = JSON.parse(JSON.stringify(receipt));
    mutate(bad);
    try { validateEphemeralMeshReceipt(bad); } catch { rejected += 1; }
  }
  assert(rejected === 4, 'validator must reject unordered / source-listened / missing-DONE / non-dense typed receipts');
  return { meshMode: summary.meshMode, sources: summary.sources, sinks: summary.sinks, serializationMode: summary.serializationMode };
});
// Typed both<->both (experiments/ephemeral-mesh): 2 full peers, each SINKS its peer's seq'd stream into its own
// dense ingestSeq log. The shared validator re-derives BOTH per-node ordered logs fails-closed. LBA-REQ-006/007.
check('ephemeral-mesh-2node-receipt-green', () => {
  const receipt = readJson('experiments/ephemeral-mesh/receipt-2node.json');
  const summary = validateEphemeralMeshReceipt(receipt);
  assert(summary.meshMode === 'typed' && summary.boths === 2, 'both<->both typed with 2 both-nodes');
  // Teeth: a broken peer log (missing terminal DONE) or a type-not-honored both node is rejected.
  let rejected = 0;
  for (const mutate of [
    (r) => { const n = r.nodes[0]; n.orderedReceipt.frameLog = n.orderedReceipt.frameLog.filter((f) => f.frameType !== 'DONE'); },
    (r) => { r.nodes[1].activity.emittedCoordination = false; },
  ]) {
    const bad = JSON.parse(JSON.stringify(receipt));
    mutate(bad);
    try { validateEphemeralMeshReceipt(bad); } catch { rejected += 1; }
  }
  assert(rejected === 2, 'validator must reject missing-DONE / type-not-honored both<->both receipts');
  return { meshMode: summary.meshMode, boths: summary.boths };
});

// Provider-delegation harness (experiments/provider-delegation): AI providers on cleanrooms delegated uplift/
// doc tasks over the lbabus bus. Each verify is a dependency-free deterministic self-test (mock provider, no
// GPU / no network / no npm install); running them as subprocesses gates the whole harness under this
// authoritative suite -- the provider seam + the CLAIM/ACK/DONE dispatch + the worker pool + the objective
// coverage-lift gate (measured from raw V8 coverage, so it needs no c8).
check('provider-delegation-harness', () => {
  execFileSync(process.execPath, [join(here, 'provider-delegation', 'verify-provider-delegation.mjs')], { stdio: 'pipe' });
  return { suite: 'verify-provider-delegation 13/13 (task-spec + provider seam + acceptance gate + receipt)' };
});
check('provider-delegation-claim-tasking', () => {
  execFileSync(process.execPath, [join(here, 'provider-delegation', 'verify-claim-tasking.mjs')], { stdio: 'pipe' });
  return { suite: 'verify-claim-tasking 7/7 (CLAIM dispatch -> worker ACK -> DONE over bus-msg@1)' };
});
check('provider-delegation-worker-pool', () => {
  execFileSync(process.execPath, [join(here, 'provider-delegation', 'verify-worker-pool.mjs')], { stdio: 'pipe' });
  return { suite: 'verify-worker-pool 7/7 (M concurrent claims bounded to N, queued + drained, persistent)' };
});
check('provider-delegation-coverage-lift', () => {
  execFileSync(process.execPath, [join(here, 'provider-delegation', 'verify-coverage-lift.mjs')], { stdio: 'pipe' });
  return { suite: 'verify-coverage-lift 8/8 (provider-proposed test gated on measured V8 function coverage)' };
});
check('provider-delegation-risky-test', () => {
  execFileSync(process.execPath, [join(here, 'provider-delegation', 'verify-risky-test.mjs')], { stdio: 'pipe' });
  return { suite: 'verify-risky-test 9/9 (tool-gated: present+pass, absent->skip, present+fail)' };
});
check('provider-delegation-evidence', () => {
  execFileSync(process.execPath, [join(here, 'provider-delegation', 'verify-evidence.mjs')], { stdio: 'pipe' });
  return { suite: 'verify-evidence 8/8 (gather + validate receipts + grounded-summary gate)' };
});
check('provider-delegation-quality-gate', () => {
  execFileSync(process.execPath, [join(here, 'provider-delegation', 'verify-quality-gate.mjs')], { stdio: 'pipe' });
  return { suite: 'verify-quality-gate 14/14 (faithfulness pre-gate short-circuits weak drafts; reuses ollama-comparison scorer)' };
});
check('provider-delegation-registry', () => {
  execFileSync(process.execPath, [join(here, 'provider-delegation', 'verify-registry.mjs')], { stdio: 'pipe' });
  return { suite: 'verify-registry 9/9 (capability + liveness routing + load-balance across a multi-worker pool)' };
});
check('provider-delegation-vipm-gate', () => {
  execFileSync(process.execPath, [join(here, 'provider-delegation', 'verify-vipm-gate.mjs')], { stdio: 'pipe' });
  return { suite: 'verify-vipm-gate 36/36 (credential-from-file activate/login, redaction=no secret leak, Community-only-in-public-repo licensing)' };
});
check('provider-delegation-vipm-routing', () => {
  execFileSync(process.execPath, [join(here, 'provider-delegation', 'verify-vipm-routing.mjs')], { stdio: 'pipe' });
  return { suite: 'verify-vipm-routing 15/15 (VIPM-capability routing: edition-aware, Community-only-in-public-repo)' };
});

// DoD Gate (ISO/IEC/IEEE 29119-2 exit/completion criteria; 12207 process outcomes): the release-readiness
// Definition of Done is DEFINED, standards-grounded, and WIRED to an enforcing status context. This keeps the
// "DoD Gate / dod" contract from silently drifting or disappearing. Standards are referenced by identifier only
// (the licensed PDFs stay local, never committed). Dep-free static check.
check('dod-definition-present', () => {
  const doc = join(pkgRoot, 'docs', 'dod', 'definition-of-done.md');
  assert(existsSync(doc), 'the Definition of Done (docs/dod/definition-of-done.md) must exist');
  const text = readFileSync(doc, 'utf8');
  assert(/DoD Gate\s*\/\s*dod/.test(text), 'the DoD doc must carry the "DoD Gate / dod" context marker');
  for (const section of [/##\s*Standards basis/i, /##\s*Entry criteria/i, /##\s*Exit criteria/i]) {
    assert(section.test(text), `the DoD doc must define ${section}`);
  }
  // The exit criteria must trace to REAL, enforceable gates (objective, not aspirational).
  for (const gate of ['verify-local-gates', 'PR Coverage Gate / coverage', 'reqs-coverage']) {
    assert(text.includes(gate), `the DoD exit criteria must reference the enforcing gate "${gate}"`);
  }
  const wf = join(pkgRoot, '.github', 'workflows', 'dod.yml');
  assert(existsSync(wf), 'the DoD Gate workflow (.github/workflows/dod.yml) must exist');
  const wfText = readFileSync(wf, 'utf8');
  assert(/name:\s*DoD Gate/.test(wfText), 'workflow must publish the "DoD Gate / dod" context (name: DoD Gate + job dod)');
  assert(/job|dod:/.test(wfText) && /verify-local-gates\.mjs/.test(wfText), 'the DoD Gate job must enforce the DoD by running the local gate suite');
  return { doc: 'docs/dod/definition-of-done.md', context: 'DoD Gate / dod', exitCriteria: 7 };
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
