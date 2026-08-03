#!/usr/bin/env node
// Self-test for cross-plane VI Analyzer performance parity (LBA-REQ-081 / ADR-0062). Pure + offline: proves the
// committed parity receipt re-derives from the two committed vi-analyzer-trend-live-evidence@1 captures and is
// parity-proven, and that every fail-closed guard fires (identity mismatch, non-cross-plane, differing resultHash,
// invalid trend, tampered digest). Gated by `cross-plane-vi-analyzer-parity`.
// Run: `node experiments/vi-analyzer/viAnalyzerParity.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildReceipt, validateReceipt, committedContext, RECEIPT_SCHEMA, REQUIREMENT } from './viAnalyzerParity.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const baseCtx = committedContext(here);
const committed = JSON.parse(readFileSync(join(here, 'cross-plane-vi-analyzer-parity-receipt.json'), 'utf8'));
const ctx = () => JSON.parse(JSON.stringify(baseCtx));

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. the committed parity receipt validates + is parity-proven.
ok('committed VI Analyzer parity receipt validates + is proven', () => {
  const r = validateReceipt(committed, baseCtx);
  assert.equal(r.ok, true, `committed should validate: ${r.findings.join('; ')}`);
  assert.equal(r.proofOk, true, 'committed run should be parity-proven');
  assert.equal(committed.schema, RECEIPT_SCHEMA);
  assert.equal(committed.requirement, REQUIREMENT);
});

// 2. it re-derives byte-for-byte from the two committed evidence captures (currency) + is grounded (same
//    benchmark identity + a shared deterministic resultHash across planes).
ok('re-derives from the committed evidence + is grounded', () => {
  const rebuilt = buildReceipt(baseCtx);
  assert.equal(JSON.stringify(rebuilt), JSON.stringify(committed), 'receipt is stale vs the evidence');
  assert.equal(committed.parity.identityMatch, true, 'the planes ran the same VI Analyzer benchmark identity');
  assert.equal(committed.parity.resultHashMatch, true, 'the planes produced the same deterministic resultHash');
  assert.equal(committed.planes.LINUX.identity, committed.planes.WIN.identity, 'both plane summaries carry the same identity');
});

// 3. FAIL-CLOSED: an identity mismatch (one plane ran a different sample count) -> not the same benchmark.
ok('rejects an identity mismatch', () => {
  const c = ctx(); c.winEvidence.runs = c.winEvidence.runs.slice(0, 5); // n=5 on WIN, 6 on LINUX
  const receipt = buildReceipt(c);
  assert.equal(receipt.parity.identityMatch, false);
  assert.equal(receipt.verdict.parityProven, false);
});

// 4. FAIL-CLOSED: not a cross-plane pair (both planes report LINUX).
ok('rejects a non-cross-plane pair', () => {
  const c = ctx(); c.winEvidence.cleanroom.plane = 'LINUX';
  const receipt = buildReceipt(c);
  assert.equal(receipt.parity.crossPlane, false);
  assert.equal(receipt.verdict.parityProven, false);
});

// 5. FAIL-CLOSED: the planes produced DIFFERENT VI Analyzer resultHashes (not the same deterministic analysis).
ok('rejects a differing cross-plane resultHash', () => {
  const c = ctx(); c.winEvidence.determinism.resultHash = 'f'.repeat(64);
  const receipt = buildReceipt(c);
  assert.equal(receipt.parity.resultHashMatch, false);
  assert.equal(receipt.verdict.parityProven, false);
});

// 6. FAIL-CLOSED: an invalid trend (a plane returned no runs).
ok('rejects an invalid (empty) trend', () => {
  const c = ctx(); c.linuxEvidence.runs = [];
  const receipt = buildReceipt(c);
  assert.equal(receipt.verdict.parityProven, false);
});

// 7. FAIL-CLOSED: a tampered receipt digest.
ok('rejects a tampered digest', () => {
  const bad = JSON.parse(JSON.stringify(committed)); bad.digest = '0'.repeat(64);
  const r = validateReceipt(bad, baseCtx);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /digest|stale/.test(f)));
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# cross-plane-vi-analyzer-parity selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
