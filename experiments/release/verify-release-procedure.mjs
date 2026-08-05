#!/usr/bin/env node
// Release-procedure conformance checker (LBA-REQ-036): the ISO/IEC/IEEE 15289 release *procedure*
// (docs/release/release-procedure.md) is the step-by-step execution of the ISO/IEC/IEEE 12207 / ISO 10007
// release process. A procedure rots when it cites workflows, scripts, or gates that have been renamed or
// removed. This checker keeps the procedure honest, fail-closed:
//   (a) every repo path the procedure cites in backticks resolves on disk, and
//   (b) the procedure names the required release invariants (SemVer tag on main, bidirectional agreement,
//       keyless signing, transparency-log inclusion, verify-before-install).
// Dependency-free. `buildReleaseProcedureReport({ repoRoot })` is exported for the selftest.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const PROCEDURE_REL = 'docs/release/release-procedure.md';
export const RUNBOOK_REL = 'docs/release/release-runbook.md';

// A backtick token is a "cited repo path" iff it starts with one of these real prefixes (or is package.json).
const PATH_PREFIXES = ['.github/workflows/', '.github/actions/', 'experiments/', 'reviewer-workstation/', 'docs/'];
// The concrete runbook also cites scripts/ and tools/ helpers, so its checker admits those prefixes too.
const RUNBOOK_PATH_PREFIXES = [...PATH_PREFIXES, 'scripts/', 'tools/'];
// Required release invariants — each phrase (lowercased) must appear at least once in the procedure.
export const REQUIRED_INVARIANTS = [
  'semver', 'main', 'quorum', 'keyless', 'rekor', 'transparency log',
  'verify-release-inclusion', 'inclusion proof', 'agreement', '--no-ff',
];

export function buildReleaseProcedureReport({ repoRoot }) {
  const path = join(repoRoot, PROCEDURE_REL);
  const findings = [];
  if (!existsSync(path)) {
    return { ok: false, findings: [`${PROCEDURE_REL} is missing`], filesChecked: 0, invariantsPresent: 0 };
  }
  const text = readFileSync(path, 'utf8');
  const lower = text.toLowerCase();

  // (a) every cited repo path resolves on disk
  const cited = new Set();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    let tok = m[1].trim().replace(/^\.\//, ''); // strip a leading ./ (composite-action refs)
    const isPath = tok === 'package.json' || PATH_PREFIXES.some((p) => tok.startsWith(p));
    if (!isPath) continue;
    if (/[*\s]/.test(tok) || tok.includes('X.Y.Z')) continue; // skip globs / version placeholders
    cited.add(tok);
  }
  for (const tok of [...cited].sort()) {
    if (!existsSync(join(repoRoot, tok))) findings.push(`cited path does not resolve: ${tok}`);
  }
  if (cited.size < 6) findings.push(`too few cited enforcement paths (${cited.size}); the procedure must name its real workflows/scripts`);

  // (b) every required release invariant is named
  let invariantsPresent = 0;
  for (const inv of REQUIRED_INVARIANTS) {
    if (lower.includes(inv)) invariantsPresent += 1;
    else findings.push(`missing required release invariant: "${inv}"`);
  }

  return { ok: findings.length === 0, findings, filesChecked: cited.size, invariantsPresent };
}

/**
 * Runbook conformance (issue #420): the concrete, agent-executable runbook
 * (docs/release/release-runbook.md) must stay honest — every repo path it cites in backticks resolves on disk —
 * AND it must be linked from the procedure (so the normative "what" points at the concrete "how"). Ephemeral
 * ~/lba-vm-share/ artifacts and version-placeholder tokens are not repo paths and are skipped.
 */
export function buildReleaseRunbookReport({ repoRoot }) {
  const path = join(repoRoot, RUNBOOK_REL);
  const findings = [];
  if (!existsSync(path)) {
    return { ok: false, findings: [`${RUNBOOK_REL} is missing`], filesChecked: 0, linkedFromProcedure: false };
  }
  const text = readFileSync(path, 'utf8');

  const cited = new Set();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const tok = m[1].trim().replace(/^\.\//, '');
    const isPath = tok === 'package.json' || RUNBOOK_PATH_PREFIXES.some((p) => tok.startsWith(p));
    if (!isPath) continue;
    if (/[*\s]/.test(tok) || tok.includes('X.Y.Z')) continue; // skip globs / version placeholders
    cited.add(tok);
  }
  for (const tok of [...cited].sort()) {
    if (!existsSync(join(repoRoot, tok))) findings.push(`runbook cites a path that does not resolve: ${tok}`);
  }
  if (cited.size < 6) findings.push(`too few cited paths in the runbook (${cited.size}); it must name the real workflows/scripts/helpers`);

  // The procedure must link to the runbook so the two stay connected.
  const procPath = join(repoRoot, PROCEDURE_REL);
  const linkedFromProcedure = existsSync(procPath) && readFileSync(procPath, 'utf8').includes('release-runbook.md');
  if (!linkedFromProcedure) findings.push(`${PROCEDURE_REL} must link to ${RUNBOOK_REL}`);

  return { ok: findings.length === 0, findings, filesChecked: cited.size, linkedFromProcedure };
}

// ---- CLI ----------------------------------------------------------------------------------------
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const r = buildReleaseProcedureReport({ repoRoot });
  const rb = buildReleaseRunbookReport({ repoRoot });
  if (!r.ok || !rb.ok) {
    if (!r.ok) {
      console.error(`release-procedure: NON-CONFORMANT (${r.findings.length} findings):`);
      for (const f of r.findings) console.error(`  - ${f}`);
    }
    if (!rb.ok) {
      console.error(`release-runbook: NON-CONFORMANT (${rb.findings.length} findings):`);
      for (const f of rb.findings) console.error(`  - ${f}`);
    }
    process.exit(1);
  }
  console.log(`release-procedure: conformant (${r.filesChecked} cited paths resolve, ${r.invariantsPresent}/${REQUIRED_INVARIANTS.length} invariants named)`);
  console.log(`release-runbook: conformant (${rb.filesChecked} cited paths resolve, linked from the procedure)`);
}
