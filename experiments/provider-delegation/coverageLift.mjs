#!/usr/bin/env node
// coverage-lift domain: the OBJECTIVE-gated uplift domain. A provider proposes a Node.js ESM test for a
// named target module; acceptance is a MEASURED coverage result -- the proposed test must run (exit 0) and
// raise the target module's FUNCTION coverage to >= minCoverage. Baseline coverage of an un-exercised module
// is ~0%, so reaching the floor IS the lift. DEPENDENCY-FREE: the measurement runs the test under
// NODE_V8_COVERAGE and parses V8's own coverage JSON (no c8, no npm install), so it runs under the pure
// dependency-free local gate suite (experiments/verify-local-gates.mjs) as well as in dev.
//
// SAFETY: measuring executes the proposed test. The DETERMINISTIC gate (verify-coverage-lift.mjs) runs only
// TRUSTED, hand-authored mock tests. UNTRUSTED provider-proposed tests should be measured inside the
// DISPOSABLE cleanroom VM (the harness runs identically there), not on a trusted host. (--permission cannot
// be combined with V8 coverage, so isolation is by disposable environment, not by in-process sandbox.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

// Prompt: ask the provider to write a test importing the module under test as './target.mjs' and exercising
// every branch, so the SAME test shape works whether the provider is Ollama, the Copilot CLI, or the mock.
export function buildCoverageLiftPrompt(task) {
  return (
    `You are a coverage-lift agent for the labview-benchmark-actor project. Task ${task.id}. ` +
    `${task.brief}\n\n` +
    `Write a single Node.js ESM test that RAISES code coverage of the module under test. ` +
    `Import it EXACTLY as: import * as mod from './target.mjs';\n` +
    `Call every exported function across ALL branches (e.g. positive/negative/zero, below/within/above a range, ` +
    `empty/non-empty input, base/recursive cases). Use node:assert for checks. On success print nothing and ` +
    `exit 0; throw on any mismatch. Output ONLY the JavaScript test code -- no Markdown fences, no prose.`
  );
}

function run(cmd, args, { cwd, env, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
      resolve({ code, killed: !!(err && err.killed), stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Strip an accidental ```js ... ``` fence if a provider wraps the code despite instructions.
function unfence(text) {
  const m = String(text || '').match(/```(?:[a-zA-Z0-9]*)\n([\s\S]*?)```/);
  return m ? m[1] : String(text || '');
}

// Compute FUNCTION coverage of the target script from NODE_V8_COVERAGE JSON -- dependency-free (no c8). A
// function is "covered" when its first range's execution count is > 0; the module top-level counts too.
function v8FunctionCoverage(v8dir, targetBasename) {
  let total = 0;
  let covered = 0;
  let found = false;
  for (const f of fs.readdirSync(v8dir)) {
    if (!f.endsWith('.json')) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(v8dir, f), 'utf8')); } catch { continue; }
    for (const script of data.result || []) {
      if (!script.url || !script.url.endsWith(targetBasename)) continue;
      found = true;
      for (const fn of script.functions || []) {
        total += 1;
        if (fn.ranges && fn.ranges[0] && fn.ranges[0].count > 0) covered += 1;
      }
    }
  }
  return { found, total, covered, pct: total ? Math.round((covered / total) * 10000) / 100 : 0 };
}

// Measure the target module's coverage achieved by running `testText`. Runs in a throwaway temp dir with the
// module copied to ./target.mjs. Returns { ran, exitCode, funcsPct, coveredFns, totalFns, reported }.
export async function measureCoverage(targetAbs, testText, { timeoutMs = 30000 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covlift-'));
  try {
    fs.copyFileSync(targetAbs, path.join(tmp, 'target.mjs'));
    fs.writeFileSync(path.join(tmp, 'test.mjs'), unfence(testText));
    const v8 = path.join(tmp, 'v8');
    const runRes = await run(process.execPath, ['test.mjs'], { cwd: tmp, timeoutMs, env: { ...process.env, NODE_V8_COVERAGE: v8 } });
    const ran = runRes.code === 0 && !runRes.killed;
    let cov = { found: false, pct: 0, covered: 0, total: 0 };
    if (fs.existsSync(v8)) cov = v8FunctionCoverage(v8, 'target.mjs');
    return { ran, exitCode: runRes.code, killed: runRes.killed, funcsPct: cov.pct, coveredFns: cov.covered, totalFns: cov.total, reported: cov.found, stderr: runRes.stderr.slice(0, 400) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// Acceptance gate for coverage-lift: the proposed test RUNS (exit 0) AND lifts the target's FUNCTION coverage
// to >= minCoverage (default 80). Returns { checks, verdict, coverage }.
export async function acceptanceCoverageLift(task, testText, opts = {}) {
  if (!task.target) return { checks: [{ name: 'has-target', ok: false }], verdict: 'fail' };
  const targetAbs = path.resolve(REPO, task.target);
  if (!fs.existsSync(targetAbs)) return { checks: [{ name: `target-exists:${task.target}`, ok: false }], verdict: 'fail' };
  const minCoverage = Number.isFinite(task.minCoverage) ? task.minCoverage : 80;
  const m = await measureCoverage(targetAbs, testText, opts);
  const checks = [
    { name: 'proposed-test-runs', ok: m.ran },
    { name: `funcs>=${minCoverage}%`, ok: m.reported && m.funcsPct >= minCoverage },
  ];
  const verdict = checks.every((c) => c.ok) ? 'pass' : 'fail';
  return { checks, verdict, coverage: { target: task.target, funcsPct: m.funcsPct, coveredFns: m.coveredFns, totalFns: m.totalFns, minCoverage, ran: m.ran, exitCode: m.exitCode } };
}
