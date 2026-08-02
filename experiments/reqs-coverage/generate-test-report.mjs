#!/usr/bin/env node
// Test & assurance report GENERATOR (LBA-REQ-035): the ISO/IEC/IEEE 29119-3 *test report* (executed
// verification evidence + completion criteria) and the ISO 10007 / ISO/IEC/IEEE 12207 *configuration
// status accounting* record are GENERATED from the canonical sources rather than hand-maintained.
// Dependency-free. Deterministic — no timestamps, no git HEAD — so `--check` is a stable drift gate.
//
// The repo already keeps a test *plan* (docs/testing/test-plan.md, the design of what to test). 29119-3
// separately expects a test *report* (what was executed and its outcome) and ISO 10007 expects a status
// accounting record (the controlled state of configuration items). Both were absent as governed
// information items; this generator produces them from the apparatus that CI actually enforces.
//
// Sources (all committed, all machine-read):
//   - experiments/verify-local-gates.mjs            -- the fail-closed gate inventory (check('<id>', ...))
//   - experiments/reqs-coverage/verify-correspondences.mjs -- the correspondence rules ({ id, enforced, label })
//   - coverage-thresholds.json                      -- the coverage floors the PR Coverage Gate enforces
//   - docs/requirements/rtm.csv                     -- requirements + their Status (accounting)
//   - docs/testing/test-plan.md                     -- the governed test items (T-NNN)
//   - docs/architecture/adr/                        -- the architecture decisions (configuration items)
// Output: docs/testing/test-report.md
//
// Usage:
//   node experiments/reqs-coverage/generate-test-report.mjs           -- (re)write the report
//   node experiments/reqs-coverage/generate-test-report.mjs --check   -- exit 1 if the committed report is stale
// The `test-report-current` gate in verify-local-gates runs --check so the derived report cannot drift.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const OUT_REL = 'docs/testing/test-report.md';

