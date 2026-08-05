// Self-test for verify-release-procedure.mjs -- the ISO/IEC/IEEE 15289 release-procedure conformance gate
// (LBA-REQ-036). Proves (a) the COMMITTED procedure is conformant (every cited path resolves + every
// required invariant is named), and (b) the checker FAILS CLOSED -- a procedure that cites a missing file
// or drops a required invariant is rejected.
// Run: node verify-release-procedure.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildReleaseProcedureReport, buildReleaseRunbookReport, REQUIRED_INVARIANTS, PROCEDURE_REL, RUNBOOK_REL } from './verify-release-procedure.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// 1. the committed procedure is conformant: every cited path resolves + every invariant is named
{
  const r = buildReleaseProcedureReport({ repoRoot });
  assert.ok(r.ok, `expected the committed procedure to be conformant; findings: ${r.findings.join('; ')}`);
  assert.ok(r.filesChecked >= 6, `cites the real enforcement paths (${r.filesChecked})`);
  assert.equal(r.invariantsPresent, REQUIRED_INVARIANTS.length, 'names every required release invariant');
  ok(`committed procedure conformant: ${r.filesChecked} cited paths resolve, ${r.invariantsPresent} invariants named`);
}

// 2. fail-closed: a cited path that does not resolve is flagged
{
  const tmp = mkdtempSync(join(tmpdir(), 'lba-relproc-'));
  try {
    mkdirSync(join(tmp, 'docs', 'release'), { recursive: true });
    const good = readFileSync(join(repoRoot, PROCEDURE_REL), 'utf8');
    // point one cited workflow at a file that does not exist in the temp repo, keep invariants intact
    const broken = good.replace('.github/workflows/extension-release.yml', 'experiments/does-not-exist.mjs');
    writeFileSync(join(tmp, PROCEDURE_REL), broken);
    const r = buildReleaseProcedureReport({ repoRoot: tmp });
    assert.equal(r.ok, false, 'a procedure citing a missing file must FAIL closed');
    assert.ok(r.findings.some((f) => f.includes('does-not-exist')), 'flags the unresolved cited path');
    ok(`fail-closed on an unresolved cited path (${r.findings.length} findings)`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// 3. fail-closed: dropping a required invariant is flagged
{
  const tmp = mkdtempSync(join(tmpdir(), 'lba-relproc-'));
  try {
    mkdirSync(join(tmp, 'docs', 'release'), { recursive: true });
    const good = readFileSync(join(repoRoot, PROCEDURE_REL), 'utf8');
    const stripped = good.replace(/quorum/gi, 'threshold'); // remove the "quorum" invariant term
    writeFileSync(join(tmp, PROCEDURE_REL), stripped);
    const r = buildReleaseProcedureReport({ repoRoot: tmp });
    assert.equal(r.ok, false, 'a procedure missing a required invariant must FAIL closed');
    assert.ok(r.findings.some((f) => f.includes('quorum')), 'flags the missing invariant');
    ok(`fail-closed when a required invariant is dropped (${r.findings.length} findings)`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// 4. the committed runbook is conformant: every cited repo path resolves + it is linked from the procedure
{
  const r = buildReleaseRunbookReport({ repoRoot });
  assert.ok(r.ok, `expected the committed runbook to be conformant; findings: ${r.findings.join('; ')}`);
  assert.ok(r.filesChecked >= 6, `the runbook cites the real workflows/scripts/helpers (${r.filesChecked})`);
  assert.equal(r.linkedFromProcedure, true, 'the procedure links to the runbook');
  ok(`committed runbook conformant: ${r.filesChecked} cited paths resolve, linked from the procedure`);
}

// 5. fail-closed: a runbook that cites a missing file is flagged
{
  const tmp = mkdtempSync(join(tmpdir(), 'lba-relrun-'));
  try {
    mkdirSync(join(tmp, 'docs', 'release'), { recursive: true });
    writeFileSync(join(tmp, PROCEDURE_REL), readFileSync(join(repoRoot, PROCEDURE_REL), 'utf8')); // keeps the runbook link
    const good = readFileSync(join(repoRoot, RUNBOOK_REL), 'utf8');
    const broken = good.replace('scripts/normalize-vsix.mjs', 'scripts/does-not-exist.mjs');
    writeFileSync(join(tmp, RUNBOOK_REL), broken);
    const r = buildReleaseRunbookReport({ repoRoot: tmp });
    assert.equal(r.ok, false, 'a runbook citing a missing file must FAIL closed');
    assert.ok(r.findings.some((f) => f.includes('does-not-exist')), 'flags the unresolved cited path');
    ok(`fail-closed on an unresolved runbook path (${r.findings.length} findings)`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// 6. fail-closed: a procedure that does not link the runbook is flagged
{
  const tmp = mkdtempSync(join(tmpdir(), 'lba-relrun-'));
  try {
    mkdirSync(join(tmp, 'docs', 'release'), { recursive: true });
    const proc = readFileSync(join(repoRoot, PROCEDURE_REL), 'utf8').replace(/release-runbook\.md/g, 'release-elsewhere.md');
    writeFileSync(join(tmp, PROCEDURE_REL), proc);
    writeFileSync(join(tmp, RUNBOOK_REL), readFileSync(join(repoRoot, RUNBOOK_REL), 'utf8'));
    const r = buildReleaseRunbookReport({ repoRoot: tmp });
    assert.equal(r.ok, false, 'a procedure that does not link the runbook must FAIL closed');
    assert.ok(r.findings.some((f) => f.includes('must link')), 'flags the missing procedure->runbook link');
    ok(`fail-closed when the procedure does not link the runbook (${r.findings.length} findings)`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

console.log(`\nverify-release-procedure.selftest: ${passed}/${passed} checks passed`);