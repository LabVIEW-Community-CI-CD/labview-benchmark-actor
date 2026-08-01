#!/usr/bin/env node
// Correspondence-conformance engine — ISO/IEC/IEEE 42010:2022 correspondences + correspondence rules.
//
// 42010 gives us "correspondences and correspondence rules to express and enforce relations between AD
// elements ... dependencies and inconsistencies." This engine models the repo's assurance surface as a
// traceability graph (stakeholder -> concern -> view -> decision/ADR -> requirement -> test -> code) and
// enforces the correspondence RULES. Dependency-free (Node builtins only). Decision recorded in ADR-0013.
//
//   TR-1  [FAIL-CLOSED]  every governed test file corresponds to >=1 requirement via an RTM CodeRef.  (LBA-REQ-021)
//   AD-1  [FAIL-CLOSED]  every ADR traces to >=1 requirement AND is registered in the overview decision register.
//   VW-1  [FAIL-CLOSED]  every requirement is described in the architecture description (overview.md).
//   II-1  [FAIL-CLOSED]  every ISO/IEC/IEEE 15289 information item in docs/information-item-map.md resolves on disk.
//   II-2  [FAIL-CLOSED]  every core governed information item (SRS/RTM/test-plan/CM/architecture/matrix) is in that map.
//   PR-1  [FAIL-CLOSED]  every ISO/IEC/IEEE 12207 process outcome in the DoD is backed by a resolvable gate/artifact.
//
// Rules are fail-closed after their register is reconciled (ADR-0013 stage-2 for AD-1/VW-1; stage-4 15289 for II-1/II-2).
// A new rule may start advisory (enforced:false) so it reports a census without blocking, then be promoted by flipping
// once its register is reconciled.
//
// Usage: node experiments/reqs-coverage/verify-correspondences.mjs [--json]
// Exit 0 when every FAIL-CLOSED rule holds, 1 otherwise.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const asJson = process.argv.slice(2).includes('--json');

const SRS = join(repo, 'docs/requirements/srs.md');
const RTM = join(repo, 'docs/requirements/rtm.csv');
const OVERVIEW = join(repo, 'docs/architecture/overview.md');
const ADR_DIR = join(repo, 'docs/architecture/adr');

// Expand requirement references, including the slash form "LBA-REQ-004/005".
function expandReqRefs(text) {
  const set = new Set();
  for (const m of String(text).matchAll(/LBA-REQ-(\d+)((?:\/\d+)*)/g)) {
    set.add('LBA-REQ-' + m[1]);
    const width = m[1].length;
    for (const tail of (m[2].match(/\d+/g) || [])) set.add('LBA-REQ-' + tail.padStart(width, '0'));
  }
  return set;
}