// ---- minimal quoted-CSV parser (matches verify-reqs-coverage / generate-traceability) -----------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { inQ = false; } }
      else { field += c; }
    } else if (c === '"') { inQ = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') { field += c; }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function csvRecords(text) {
  const rows = parseCsv(text).filter((r) => r.length > 1 && r.some((x) => x.trim()));
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// ---- render the report deterministically from the committed sources under `repoRoot` -------------
export function renderReport({ repoRoot }) {
  const GATES = join(repoRoot, 'experiments/verify-local-gates.mjs');
  const CORR = join(repoRoot, 'experiments/reqs-coverage/verify-correspondences.mjs');
  const COVERAGE = join(repoRoot, 'coverage-thresholds.json');
  const RTM = join(repoRoot, 'docs/requirements/rtm.csv');
  const TEST_PLAN = join(repoRoot, 'docs/testing/test-plan.md');
  const ADR_DIR = join(repoRoot, 'docs/architecture/adr');

  // The fail-closed gate inventory: every top-level check('<id>', ...) in the local gate suite.
  const gateIds = [...readFileSync(GATES, 'utf8').matchAll(/^check\('([^']+)'/gm)].map((m) => m[1]).sort();

  // The correspondence rules: { id: 'TR-1', enforced: true, label: '...' } entries in the register.
  const rules = [...readFileSync(CORR, 'utf8').matchAll(/\{\s*id:\s*'([A-Z]+-\d+)',\s*enforced:\s*(true|false),\s*label:\s*'([^']+)'/g)]
    .map((m) => ({ id: m[1], enforced: m[2] === 'true', label: m[3] }));

  // The coverage floors the PR Coverage Gate enforces (c8 fail-under).
  const floor = JSON.parse(readFileSync(COVERAGE, 'utf8')).floor;

  // Requirements by Status (configuration status accounting).
  const reqs = csvRecords(readFileSync(RTM, 'utf8')).filter((r) => /^LBA-REQ-\d+$/.test(r.ReqID || ''));
  const byStatus = new Map();
  for (const r of reqs) byStatus.set(r.Status || '—', (byStatus.get(r.Status || '—') || 0) + 1);
  const statusRows = [...byStatus.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Governed test items (T-NNN) declared in the test plan.
  const testItems = [...new Set([...readFileSync(TEST_PLAN, 'utf8').matchAll(/^\|\s*(T-\d+)\b/gm)].map((m) => m[1]))].sort();

  // Architecture decisions on disk (ISO 10007 configuration items).
  const adrCount = readdirSync(ADR_DIR).filter((f) => /^ADR-\d{4}.*\.md$/.test(f)).length;

  const lines = [
  '# Test & assurance report — labview-benchmark-actor',
  '',
  '> GENERATED from the canonical sources (gate suite + correspondence graph + coverage floors + RTM +',
  '> test plan + ADR register) by `experiments/reqs-coverage/generate-test-report.mjs`. Do NOT edit by',
  '> hand — run the generator and commit. The `test-report-current` gate fails closed if this file drifts.',
  '>',
  '> This is the ISO/IEC/IEEE 29119-3 **test report** (executed verification evidence and completion',
  '> criteria) and the ISO 10007 / ISO/IEC/IEEE 12207 **configuration status accounting** record for the',
  '> repository. It records the controlled state of the verification apparatus, not one ad-hoc run: every',
  '> item below is enforced fail-closed in CI on every pull request, so "current" means "as enforced on',
  '> the tip of `develop`". The complementary test **plan** (design of what to test) is',
  '> `docs/testing/test-plan.md`.',
  '',
  '## 1. Completion criteria (ISO/IEC/IEEE 29119-2)',
  '',
  'Testing is **complete** for a change when **every governed gate passes fail-closed** in CI on both',
  '`ubuntu-latest` and `windows-latest`. A single red gate blocks merge; there is no manual sign-off path',
  'that can override a red gate. The completion criteria are therefore machine-checked and',
  'non-discretionary — the same apparatus runs locally (`node experiments/verify-local-gates.mjs`) and in',
  'the `LBA Local Gates verify` CI job.',
  '',
  '## 2. Executed verification evidence (ISO/IEC/IEEE 29119-3)',
  '',
  `### 2.1 Local gate suite — ${gateIds.length} fail-closed checks`,
  '',
  'Run by `node experiments/verify-local-gates.mjs`. All must pass. The full gate inventory (the executed',
  'test items at the gate granularity) is:',
  '',
  '```',
  ...gateIds,
  '```',
  '',
  `### 2.2 Correspondence graph — ${rules.length} fail-closed rules`,
  '',
  'Run by `node experiments/reqs-coverage/verify-correspondences.mjs` (also invoked as gates). Each rule',
  'is a structural invariant across the governed information items:',
  '',
  '| Rule | Enforced | Invariant |',
  '| --- | --- | --- |',
  ...rules.map((r) => `| ${r.id} | ${r.enforced ? 'yes' : 'no'} | ${r.label} |`),
  '',
  '### 2.3 Coverage gate',
  '',
  `The PR Coverage Gate (c8 \`--check-coverage\`) fails under these floors: lines ${floor.lines}%,`,
  `statements ${floor.statements}%, functions ${floor.functions}%, branches ${floor.branches}%. Floors`,
  'ratchet up only (`npm run coverage:bump`); they are never lowered by hand.',
  '',
  '### 2.4 Extension test suites',
  '',
  'The Mocha extension activation + view-render suites run in the `extension tests` CI jobs on',
  '`ubuntu-latest` and `windows-latest`.',
  '',
  '## 3. Configuration status accounting (ISO 10007 / ISO/IEC/IEEE 12207)',
  '',
  'The controlled state of the repository\'s configuration items, derived from the registers:',
  '',
  '| Configuration item class | Count | Register |',
  '| --- | --- | --- |',
  `| Requirements (total) | ${reqs.length} | docs/requirements/srs.md, rtm.csv |`,
  ...statusRows.map(([s, n]) => `| — Status: ${s} | ${n} | rtm.csv |`),
  `| Architecture decisions (ADRs) | ${adrCount} | docs/architecture/adr/README.md |`,
  `| Governed gates | ${gateIds.length} | experiments/verify-local-gates.mjs |`,
  `| Correspondence rules | ${rules.length} | experiments/reqs-coverage/verify-correspondences.mjs |`,
  `| Governed test items | ${testItems.length} | docs/testing/test-plan.md |`,
  '',
  'Baselines are cut on the `main` branch via SemVer tags (GitFlow); each release is keyless-signed and',
  'corroborated across planes before publication (see `docs/cm/cm-plan.md` and the release procedure).',
  '',
  '## 4. Traceability',
  '',
  'Every requirement\'s requirement ↔ view ↔ decision ↔ test ↔ code linkage is in the generated',
  'traceability matrix (`docs/requirements/traceability-matrix.md`), itself gated by',
  '`traceability-matrix-current`. This report and that matrix are the two generated, drift-gated views of',
  'the same correspondence graph (ADR-0013).',
  '',
  '## 5. Regeneration',
  '',
  '`node experiments/reqs-coverage/generate-test-report.mjs` rewrites this file; `--check` (the',
  '`test-report-current` gate) fails closed on drift, so the report can never silently lag the apparatus.',
  '',
  `_Generated from ${gateIds.length} gates, ${rules.length} correspondence rules, ${reqs.length} requirements, ${adrCount} ADRs, ${testItems.length} test items._`,
  ];
  return { text: lines.join('\n') + '\n', gates: gateIds.length, rules: rules.length, requirements: reqs.length, adrs: adrCount, testItems: testItems.length };
}

// ---- CLI (write or --check) — only when invoked directly, not when imported by the selftest -------
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const checkOnly = process.argv.slice(2).includes('--check');
  const OUT = join(repo, OUT_REL);
  const { text, gates, rules, requirements } = renderReport({ repoRoot: repo });
  if (checkOnly) {
    // Line-ending-agnostic compare: git may check the committed report out with CRLF on Windows while the
    // generator always renders LF, so a raw byte compare would false-fail the gate on windows-latest.
    const committed = (existsSync(OUT) ? readFileSync(OUT, 'utf8') : '').replace(/\r\n/g, '\n');
    if (committed !== text) {
      console.error(`test-report: STALE — ${OUT_REL} is out of date with the verification apparatus.`);
      console.error('  Run: node experiments/reqs-coverage/generate-test-report.mjs');
      process.exit(1);
    }
    console.log(`test-report: current (${gates} gates, ${rules} rules, ${requirements} requirements)`);
  } else {
    writeFileSync(OUT, text);
    console.log(`test-report: wrote ${OUT_REL} (${gates} gates, ${rules} rules, ${requirements} requirements)`);
  }
}
