#!/usr/bin/env node
// Spec <-> implementation requirements-coverage check (ring 1 + ring 2) — quoted-CSV-aware, dep-free.
//
// Turns "keep the RTM matrix honest" from a norm into an ENFORCED, fail-closed invariant. Local-first
// (run by an agent / pre-commit); promote to a hosted ci-reqs stage mirroring ci-agents/ci-docs later.
//
//   ring 1  orphan/coverage (SRS <-> RTM both directions): every LBA-REQ defined in docs/requirements/
//           srs.md appears in >=1 RTM row, AND every RTM ReqID resolves to a real SRS requirement.
//   ring 2  Proven-cannot-lie: every RTM row with Status=Proven has a CodeRef that resolves on disk and
//           a TestID defined in docs/testing/test-plan.md.
//
// Distilled from the vi-history-suite traceability suite (requirements:integrity / referenceAgreement).
// Later rings (see AGENTS.md "Spec <-> implementation gap closure"): in-test linkage, criterion-level
// citation (LBA-REQ-NNN.M), ADR<->req linkage, a file inventory, a test->code coverage map.
//
// Usage: node experiments/reqs-coverage/verify-reqs-coverage.mjs [--json]
// Exit 0 when the matrix is honest, 1 otherwise.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const asJson = process.argv.slice(2).includes('--json');

const SRS = join(repo, 'docs/requirements/srs.md');
const RTM = join(repo, 'docs/requirements/rtm.csv');
const TESTPLAN = join(repo, 'docs/testing/test-plan.md');

// ---- minimal RFC-4180-ish CSV parser (quotes + embedded commas + "" escapes) --------------------
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

// ---- gather -------------------------------------------------------------------------------------
const srsIds = [...new Set([...readFileSync(SRS, 'utf8').matchAll(/^###\s+(LBA-REQ-\d+)\b/gm)].map((m) => m[1]))];
const rtm = csvRecords(readFileSync(RTM, 'utf8')).filter((r) => /^LBA-REQ-\d+$/.test(r.ReqID || ''));
const rtmIds = rtm.map((r) => r.ReqID);
const testPlan = existsSync(TESTPLAN) ? readFileSync(TESTPLAN, 'utf8') : '';
const proven = rtm.filter((r) => (r.Status || '') === 'Proven');

const problems = [];
const fail = (ring, msg) => problems.push({ ring, msg });

// ---- ring 1: orphan/coverage both directions ----------------------------------------------------
for (const id of srsIds) if (!rtmIds.includes(id)) fail(1, `SRS ${id} has no RTM row (unmapped requirement)`);
for (const r of rtm) if (!srsIds.includes(r.ReqID)) fail(1, `RTM ${r.ReqID} has no SRS definition (orphan RTM row)`);

// ---- ring 2: Proven cannot lie ------------------------------------------------------------------
for (const r of proven) {
  const paths = (r.CodeRef || '').split(/[;,]/).map((s) => s.trim().replace(/[.;,]+$/, ''))
    .filter((s) => /^[\w][\w./-]*$/.test(s) && (s.includes('/') || /\.\w+$/.test(s)));
  for (const p of paths) {
    if (!existsSync(join(repo, p))) fail(2, `${r.ReqID} [Proven] CodeRef path does not resolve: ${p}`);
  }
  if (r.TestID && !testPlan.includes(r.TestID)) fail(2, `${r.ReqID} [Proven] TestID ${r.TestID} not defined in test-plan.md`);
}

// ---- report -------------------------------------------------------------------------------------
const ring = (n) => problems.filter((p) => p.ring === n);
if (asJson) {
  console.log(JSON.stringify({ srs: srsIds.length, rtm: rtm.length, proven: proven.length, problems }, null, 2));
} else {
  console.log(`reqs-coverage: SRS=${srsIds.length} reqs, RTM=${rtm.length} rows, Proven=${proven.length}`);
  for (const [n, label] of [[1, 'ring-1 orphan/coverage (SRS <-> RTM)'], [2, 'ring-2 Proven-cannot-lie']]) {
    console.log(`  ${ring(n).length ? 'FAIL' : 'PASS'}  ${label}`);
    for (const p of ring(n)) console.log(`    - ${p.msg}`);
  }
  console.log(problems.length ? `reqs-coverage: ${problems.length} problem(s) — matrix NOT honest` : 'reqs-coverage: matrix honest (all rings pass)');
}
process.exit(problems.length ? 1 : 0);
