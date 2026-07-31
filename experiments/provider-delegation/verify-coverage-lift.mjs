#!/usr/bin/env node
// Deterministic self-test for the coverage-lift domain: a provider-proposed test is gated on the MEASURED
// line coverage of a named target module. Uses injected mock "drives" (trusted, hand-authored test code) so
// the executed code is safe, but the coverage is REAL (NODE_V8_COVERAGE + the repo's c8). Proves:
//   - a THOROUGH proposed test lifts coverage past the floor -> verdict=pass (high linesPct);
//   - a WEAK test runs (exit 0) but under-covers -> verdict=fail (linesPct < floor);
//   - a FAILING test is detected (proposed-test-runs=false) -> verdict=fail.
// Exit 0 = proven.

import assert from 'node:assert';
import { runDelegation, TASK_SCHEMA } from './delegateUplift.mjs';

const target = 'experiments/provider-delegation/fixtures/sample-module.mjs';
const task = { schema: TASK_SCHEMA, domain: 'coverage-lift', id: 'T-COV-1', target, brief: 'Lift coverage of the sample module.', minCoverage: 80 };

const THOROUGH = `
import * as mod from './target.mjs';
import assert from 'node:assert';
assert.equal(mod.classify(1), 'positive');
assert.equal(mod.classify(-1), 'negative');
assert.equal(mod.classify(0), 'zero');
assert.equal(mod.clamp(5, 0, 10), 5);
assert.equal(mod.clamp(-1, 0, 10), 0);
assert.equal(mod.clamp(11, 0, 10), 10);
assert.equal(mod.sum([1, 2, 3]), 6);
assert.equal(mod.sum([]), 0);
assert.equal(mod.fib(0), 0);
assert.equal(mod.fib(1), 1);
assert.equal(mod.fib(7), 13);
`;

const WEAK = `
import * as mod from './target.mjs';
import assert from 'node:assert';
assert.equal(mod.classify(1), 'positive');
`;

const FAILING = `
import * as mod from './target.mjs';
import assert from 'node:assert';
assert.equal(mod.classify(1), 'WRONG');
`;

const driveOf = (code) => async () => ({ provider: 'mock', model: 'mock', text: code, ms: 0, ok: true, error: null });

let pass = 0;
const ok = (c, m) => { assert(c, m); pass += 1; };

const r1 = await runDelegation(task, { drive: driveOf(THOROUGH) });
ok(r1.verdict === 'pass', 'a thorough proposed test lifts coverage and PASSES');
ok(r1.coverage && r1.coverage.linesPct >= 90, `coverage is measured and high (lines=${r1.coverage && r1.coverage.linesPct}%)`);
ok(r1.coverage.target === target && Number.isFinite(r1.coverage.funcsPct), 'the receipt carries the measured coverage (target + funcsPct)');

const r2 = await runDelegation(task, { drive: driveOf(WEAK) });
ok(r2.verdict === 'fail', 'a weak proposed test does NOT reach the floor -> FAIL');
ok(r2.coverage.linesPct < 80, `weak coverage is below the floor (lines=${r2.coverage.linesPct}%)`);
ok(r2.acceptance.checks.some((c) => c.name === 'proposed-test-runs' && c.ok), 'the weak test still runs (exit 0) -- it just under-covers');

const r3 = await runDelegation(task, { drive: driveOf(FAILING) });
ok(r3.verdict === 'fail', 'a failing proposed test -> FAIL');
ok(r3.acceptance.checks.some((c) => c.name === 'proposed-test-runs' && !c.ok), 'the failing test is detected (proposed-test-runs=false)');

console.log(`verify-coverage-lift: PASS (${pass} assertions) -- provider-proposed test gated on MEASURED coverage (thorough ${r1.coverage.linesPct}% pass, weak ${r2.coverage.linesPct}% fail, failing-test fail)`);
