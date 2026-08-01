#!/usr/bin/env node
// risky-test domain: the TOOL-gated uplift domain. A provider proposes a Node.js ESM test that exercises a
// real external tool (e.g. ffmpeg, LabVIEW's LabVIEWCLI) that HOSTED CI cannot provide. Acceptance is
// tool-aware:
//   - if the required tool is ABSENT (e.g. the pure CI runner) the outcome is SKIP -- not fail: the risky
//     path simply cannot be exercised here;
//   - if the tool is PRESENT (e.g. the cleanroom VM with LabVIEW/ffmpeg) the proposed test RUNS and must
//     exit 0 (the tool was genuinely invoked) -> pass, else fail.
// So the SAME domain gate is a deterministic no-op under the dependency-free CI suite and a real proof in the
// cleanroom -- exactly what "risky" tests need. Dependency-free (node: builtins only).
//
// SAFETY: measuring executes the proposed test, which invokes a real tool. The deterministic gate
// (verify-risky-test.mjs) uses `node` itself as the always-present tool (safe). UNTRUSTED provider-proposed
// tests that drive LabVIEW/ffmpeg belong in the DISPOSABLE cleanroom VM, not on a trusted host.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Portable tool detection: search PATH for an executable named `tool` WITHOUT running anything (no code-exec
// in detection). Honors Windows executable extensions. Returns { present, name, path }.
export function detectTool(tool) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').concat('') : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, tool + ext);
      try { fs.accessSync(p, fs.constants.X_OK); return { present: true, name: tool, path: p }; } catch { /* keep looking */ }
    }
  }
  return { present: false, name: tool, path: null };
}

// Prompt: ask the provider to write a test that invokes the real tool and asserts it works, so the SAME test
// shape works whether the provider is Ollama, the Copilot CLI, or the mock.
export function buildRiskyTestPrompt(task) {
  const tool = task.tool || 'ffmpeg';
  const flag = task.versionArg || '-version';
  return (
    `You are a risky-test agent for the labview-benchmark-actor project. Task ${task.id}. ${task.brief || ''}\n\n` +
    `Write a single Node.js ESM test that verifies the real '${tool}' tool works: spawn it via ` +
    `node:child_process (e.g. \`${tool} ${flag}\`) and assert a zero exit and expected output. Use ` +
    `node:child_process and node:assert. On success print nothing and exit 0; throw on any failure. ` +
    `Output ONLY the JavaScript test code -- no Markdown fences, no prose.`
  );
}

function unfence(text) {
  const m = String(text || '').match(/```(?:[a-zA-Z0-9]*)\n([\s\S]*?)```/);
  return m ? m[1] : String(text || '');
}

function run(cmd, args, { cwd, env, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
      resolve({ code, killed: !!(err && err.killed), stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Run the proposed risky test in a throwaway temp dir (inherits env, so the tool is on PATH). Returns { ran }.
export async function measureRisky(testText, { timeoutMs = 30000 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'risky-'));
  try {
    fs.writeFileSync(path.join(tmp, 'test.mjs'), unfence(testText));
    const r = await run(process.execPath, ['test.mjs'], { cwd: tmp, timeoutMs });
    return { ran: r.code === 0 && !r.killed, exitCode: r.code, killed: r.killed, stderr: r.stderr.slice(0, 400) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// Acceptance gate for risky-test: SKIP when the required tool is absent; otherwise the proposed test must run
// the tool and exit 0. Returns { checks, verdict, tool }.
export async function acceptanceRiskyTest(task, testText, opts = {}) {
  const tool = task.tool || 'ffmpeg';
  const det = detectTool(tool);
  if (!det.present) {
    return { checks: [{ name: `tool-present:${tool}`, ok: false, skipped: true }], verdict: 'skip', tool: det };
  }
  const m = await measureRisky(testText, opts);
  const checks = [
    { name: `tool-present:${tool}`, ok: true },
    { name: 'risky-test-runs', ok: m.ran },
  ];
  const verdict = m.ran ? 'pass' : 'fail';
  return { checks, verdict, tool: det, ran: m.ran, exitCode: m.exitCode };
}