// Governed requirement register = the `### LBA-REQ-NNN` SRS headings (same source as reqs-coverage ring-1).
const srsIds = [...new Set([...readFileSync(SRS, 'utf8').matchAll(/^###\s+(LBA-REQ-\d+)\b/gm)].map((m) => m[1]))].sort();

// test <-> requirement correspondence edges = the path tokens in the RTM CodeRef column.
const rtmText = readFileSync(RTM, 'utf8');
const referenced = new Set();
for (const m of rtmText.matchAll(/[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:mjs|cjs|ts|py|ps1|sh|json|md)/g)) {
  referenced.add(m[0]);
  referenced.add(m[0].split('/').pop());
}

// Enumerate governed test files by walking the known test roots (working-tree truth; dependency-free).
const TEST_ROOTS = ['test', 'experiments', 'playwright', 'tools'];
function walk(dir, acc) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (['node_modules', '.git', 'bin', 'obj'].includes(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    // Normalize to forward slashes so the matchers + basename extraction below work on Windows (backslash) too.
    else acc.push(relative(repo, full).split(sep).join('/'));
  }
  return acc;
}
const isGovernedTest = (p) =>
  /^test\/.*\.mjs$/.test(p) ||
  /^experiments\/.*\/verify-[^/]*\.mjs$/.test(p) ||
  /\.selftest\.mjs$/.test(p) ||
  /\.playwright\.(mjs|cjs)$/.test(p) ||
  /^playwright\/.*\.mjs$/.test(p) ||
  /^tools\/.*\/verify-[^/]*$/.test(p);
const governedTests = TEST_ROOTS.flatMap((r) => walk(join(repo, r), [])).filter(isGovernedTest).sort();
const isMapped = (p) => referenced.has(p) || referenced.has(p.split('/').pop());

// ADR <-> requirement + decision-register reconciliation: each ADR must trace to a requirement AND appear in
// the overview.md decision register (so the inline register and the ADR files cannot drift apart).
const overviewText = existsSync(OVERVIEW) ? readFileSync(OVERVIEW, 'utf8') : '';
const adrFiles = existsSync(ADR_DIR)
  ? readdirSync(ADR_DIR).filter((f) => /^ADR-\d{4}-.*\.md$/.test(f)).sort()
  : [];
const orphanAdrs = adrFiles.filter((f) => {
  const traced = expandReqRefs(readFileSync(join(ADR_DIR, f), 'utf8')).size > 0;
  const registered = overviewText.includes(f.slice(0, 8)); // e.g. "ADR-0001"
  return !(traced && registered);
});

// requirement <-> architecture-view correspondence (described anywhere in the architecture description).
const adReqs = expandReqRefs(overviewText);
const reqsNoView = srsIds.filter((id) => !adReqs.has(id));

// ISO/IEC/IEEE 15289 information items <-> files: the "Current Path" column of the information-item map lists
// each governed information item's committed path. II-1 = every registered item resolves on disk; II-2 = every
// core governed information item the graph relies on is registered in the map (so neither drifts from the other).
const INFO_ITEM_MAP = join(repo, 'docs/information-item-map.md');
const infoItemText = existsSync(INFO_ITEM_MAP) ? readFileSync(INFO_ITEM_MAP, 'utf8') : '';
const registeredItems = [];
for (const line of infoItemText.split(/\r?\n/)) {
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  const path = (cells[1] || '').match(/`([^`]+)`/); // the "Current Path" cell
  if (path) registeredItems.push(path[1]);
}
const unresolvedItems = registeredItems.filter((p) => !existsSync(join(repo, p)));
const CORE_INFO_ITEMS = [
  'docs/requirements/srs.md', 'docs/requirements/rtm.csv', 'docs/testing/test-plan.md',
  'docs/cm/cm-plan.md', 'docs/architecture/overview.md', 'docs/requirements/traceability-matrix.md',
];
const unregisteredItems = CORE_INFO_ITEMS.filter((p) => !registeredItems.includes(p));

// ISO/IEC/IEEE 12207 life-cycle process outcomes <-> enforcement: the DoD exit-criteria table declares each
// per-change process outcome and the gate/artifact that enforces it (the DoD states "our exit criteria are the
// per-change [12207] process outcomes"). PR-1 = every declared outcome is backed by >=1 resolvable enforcement
// (a verify-local-gates check() name, or an on-disk artifact path; `foo/**` globs resolve to their base dir).
const DOD = join(repo, 'docs/dod/definition-of-done.md');
const LOCAL_GATES = join(repo, 'experiments/verify-local-gates.mjs');
const checkNames = new Set([...(existsSync(LOCAL_GATES) ? readFileSync(LOCAL_GATES, 'utf8') : '').matchAll(/check\('([^']+)'/g)].map((m) => m[1]));
const enforcementResolves = (tok) => {
  if (checkNames.has(tok)) return true; // a verify-local-gates check
  const w = tok.replace(/^node\s+/, '').split(/\s+/).find((x) => /^[\w][\w./*-]*$/.test(x) && (x.includes('/') || /\.\w+$/.test(x)));
  return w ? existsSync(join(repo, w.replace(/\/\*+.*$/, ''))) : false; // an on-disk artifact (globs -> base dir)
};
const dodRows = [];
for (const line of (existsSync(DOD) ? readFileSync(DOD, 'utf8') : '').split(/\r?\n/)) {
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  if (cells.length >= 4 && /^\d+$/.test(cells[0])) dodRows.push(cells);
}
const unenforcedOutcomes = dodRows
  .filter((cells) => ![...cells[3].matchAll(/`([^`]+)`/g)].some((m) => enforcementResolves(m[1])))
  .map((cells) => `#${cells[0]} ${cells[1].replace(/\*\*/g, '').split('\u2014')[0].trim()}`);

const unmappedTests = governedTests.filter((p) => !isMapped(p));
const rules = [
  { id: 'TR-1', enforced: true, label: 'test<->requirement (every governed test corresponds to >=1 requirement)',
    total: governedTests.length, orphans: unmappedTests },
  { id: 'AD-1', enforced: true, label: 'ADR<->requirement + register (every ADR traces to a requirement and is registered in overview.md)',
    total: adrFiles.length, orphans: orphanAdrs },
  { id: 'VW-1', enforced: true, label: 'requirement<->architecture-view (every requirement described in overview.md)',
    total: srsIds.length, orphans: reqsNoView },
  { id: 'II-1', enforced: true, label: 'information-item<->file (every 15289 information item resolves on disk)',
    total: registeredItems.length, orphans: unresolvedItems },
  { id: 'II-2', enforced: true, label: 'information-item completeness (every core governed doc is registered in the 15289 map)',
    total: CORE_INFO_ITEMS.length, orphans: unregisteredItems },
  { id: 'PR-1', enforced: true, label: 'process-outcome<->enforcement (every DoD 12207 outcome has a resolvable gate/artifact)',
    total: dodRows.length, orphans: unenforcedOutcomes },
].map((r) => ({ ...r, ok: r.orphans.length === 0, satisfied: r.total - r.orphans.length }));

const enforcedFailures = rules.filter((r) => r.enforced && !r.ok);

if (asJson) {
  console.log(JSON.stringify({ requirements: srsIds.length, governedTests: governedTests.length, adrs: adrFiles.length, informationItems: registeredItems.length, processOutcomes: dodRows.length, rules }, null, 2));
} else {
  console.log(`correspondences: requirements=${srsIds.length} governed-tests=${governedTests.length} ADRs=${adrFiles.length} information-items=${registeredItems.length} dod-outcomes=${dodRows.length}`);
  for (const r of rules) {
    const tag = r.enforced ? (r.ok ? 'PASS' : 'FAIL') : (r.ok ? 'ADVISORY-OK' : 'ADVISORY');
    console.log(`  ${tag}  ${r.id}  ${r.label}  [${r.satisfied}/${r.total}]${r.enforced ? ' (fail-closed)' : ''}`);
    if (!r.ok) {
      console.log(`    - ${r.orphans.length} not corresponded: ${r.orphans.slice(0, 12).join(', ')}${r.orphans.length > 12 ? ' …' : ''}`);
      if (!r.enforced) console.log('      (advisory until its register is reconciled; then promoted to fail-closed)');
    }
  }
  console.log(enforcedFailures.length
    ? `correspondences: ${enforcedFailures.length} FAIL-CLOSED rule(s) broken — graph NOT conformant`
    : 'correspondences: all correspondence rules PASS (graph conformant)');
}
process.exit(enforcedFailures.length ? 1 : 0);
