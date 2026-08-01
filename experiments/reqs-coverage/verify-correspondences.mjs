#!/usr/bin/env node
// Correspondence-conformance engine — ISO/IEC/IEEE 42010:2022 correspondences + correspondence rules.
//
// 42010 gives us "correspondences and correspondence rules to express and enforce relations between AD
// elements ... dependencies and inconsistencies." This engine models the repo's assurance surface as a
// traceability graph (stakeholder -> concern -> view -> decision/ADR -> requirement -> test -> code) and
// enforces the correspondence RULES. Dependency-free (Node builtins only). Decision recorded in ADR-0013.
//
//   TR-1  [FAIL-CLOSED]  every governed test file corresponds to >=1 requirement via an RTM CodeRef.  (LBA-REQ-021)
//   AD-1  [ADVISORY]     every ADR file traces to >=1 requirement (ADR <-> requirement correspondence).
//   VW-1  [ADVISORY]     every requirement is described in the architecture description (overview.md).
//
// Advisory rules print a census (counts + exact orphans) but do NOT fail the gate until their registers are
// reconciled (ADR-0013 stage 2: unify the inline AD-n table with the ADR files; extend the views + decisions
// to cover REQ-011..020). Promote a rule to enforcement by setting its `enforced` flag true.
//
// Usage: node experiments/reqs-coverage/verify-correspondences.mjs [--json]
// Exit 0 when every FAIL-CLOSED rule holds, 1 otherwise.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

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
    else acc.push(relative(repo, full));
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

// ADR <-> requirement correspondence.
const adrFiles = existsSync(ADR_DIR)
  ? readdirSync(ADR_DIR).filter((f) => /^ADR-\d{4}-.*\.md$/.test(f)).sort()
  : [];
const orphanAdrs = adrFiles.filter((f) => expandReqRefs(readFileSync(join(ADR_DIR, f), 'utf8')).size === 0);

// requirement <-> architecture-view correspondence (described anywhere in the architecture description).
const adReqs = existsSync(OVERVIEW) ? expandReqRefs(readFileSync(OVERVIEW, 'utf8')) : new Set();
const reqsNoView = srsIds.filter((id) => !adReqs.has(id));

const unmappedTests = governedTests.filter((p) => !isMapped(p));
const rules = [
  { id: 'TR-1', enforced: true, label: 'test<->requirement (every governed test corresponds to >=1 requirement)',
    total: governedTests.length, orphans: unmappedTests },
  { id: 'AD-1', enforced: false, label: 'ADR<->requirement (every ADR traces to >=1 requirement)',
    total: adrFiles.length, orphans: orphanAdrs },
  { id: 'VW-1', enforced: false, label: 'requirement<->architecture-view (every requirement described in overview.md)',
    total: srsIds.length, orphans: reqsNoView },
].map((r) => ({ ...r, ok: r.orphans.length === 0, satisfied: r.total - r.orphans.length }));

const enforcedFailures = rules.filter((r) => r.enforced && !r.ok);

if (asJson) {
  console.log(JSON.stringify({ requirements: srsIds.length, governedTests: governedTests.length, adrs: adrFiles.length, rules }, null, 2));
} else {
  console.log(`correspondences: requirements=${srsIds.length} governed-tests=${governedTests.length} ADRs=${adrFiles.length}`);
  for (const r of rules) {
    const tag = r.enforced ? (r.ok ? 'PASS' : 'FAIL') : (r.ok ? 'ADVISORY-OK' : 'ADVISORY');
    console.log(`  ${tag}  ${r.id}  ${r.label}  [${r.satisfied}/${r.total}]${r.enforced ? ' (fail-closed)' : ''}`);
    if (!r.ok) {
      console.log(`    - ${r.orphans.length} not corresponded: ${r.orphans.slice(0, 12).join(', ')}${r.orphans.length > 12 ? ' …' : ''}`);
      if (!r.enforced) console.log('      (advisory until ADR-0013 stage-2 reconciliation; then promoted to fail-closed)');
    }
  }
  console.log(enforcedFailures.length
    ? `correspondences: ${enforcedFailures.length} FAIL-CLOSED rule(s) broken — graph NOT conformant`
    : 'correspondences: fail-closed rules PASS (advisory census pending ADR-0013 reconciliation)');
}
process.exit(enforcedFailures.length ? 1 : 0);
