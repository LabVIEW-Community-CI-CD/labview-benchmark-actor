#!/usr/bin/env node
// Self-test for lunitTestBenchmark.mjs (LBA-REQ-053, realizes ADR-0033). Binds the committed lunit-test
// receipt (the TESTER actor of the 2-actor icon-editor grid: the Rust-built g-cli ran
// `g-cli lunit -- -r <report> lv_icon_editor.lvproj` against the icon-editor project on lba-golden, LUnit
// framework from icon-editor-developer.vipc). Proves the receipt validates + is deterministic + the
// resultHash is the MACHINE-INDEPENDENT test inventory (same across planes even when the pass/fail outcomes
// differ), and FAILS CLOSED on a tampered resultHash, a forged verdict, an inventory that disagrees with the
// reported total, or a tampered digest. Pure -- no LabVIEW / g-cli.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLunitReceipt, validateLunitReceipt, digestReceipt, RECEIPT_SCHEMA,
} from './lunitTestBenchmark.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const committed = JSON.parse(readFileSync(join(here, 'fixtures', 'lunit-test-benchmark-receipt.json'), 'utf8'));

let n = 0;
const ok = (m) => { n++; console.log(`ok ${n} - ${m}`); };

const captureOf = (r) => ({
  plane: r.plane, tool: r.tool, dependency: r.dependency, labview: r.labview, project: r.project,
  operation: r.operation, suites: r.suites, inventory: r.inventory, total: r.total, outcomes: r.outcomes,
  reportWellFormed: r.reportWellFormed, reportBytes: r.reportBytes, testTimeSeconds: r.testTimeSeconds, note: r.note,
});

// 1. the committed receipt validates and the tester actor executed the suite
{
  const v = validateLunitReceipt(committed);
  assert.ok(v.ok && v.benchmarkOk, `committed receipt must validate + pass: ${v.findings.join('; ')}`);
  assert.equal(committed.schema, RECEIPT_SCHEMA, 'schema is lunit-test-benchmark@1');
  assert.equal(committed.project.name, 'lv_icon_editor.lvproj', 'tested the icon-editor project');
  assert.equal(committed.inventory.length, committed.total, 'inventory length matches total');
  assert.ok(committed.total > 0 && committed.suites.length > 0, 'discovered suites + cases');
  ok('committed lunit-test receipt validates and the suite executed');
}

// 2. deterministic: the same capture rebuilds byte-identically
{
  const a = buildLunitReceipt(captureOf(committed));
  const b = buildLunitReceipt(captureOf(committed));
  assert.equal(a.digest, b.digest, 'digest is deterministic');
  assert.equal(a.digest, committed.digest, 'rebuild matches the committed fixture');
  assert.equal(a.resultHash, committed.resultHash, 'resultHash matches the committed fixture');
  ok('receipt build is deterministic (stable digest + resultHash)');
}

// 3. resultHash is the MACHINE-INDEPENDENT test inventory: a plane where every test passes (different
//    outcomes / timing / report size) yields the SAME resultHash, because the inventory is identical.
{
  const guiPlane = buildLunitReceipt({
    ...captureOf(committed),
    plane: 'linux-host-with-display',
    outcomes: { passed: committed.total, failed: 0, errored: 0, setupOrHelper: 0, total: committed.total },
    reportBytes: 99999, testTimeSeconds: 12.3, // different perf / size / outcomes
  });
  assert.equal(guiPlane.resultHash, committed.resultHash, 'same test inventory -> same resultHash across planes');
  assert.equal(guiPlane.verdict.benchmarkOk, true, 'still a valid execution on the other plane');
  ok('resultHash is machine-independent (test inventory identity, outcome/timing invariant)');
}

// 4. FAIL CLOSED: a tampered resultHash
{
  const t = { ...committed, resultHash: '0'.repeat(64) };
  const v = validateLunitReceipt(t);
  assert.ok(!v.ok && v.findings.some((f) => /resultHash/.test(f)), 'a tampered resultHash must be rejected');
  ok('fail-closed: a tampered resultHash is rejected');
}

// 5. FAIL CLOSED: a forged verdict -- an empty run (no tests discovered) reshaped to claim it passed
{
  const empty = buildLunitReceipt({ ...captureOf(committed), suites: [], inventory: [], total: 0, reportWellFormed: true });
  assert.equal(empty.verdict.benchmarkOk, false, 'zero discovered tests must fail the benchmark');
  const forged = structuredClone(empty);
  forged.verdict.benchmarkOk = true;   // claim success with no tests...
  forged.digest = digestReceipt(forged); // ...and re-seal
  const v = validateLunitReceipt(forged);
  assert.ok(!v.ok, 'a forged benchmarkOk over an empty run must be rejected');
  ok('fail-closed: a forged verdict over an empty run is rejected');
}

// 6. FAIL CLOSED: the inventory disagrees with the reported total (a dropped/hidden test case)
{
  const tampered = structuredClone(committed);
  tampered.inventory = committed.inventory.slice(0, committed.total - 1); // 24 cases but total still says 25
  const v = validateLunitReceipt(tampered);
  assert.ok(!v.ok && v.findings.some((f) => /inventory length/.test(f)), 'an inventory that does not match total must be rejected');
  ok('fail-closed: an inventory that disagrees with the reported total is rejected');
}

// 7. FAIL CLOSED: a tampered digest
{
  const t = { ...committed, digest: '0'.repeat(64) };
  const v = validateLunitReceipt(t);
  assert.ok(!v.ok && v.findings.some((f) => /digest/.test(f)), 'a tampered digest must be rejected');
  ok('fail-closed: a tampered digest is rejected');
}

console.log(`\n# lunit-test-benchmark self-test: ${n}/${n} passed`);
