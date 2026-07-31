#!/usr/bin/env node
// coverage-lift domain: the OBJECTIVE-gated uplift domain. A provider proposes a Node.js ESM test for a
// named target module; acceptance is a MEASURED coverage result -- the proposed test must run (exit 0) and
// raise the target module's line coverage to >= minCoverage. Baseline coverage of an un-exercised module is
// 0%, so reaching the floor IS the lift. Deterministic + real: the measurement runs the test under
// NODE_V8_COVERAGE and reports with the repo's c8 (offline report, no code-exec in the reporter).
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
const C8 = path.join(REPO, 'node_modules', '.bin', 'c8');

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

// Measure the target module's coverage achieved by running `testText`. Runs in a throwaway temp dir with the
// module copied to ./target.mjs so c8's include matches under cwd. Returns { ran, exitCode, linesPct, funcsPct }.
export async function measureCoverage(targetAbs, testText, { timeoutMs = 30000 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covlift-'));
  try {
    fs.copyFileSync(targetAbs, path.join(tmp, 'target.mjs'));
    fs.writeFileSync(path.join(tmp, 'test.mjs'), unfence(testText));
    const v8 = path.join(tmp, 'v8');
    const rep = path.join(tmp, 'rep');
    const runRes = await run(process.execPath, ['test.mjs'], { cwd: tmp, timeoutMs, env: { ...process.env, NODE_V8_COVERAGE: v8 } });
    const ran = runRes.code === 0 && !runRes.killed;
    let linesPct = 0;
    let funcsPct = 0;
    let reported = false;
    if (fs.existsSync(v8)) {
      await run(C8, ['report', '--temp-directory', v8, '--include', 'target.mjs', '--reporter', 'json-summary', '--report-dir', rep], { cwd: tmp, timeoutMs });
      const sumPath = path.join(rep, 'coverage-summary.json');
      if (fs.existsSync(sumPath)) {
        const s = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
        for (const k of Object.keys(s)) {
          if (k !== 'total' && k.endsWith('target.mjs')) { linesPct = s[k].lines.pct; funcsPct = s[k].functions.pct; reported = true; }
        }
      }
    }
    return { ran, exitCode: runRes.code, killed: runRes.killed, linesPct, funcsPct, reported, stderr: runRes.stderr.slice(0, 400) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// Acceptance gate for coverage-lift: the proposed test RUNS (exit 0) AND lifts the target's line coverage to
// >= minCoverage (default 80). Returns { checks, verdict, coverage }.
export async function acceptanceCoverageLift(task, testText, opts = {}) {
  if (!task.target) return { checks: [{ name: 'has-target', ok: false }], verdict: 'fail' };
  const targetAbs = path.resolve(REPO, task.target);
  if (!fs.existsSync(targetAbs)) return { checks: [{ name: `target-exists:${task.target}`, ok: false }], verdict: 'fail' };
  const minCoverage = Number.isFinite(task.minCoverage) ? task.minCoverage : 80;
  const m = await measureCoverage(targetAbs, testText, opts);
  const checks = [
    { name: 'proposed-test-runs', ok: m.ran },
    { name: `lines>=${minCoverage}%`, ok: m.reported && m.linesPct >= minCoverage },
  ];
  const verdict = checks.every((c) => c.ok) ? 'pass' : 'fail';
  return { checks, verdict, coverage: { target: task.target, linesPct: m.linesPct, funcsPct: m.funcsPct, minCoverage, ran: m.ran, exitCode: m.exitCode } };
}
