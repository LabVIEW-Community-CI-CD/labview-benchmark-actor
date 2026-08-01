#!/usr/bin/env node
// Deterministic self-test for the risky-test domain (no external tool required): uses `node` itself as the
// always-present "risky tool" so the gate is deterministic under the dependency-free CI suite. Proves:
//   - a PRESENT tool + a passing proposed test (spawns the tool) -> verdict=pass;
//   - an ABSENT required tool -> verdict=SKIP (not fail) -- the risky path can't run here;
//   - a PRESENT tool + a FAILING proposed test -> verdict=fail.
// The real LabVIEW/ffmpeg proof runs in the disposable cleanroom VM (see risky-test-evidence.json). Exit 0 = proven.

import assert from 'node:assert';
import { runDelegation, TASK_SCHEMA } from './delegateUplift.mjs';
import { detectTool } from './riskyTest.mjs';

const driveOf = (code) => async () => ({ provider: 'mock', model: 'mock', text: code, ms: 0, ok: true, error: null });

// A passing risky test: spawn the tool (node --version) and assert it worked.
const GOOD = `
import { execFileSync } from 'node:child_process';
import assert from 'node:assert';
const out = execFileSync('node', ['--version'], { encoding: 'utf8' });
assert(/^v\\d+/.test(out.trim()), 'node --version prints a version');
`;

// A failing risky test: the tool runs, but the assertion fails -> non-zero exit.
const FAILING = `
import { execFileSync } from 'node:child_process';
import assert from 'node:assert';
execFileSync('node', ['--version']);
assert.equal(1, 2, 'intentional failure');
`;

let pass = 0;
const ok = (c, m) => { assert(c, m); pass += 1; };

// sanity: node is present (the always-available stand-in tool); a bogus tool is not.
ok(detectTool('node').present === true, 'detectTool finds node on PATH (the always-present stand-in tool)');
ok(detectTool('lba-no-such-tool-xyz').present === false, 'detectTool reports a bogus tool as absent');

const present = { schema: TASK_SCHEMA, domain: 'risky-test', id: 'T-RISK-1', tool: 'node', brief: 'Verify the node tool runs.' };
const r1 = await runDelegation(present, { drive: driveOf(GOOD) });
ok(r1.verdict === 'pass', 'a present tool + a passing risky test -> pass');
ok(r1.tool && r1.tool.present === true && r1.tool.name === 'node', 'the receipt records the resolved tool (present)');
ok(r1.acceptance.checks.some((c) => c.name === 'risky-test-runs' && c.ok), 'the risky test actually ran the tool (exit 0)');

const absent = { ...present, id: 'T-RISK-2', tool: 'lba-no-such-tool-xyz' };
const r2 = await runDelegation(absent, { drive: driveOf(GOOD) });
ok(r2.verdict === 'skip', 'an ABSENT required tool -> SKIP (not fail) -- the risky test cannot run here');
ok(r2.tool.present === false && r2.acceptance.checks.some((c) => c.skipped === true), 'the receipt records the absent tool + a skipped check');

const failing = { ...present, id: 'T-RISK-3' };
const r3 = await runDelegation(failing, { drive: driveOf(FAILING) });
ok(r3.verdict === 'fail', 'a present tool + a FAILING risky test -> fail');
ok(r3.acceptance.checks.some((c) => c.name === 'risky-test-runs' && !c.ok), 'the failing risky test is detected (non-zero exit)');

console.log(`verify-risky-test: PASS (${pass} assertions) -- tool-gated risky tests (present+pass, absent->skip, present+fail)`);
