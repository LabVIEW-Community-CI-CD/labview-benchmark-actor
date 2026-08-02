#!/usr/bin/env node
// Deterministic self-test for the provider-delegation harness (no GPU / no network / no live provider).
// Proves, via the MOCK adapter:
//   1. task-spec (lba-uplift-task@v1) validation accepts a good task and rejects bad schema/domain;
//   2. the prompt derives from the brief and encodes the required sections + minimum length;
//   3. a well-formed doc-draft PASSES the acceptance gate and yields a well-formed receipt;
//   4. the gate actually GATES -- an unmeetable brief FAILS (verdict=fail on the min-chars check);
//   5. a provider error is FAIL-CLOSED into a receipt (a broken adapter never throws the harness).
// Exit 0 = all proven.

import assert from 'node:assert';
import {
  validateTask, buildPrompt, acceptance, runDelegation, TASK_SCHEMA, RECEIPT_SCHEMA,
} from './delegateUplift.mjs';

let pass = 0;
const ok = (cond, msg) => { assert(cond, msg); pass += 1; };
const throws = (fn, re, msg) => { assert.throws(fn, re, msg); pass += 1; };

// 1) task-spec validation
const goodTask = {
  schema: TASK_SCHEMA, domain: 'doc-draft', id: 'T-DEMO-1',
  brief: 'Draft a short operator note for the cleanroom gate suite.',
  requiredSections: ['Overview', 'How it runs', 'Evidence'], minChars: 150,
};
ok(validateTask(goodTask) === true, 'a valid task passes validation');
throws(() => validateTask({ ...goodTask, schema: 'x' }), /task\.schema/, 'a wrong schema is rejected');
throws(() => validateTask({ ...goodTask, domain: 'nope' }), /task\.domain/, 'an unknown domain is rejected');
throws(() => validateTask({ ...goodTask, brief: '' }), /task\.brief/, 'a missing brief is rejected');

// 2) prompt derives from the brief + names each required section + the minimum length
const p = buildPrompt(goodTask);
ok(p.includes(goodTask.brief) && p.includes('Overview') && p.includes('How it runs') && p.includes('150'),
  'the prompt encodes the brief + required sections + minChars');

// 3) delegate via the MOCK adapter -> acceptance PASS + a well-formed receipt
const r = await runDelegation(goodTask, { provider: 'mock' });
ok(r.schema === RECEIPT_SCHEMA, 'the receipt carries the receipt schema');
ok(r.task.provider === 'mock' && r.task.domain === 'doc-draft' && r.task.id === 'T-DEMO-1',
  'the receipt records provider + domain + task id');
ok(r.acceptance.verdict === 'pass' && r.verdict === 'pass', 'a well-formed doc-draft PASSES the acceptance gate');
ok(r.acceptance.checks.some((c) => c.name === 'section:Overview' && c.ok)
  && r.acceptance.checks.some((c) => c.name === 'section:Evidence' && c.ok),
  'each required section is checked and present in the draft');
ok(r.output.chars > 150, 'the receipt records the drafted-output length');

// 4) the gate actually GATES: a brief the output cannot meet FAILS (negative proof)
const hardTask = { ...goodTask, id: 'T-DEMO-2', minChars: 100000 };
const rf = await runDelegation(hardTask, { provider: 'mock' });
ok(rf.verdict === 'fail' && rf.acceptance.verdict === 'fail', 'an unmeetable acceptance gate FAILS (verdict=fail)');
ok(rf.acceptance.checks.some((c) => c.name.startsWith('min-chars') && !c.ok), 'the failing check is the min-chars gate');

// 5) provider-error path -> fail-closed receipt (a broken adapter never throws the harness)
const brokenDrive = async () => ({ provider: 'mock', model: 'mock', text: '', ms: 0, ok: false, error: 'boom' });
const re = await runDelegation(goodTask, { drive: brokenDrive });
ok(re.verdict === 'fail' && re.provider.ok === false && re.provider.error === 'boom',
  'a provider error yields a fail-closed receipt, not a throw');

console.log(`verify-provider-delegation: PASS (${pass} assertions) -- task-spec + mock provider seam + acceptance gate + receipt proven deterministically`);
