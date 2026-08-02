#!/usr/bin/env node
// Traceability-matrix GENERATOR (ADR-0013 correspondence graph, Stage 3): the requirement <-> view <-> decision
// <-> test <-> code matrix is GENERATED from the canonical sources rather than hand-maintained. Dependency-free.
//
// Sources (the graph nodes/edges):
//   - docs/requirements/srs.md            -- requirement ids + titles (### LBA-REQ-NNN: <title>)
//   - docs/requirements/rtm.csv           -- status, TestID, and CodeRef count per requirement
//   - docs/architecture/overview.md       -- the architecture view addressing each requirement (### N.M ... addresses ...)
//   - docs/architecture/adr/ADR-*.md      -- the decisions (ADRs) that relate to each requirement
// Output: docs/requirements/traceability-matrix.md (one row per requirement).
//
// Usage:
//   node experiments/reqs-coverage/generate-traceability.mjs           -- (re)write the matrix
//   node experiments/reqs-coverage/generate-traceability.mjs --check   -- exit 1 if the committed matrix is stale
// The `traceability-matrix-current` gate in verify-local-gates runs --check so the derived view cannot drift.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const checkOnly = process.argv.slice(2).includes('--check');

const SRS = join(repo, 'docs/requirements/srs.md');
const RTM = join(repo, 'docs/requirements/rtm.csv');
const OVERVIEW = join(repo, 'docs/architecture/overview.md');
const ADR_DIR = join(repo, 'docs/architecture/adr');
const OUT = join(repo, 'docs/requirements/traceability-matrix.md');
const OUT_REL = 'docs/requirements/traceability-matrix.md';

// ---- minimal quoted-CSV parser (matches verify-reqs-coverage) -----------------------------------
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

// ---- gather the graph ---------------------------------------------------------------------------
// requirement id -> title
const reqTitle = new Map();
for (const m of readFileSync(SRS, 'utf8').matchAll(/^###\s+(LBA-REQ-\d+):\s*(.+?)\s*$/gm)) reqTitle.set(m[1], m[2]);
const reqIds = [...reqTitle.keys()].sort();

// requirement -> { status, testId, codeRefCount } from the RTM
const rtm = new Map();
for (const r of csvRecords(readFileSync(RTM, 'utf8'))) {
  if (!/^LBA-REQ-\d+$/.test(r.ReqID || '')) continue;
  const codeRefCount = (r.CodeRef || '').split(';').map((s) => s.trim()).filter(Boolean).length;
  rtm.set(r.ReqID, { status: r.Status || '', testId: r.TestID || '', codeRefCount });
}

// requirement -> architecture view label, from "### N.M <name> — addresses LBA-REQ-..." (em dash or hyphen)
const overviewText = readFileSync(OVERVIEW, 'utf8');
const reqView = new Map();
for (const m of overviewText.matchAll(/^###\s+(\d+\.\d+)\s+(.+?)\s+[\u2014-]+\s+addresses\s+(.+?)\s*$/gm)) {
  const label = `\u00a7${m[1]} ${m[2].replace(/\s+view$/i, '')}`;
  for (const rm of m[3].matchAll(/LBA-REQ-\d+/g)) if (!reqView.has(rm[0])) reqView.set(rm[0], label);
}

// requirement -> [ADR ids] from the AUTHORITATIVE decision register: the ADR index README "Traces to" column
// (the last cell of each `| [ADR-NNNN](...) | title | owner | status | LBA-REQ-... |` row). Body mentions are
// NOT used, so an incidental cross-reference never fabricates a decision->requirement edge.
const reqAdrs = new Map();
for (const line of readFileSync(join(ADR_DIR, 'README.md'), 'utf8').split(/\r?\n/)) {
  const idMatch = line.match(/^\|\s*\[(ADR-\d{4})\]/);
  if (!idMatch) continue;
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  const tracesTo = cells[cells.length - 1] || '';
  for (const req of new Set([...tracesTo.matchAll(/LBA-REQ-\d+/g)].map((x) => x[0]))) {
    if (!reqAdrs.has(req)) reqAdrs.set(req, []);
    reqAdrs.get(req).push(idMatch[1]);
  }
}

// ---- render the matrix (deterministic) ----------------------------------------------------------
const lines = [
  '# Traceability matrix — labview-benchmark-actor',
  '',
  '> GENERATED from the canonical sources (SRS + RTM + architecture description + ADRs) by',
  '> `experiments/reqs-coverage/generate-traceability.mjs` (ADR-0013 correspondence graph, Stage 3).',
  '> Do NOT edit by hand — run the generator and commit. The `traceability-matrix-current` gate fails',
  '> closed if this file drifts from the sources.',
  '',
  '| Requirement | Title | Status | Architecture view | Decisions | Test | Code refs |',
  '| --- | --- | --- | --- | --- | --- | --- |',
];
for (const id of reqIds) {
  const r = rtm.get(id) || {};
  const view = reqView.get(id) || '—';
  const adrs = (reqAdrs.get(id) || []).sort().join(', ') || '—';
  lines.push(`| ${id} | ${reqTitle.get(id)} | ${r.status || '—'} | ${view} | ${adrs} | ${r.testId || '—'} | ${r.codeRefCount ?? 0} |`);
}
lines.push('');
lines.push(`_Generated for ${reqIds.length} requirements._`);
const rendered = lines.join('\n') + '\n';

// ---- write or check -----------------------------------------------------------------------------
if (checkOnly) {
  // Compare line-ending-agnostic: git may check the committed matrix out with CRLF on Windows while the
  // generator always renders LF, so a raw byte compare would false-fail the gate on windows-latest.
  const committed = (existsSync(OUT) ? readFileSync(OUT, 'utf8') : '').replace(/\r\n/g, '\n');
  if (committed !== rendered) {
    console.error(`traceability-matrix: STALE — ${OUT_REL} is out of date with the sources.`);
    console.error('  Run: node experiments/reqs-coverage/generate-traceability.mjs');
    process.exit(1);
  }
  console.log(`traceability-matrix: current (${reqIds.length} requirements)`);
} else {
  writeFileSync(OUT, rendered);
  console.log(`traceability-matrix: wrote ${OUT_REL} (${reqIds.length} requirements)`);
}
