#!/usr/bin/env node
// lunit-test-benchmark@1 builder + validator (LBA-REQ-053, realizes ADR-0033). This is the TESTER actor of
// the 2-actor icon-editor grid (companion to the BUILDER actor, LBA-REQ-051). It reproduces the
// ni/labview-icon-editor project's REAL unit-test run: `g-cli lunit -- -r <report.xml> lv_icon_editor.lvproj`
// discovers the project's LUnit test classes, runs them, and emits a JUnit report. The g-cli launcher is the
// Rust proxy built in LBA-REQ-052; the LUnit framework comes from the CORRECT dependency config
// `icon-editor-developer.vipc` (NOT the CI-runner `runner_dependencies.vipc`).
//
// The RESULT identity is the TEST INVENTORY -- the sorted set of `class/testcase` the project defines plus the
// suite structure -- which is machine-independent, so the same suite is comparable across planes. The pass /
// fail / error OUTCOMES are recorded as observed but are environment-dependent (e.g. window-geometry + INI
// tests error under headless xvfb) so they are NOT in the resultHash or digest. The benchmark verdict is that
// the tester actor EXECUTED the suite and produced a well-formed report whose case count matches its
// inventory -- it does not assert the icon-editor's own tests are all green.
//
// Pure + rg-free + offline: a committed receipt re-derives its resultHash + verdict + digest byte-stably in
// CI (which has no LabVIEW / g-cli). The gate fails closed on a stale/tampered resultHash, a forged verdict,
// an inventory whose length disagrees with the reported total, or a tampered digest.

import { createHash } from 'node:crypto';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/lunit-test-benchmark@1';

const sortedInventory = (inv) => (Array.isArray(inv) ? [...inv].sort() : []);
const sortedSuites = (s) => (Array.isArray(s) ? [...s].map((x) => ({ name: x.name ?? null, tests: x.tests ?? null })).sort((a, b) => String(a.name).localeCompare(String(b.name))) : []);

// Machine-independent test identity: which project (+ commit) was tested with which operation, and the exact
// inventory of test cases discovered + suite structure. Excludes pass/fail outcomes, timing, report bytes.
export function computeResultHash({ project, projectCommit, operation, inventory, total, suites }) {
  const canon = JSON.stringify({
    project: project ?? null,
    projectCommit: projectCommit ?? null,
    operation: operation ?? null,
    inventory: sortedInventory(inventory),
    total: Number.isInteger(total) ? total : null,
    suites: sortedSuites(suites),
  });
  return createHash('sha256').update(canon).digest('hex');
}

// The tester actor passes iff it produced a well-formed report: a positive test total, an inventory whose
// length matches that total, and at least one suite. (It does NOT require every icon-editor test to be green.)
export function decideBenchmark({ reportWellFormed, total, inventoryLength, suitesLength }) {
  return reportWellFormed === true && Number.isInteger(total) && total > 0
    && inventoryLength === total && suitesLength > 0;
}

// Digest over the verdict-bearing fields (NOT outcomes / timing / report bytes, which vary by environment).
function canonical(receipt) {
  return JSON.stringify({
    schema: receipt.schema,
    project: receipt.project?.name ?? null,
    projectCommit: receipt.project?.commit ?? null,
    operation: receipt.operation ?? null,
    inventory: sortedInventory(receipt.inventory),
    total: receipt.total ?? null,
    suites: sortedSuites(receipt.suites),
    reportWellFormed: receipt.reportWellFormed ?? null,
    resultHash: receipt.resultHash ?? null,
    verdict: { benchmarkOk: receipt.verdict?.benchmarkOk },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build a lunit-test-benchmark@1 receipt from a captured g-cli lunit run (deterministic + sealed).
export function buildLunitReceipt(capture) {
  const inventory = sortedInventory(capture.inventory);
  const suites = sortedSuites(capture.suites);
  const total = Number.isInteger(capture.total) ? capture.total : inventory.length;
  const reportWellFormed = !!capture.reportWellFormed;
  const resultHash = computeResultHash({
    project: capture.project?.name, projectCommit: capture.project?.commit, operation: capture.operation,
    inventory, total, suites,
  });
  const benchmarkOk = decideBenchmark({ reportWellFormed, total, inventoryLength: inventory.length, suitesLength: suites.length });
  const receipt = {
    schema: RECEIPT_SCHEMA,
    plane: capture.plane ?? null,
    tool: capture.tool ?? null,
    dependency: capture.dependency ?? null,
    labview: capture.labview ?? null,
    project: capture.project ?? null,
    operation: capture.operation ?? null,
    suites,
    inventory,
    total,
    outcomes: capture.outcomes ?? null,
    reportWellFormed,
    reportBytes: capture.reportBytes ?? null,
    testTimeSeconds: capture.testTimeSeconds ?? null,
    resultHash,
    note: capture.note ?? null,
    verdict: {
      benchmarkOk,
      reason: benchmarkOk
        ? `g-cli lunit executed ${suites.length} suites / ${total} cases and produced a well-formed report`
        : 'g-cli lunit did not produce a well-formed report matching its inventory',
    },
  };
  receipt.digest = digestReceipt(receipt);
  return receipt;
}

// Validate a committed receipt: schema, resultHash re-derivation, inventory/total agreement, verdict, digest.
export function validateLunitReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  const inv = sortedInventory(receipt?.inventory);
  if (!Number.isInteger(receipt?.total) || inv.length !== receipt.total) findings.push(`inventory length (${inv.length}) must match total (${receipt?.total})`);
  const expectedHash = computeResultHash({
    project: receipt?.project?.name, projectCommit: receipt?.project?.commit, operation: receipt?.operation,
    inventory: receipt?.inventory, total: receipt?.total, suites: receipt?.suites,
  });
  if (receipt?.resultHash !== expectedHash) findings.push('resultHash does not match the recorded test inventory (stale/tampered)');
  const expectedVerdict = decideBenchmark({
    reportWellFormed: receipt?.reportWellFormed, total: receipt?.total,
    inventoryLength: inv.length, suitesLength: sortedSuites(receipt?.suites).length,
  });
  if (receipt?.verdict?.benchmarkOk !== expectedVerdict) findings.push(`verdict.benchmarkOk=${receipt?.verdict?.benchmarkOk} contradicts the rule (${expectedVerdict})`);
  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, benchmarkOk: !!receipt?.verdict?.benchmarkOk && findings.length === 0, resultHash: receipt?.resultHash, findings };
}
