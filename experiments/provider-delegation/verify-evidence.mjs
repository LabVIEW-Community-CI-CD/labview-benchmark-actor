#!/usr/bin/env node
// Deterministic self-test for the evidence domain (no GPU / no network): writes temp delegation receipts,
// gathers + validates them, and gates a mock provider's summary for accuracy. Proves:
//   - valid receipts + an accurate summary (correct total + pass counts) -> verdict=pass;
//   - a hallucinated summary (wrong pass count) -> verdict=fail (the grounding gate);
//   - an invalid / non-receipt file in the set -> verdict=fail (all-receipts-valid).
// Exit 0 = proven.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDelegation, TASK_SCHEMA, RECEIPT_SCHEMA } from './delegateUplift.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
const mkReceipt = (id, verdict) => {
  const p = path.join(tmp, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify({ schema: RECEIPT_SCHEMA, verdict, task: { domain: 'doc-draft', id, provider: 'mock' } }));
  return p;
};
const r1 = mkReceipt('R-1', 'pass');
const r2 = mkReceipt('R-2', 'pass');
const r3 = mkReceipt('R-3', 'fail');
const notReceipt = path.join(tmp, 'notreceipt.json');
fs.writeFileSync(notReceipt, JSON.stringify({ hello: 'world' })); // valid JSON, wrong schema

const driveOf = (code) => async () => ({ provider: 'mock', model: 'mock', text: code, ms: 0, ok: true, error: null });

let pass = 0;
const ok = (c, m) => { assert(c, m); pass += 1; };

// 3 valid receipts (2 pass, 1 fail): total=3, pass=2
const task = { schema: TASK_SCHEMA, domain: 'evidence', id: 'T-EV-1', receipts: [r1, r2, r3], minReceipts: 1, brief: 'Summarize the receipts.' };

// 1) accurate summary -> pass + a well-formed bundle
const rA = await runDelegation(task, { drive: driveOf('The evidence bundle has 3 receipts, 2 of which passed.') });
ok(rA.verdict === 'pass', 'valid receipts + an accurate summary (total 3, pass 2) -> pass');
ok(rA.evidence && rA.evidence.valid === 3 && rA.evidence.byVerdict.pass === 2 && rA.evidence.byVerdict.fail === 1, 'the evidence bundle tallies the receipts by verdict');
ok(rA.acceptance.checks.some((c) => c.name === 'all-receipts-valid' && c.ok), 'all gathered receipts are schema-valid');

// 2) hallucinated summary (wrong pass count) -> fail (grounding gate)
const rB = await runDelegation(task, { drive: driveOf('The evidence bundle has 3 receipts, 5 of which passed.') });
ok(rB.verdict === 'fail', 'a summary that misstates the pass count -> fail (grounding gate)');
ok(rB.acceptance.checks.some((c) => c.name === 'summary-states-pass:2' && !c.ok), 'the failing grounding check is the pass-count');

// 3) an invalid / non-receipt file in the set -> fail (all-receipts-valid)
const taskBad = { ...task, id: 'T-EV-2', receipts: [r1, r2, notReceipt] };
const rC = await runDelegation(taskBad, { drive: driveOf('The bundle has 2 receipts, 2 passed.') });
ok(rC.verdict === 'fail', 'an invalid / non-receipt file in the set -> fail');
ok(rC.acceptance.checks.some((c) => c.name === 'all-receipts-valid' && !c.ok), 'the invalid receipt is detected');
ok(rC.evidence.invalid === 1, 'the bundle records the invalid count');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`verify-evidence: PASS (${pass} assertions) -- receipt gathering + schema validation + grounded-summary gate`);
