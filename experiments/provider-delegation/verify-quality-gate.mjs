#!/usr/bin/env node
// Deterministic self-test for the quality PRE-gate: score a provider draft for faithfulness BEFORE the
// (expensive) domain gate, and short-circuit a weak / off-topic / refusal draft. Reuses the ollama-comparison
// direction-faithfulness scorer. Proves the scoring, the short-circuit (a bad coverage-lift draft is rejected
// WITHOUT running the coverage measurement), and that a faithful draft proceeds to the domain gate. Exit 0 = proven.

import assert from 'node:assert';
import { qualityPreGate, scoreFaithfulness } from './qualityGate.mjs';
import { runDelegation, TASK_SCHEMA } from './delegateUplift.mjs';

let pass = 0;
const ok = (c, m) => { assert(c, m); pass += 1; };

// 1) faithfulness scoring + refusal + reused direction scorer
ok(scoreFaithfulness('the gate suite writes a receipt', ['gate suite', 'receipt']).score === 1, 'all expected terms present -> faithfulness 1');
ok(scoreFaithfulness('a poem about cats', ['gate suite', 'receipt']).score === 0, 'no expected terms -> faithfulness 0');
ok(qualityPreGate({ quality: { expectTerms: ['gate suite', 'receipt'], minFaithfulness: 1 } }, 'The gate suite writes a receipt.').ok, 'a faithful draft passes the pre-gate');
ok(!qualityPreGate({ quality: { expectTerms: ['gate suite', 'receipt'], minFaithfulness: 0.5 } }, 'A poem about cats.').ok, 'an off-topic draft fails the faithfulness pre-gate');
const refusal = qualityPreGate({ quality: { expectTerms: ['x'] } }, "I'm sorry, I can't help with that.");
ok(!refusal.ok && refusal.refusal, 'a refusal is caught by the pre-gate');
ok(qualityPreGate({ quality: { expectDirection: 'down' } }, 'performance improved and latency fell').ok, 'a draft reporting the DOWN direction passes (reused ollama-comparison scorer)');
ok(!qualityPreGate({ quality: { expectDirection: 'down' } }, 'performance regressed and latency rose').ok, 'a draft reporting the WRONG direction fails');

// 2) short-circuit: an off-topic coverage-lift draft is rejected BEFORE the coverage measurement runs
const target = 'experiments/provider-delegation/fixtures/sample-module.mjs';
const covTask = { schema: TASK_SCHEMA, domain: 'coverage-lift', id: 'T-Q-COV', target, minCoverage: 80, brief: 'Lift coverage.', quality: { expectTerms: ['target.mjs', 'assert'], minFaithfulness: 0.5 } };
const drive = (text) => async () => ({ provider: 'mock', model: 'mock', text, ms: 0, ok: true, error: null });

const rejected = await runDelegation(covTask, { drive: drive('A poem about cats, unrelated to any module.') });
ok(rejected.verdict === 'fail', 'an off-topic coverage-lift draft -> verdict fail (rejected by the pre-gate)');
ok(rejected.quality && rejected.quality.ok === false, 'the receipt records the failing quality pre-gate');
ok(!rejected.coverage, 'the coverage domain gate was SHORT-CIRCUITED (no coverage measured)');
ok(rejected.acceptance.checks.some((c) => c.name === 'quality-pregate' && !c.ok), 'the acceptance is the pre-gate rejection, not a coverage check');

// 3) a faithful draft passes the pre-gate and the domain gate then RUNS
const good = `import * as mod from './target.mjs';
import assert from 'node:assert';
assert.equal(mod.classify(1), 'positive'); assert.equal(mod.classify(-1), 'negative'); assert.equal(mod.classify(0), 'zero');
assert.equal(mod.clamp(5, 0, 10), 5); assert.equal(mod.clamp(-1, 0, 10), 0); assert.equal(mod.clamp(11, 0, 10), 10);
assert.equal(mod.sum([1, 2, 3]), 6); assert.equal(mod.sum([]), 0);
assert.equal(mod.fib(0), 0); assert.equal(mod.fib(1), 1); assert.equal(mod.fib(7), 13);`;
const passed = await runDelegation(covTask, { drive: drive(good) });
ok(passed.quality.ok === true, 'a faithful coverage-lift draft passes the pre-gate');
ok(passed.coverage && passed.coverage.funcsPct >= 90, 'the coverage domain gate RAN once the pre-gate passed (coverage measured)');
ok(passed.verdict === 'pass', 'faithful draft + high coverage -> pass');

console.log(`verify-quality-gate: PASS (${pass} assertions) -- faithfulness pre-gate (reuses ollama-comparison scorer) short-circuits weak drafts before the domain gate`);
