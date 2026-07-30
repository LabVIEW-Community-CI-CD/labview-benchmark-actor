#!/usr/bin/env node
// AGENT LAST GATE -- an automated, agentic pre-vet of the packaged extension that runs BEFORE the human
// last gate (the reviewer VM). It proves the candidate is publishable so the human reviews something
// already green, plus the evidence. Publish stays gated behind the human review + the WIN<->LINUX
// agreement + VSCE_PAT; this gate is the machine pre-flight in front of all of that.
//
// OS-agnostic (Node + `npx vsce`), so it runs identically on the WIN and LINUX planes and can be wired
// as a REQUIRED pre-publish gate in the release workflow. Emits a verdict receipt and exits non-zero on
// any failed check.
//
// Usage: node scripts/agent-last-gate.mjs [--skip-tests] [--json]
//   --skip-tests  trust that `npm test` is already green (e.g. the CI job ran it) -- still requires a
//                 compiled out/ for packaging.
//   --json        print the receipt JSON to stdout in addition to the summary.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const argv = process.argv.slice(2);
const skipTests = argv.includes('--skip-tests');
const emitJson = argv.includes('--json');

const SIZE_CEILING_BYTES = 1024 * 1024; // 1 MiB -- a real extension .vsix is ~26 KB.
const ALLOW_SET = [/^package\.json$/, /^README\.md$/, /^CHANGELOG\.md$/, /^LICENSE(\.[A-Za-z]+)?$/i, /^out\//, /^media\//];

const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: String(detail) });
}
function runNode(scriptArgs) {
  return spawnSync(process.execPath, scriptArgs, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function runShell(cmd) {
  return spawnSync(cmd, { cwd: root, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
}
function lastLine(s) {
  const lines = String(s || '').trim().split(/\r?\n/).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}
function pngDims(file) {
  const buf = readFileSync(file);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 24 || sig.some((b, i) => buf[i] !== b)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// --- 1. build + tests (compile, activation surface, viewer, MCP stdio round-trip, doc drift) ---
if (skipTests) {
  record('build-and-tests', true, 'skipped (--skip-tests); caller asserts `npm test` is already green');
} else {
  const r = runShell('npm test');
  record('build-and-tests', r.status === 0,
    r.status === 0
      ? 'npm test green (compile + activation + viewer + mcp-stdio + mcp-doc-drift)'
      : `npm test FAILED (exit ${r.status}): ${lastLine(r.stdout) || lastLine(r.stderr)}`);
}

// --- 2. deterministic local gates ---
{
  const r = runNode(['experiments/verify-local-gates.mjs']);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = /(\d+)\/(\d+) checks passed/.exec(out);
  const ok = r.status === 0 && m && m[1] === m[2];
  record('local-gates', ok, m ? m[0] : 'verify-local-gates did not report a pass count');
}

// --- 3. packaging allow-set (only runtime content ships; #123 leak class) ---
{
  const ls = runShell('npx vsce ls');
  const files = String(ls.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const strays = files.filter((f) => !ALLOW_SET.some((rx) => rx.test(f)));
  const ok = ls.status === 0 && files.length > 0 && strays.length === 0;
  record('vsix-allow-set', ok,
    ok ? `${files.length} files, all within the runtime allow-set`
       : (ls.status !== 0 ? `vsce ls failed: ${lastLine(ls.stderr)}` : `stray non-runtime files: ${strays.join(', ')}`));
}

// --- 4. packaged size (fail closed above the ceiling -- catches a VM-disk/node_modules leak) ---
{
  const pkg = runShell('npx vsce package --out labview-benchmark-actor.vsix');
  const vsixPath = join(root, 'labview-benchmark-actor.vsix');
  if (pkg.status !== 0 || !existsSync(vsixPath)) {
    record('vsix-size', false, `vsce package failed: ${lastLine(pkg.stderr) || lastLine(pkg.stdout)}`);
  } else {
    const bytes = statSync(vsixPath).size;
    record('vsix-size', bytes <= SIZE_CEILING_BYTES,
      `${(bytes / 1024).toFixed(1)} KB (ceiling ${(SIZE_CEILING_BYTES / 1024).toFixed(0)} KB)`);
  }
}

// --- static manifest / Marketplace-listing readiness ---
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// --- 5. icon present + a valid PNG >= 128x128 ---
{
  if (typeof pkg.icon !== 'string' || pkg.icon.length === 0) {
    record('manifest-icon', false, 'package.json has no "icon" (Marketplace shows a placeholder)');
  } else if (!existsSync(join(root, pkg.icon))) {
    record('manifest-icon', false, `icon "${pkg.icon}" is missing on disk`);
  } else {
    const dims = pngDims(join(root, pkg.icon));
    const ok = dims && dims.width >= 128 && dims.height >= 128;
    record('manifest-icon', ok, dims ? `${pkg.icon} ${dims.width}x${dims.height}` : `${pkg.icon} is not a valid PNG`);
  }
}

// --- 6. CHANGELOG present with an entry for this version (or Unreleased) ---
{
  const clPath = join(root, 'CHANGELOG.md');
  if (!existsSync(clPath)) {
    record('manifest-changelog', false, 'no CHANGELOG.md (empty Marketplace Changelog tab)');
  } else {
    const cl = readFileSync(clPath, 'utf8');
    const ok = cl.includes(`## [${pkg.version}]`) || cl.includes('## [Unreleased]');
    record('manifest-changelog', ok, ok ? `has a section for ${pkg.version} or [Unreleased]` : `no "## [${pkg.version}]" / "## [Unreleased]" section`);
  }
}

// --- 7. README is Marketplace-safe (no repo-relative links, which 404 on the listing) ---
{
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const rel = [...readme.matchAll(/\]\(([^)]+)\)/g)]
    .map((m) => m[1].trim())
    .filter((t) => !/^https?:/.test(t) && !t.startsWith('#') && !t.startsWith('mailto:'));
  record('readme-marketplace-safe', rel.length === 0,
    rel.length === 0 ? 'no repo-relative links' : `${rel.length} repo-relative link(s) break on the listing: ${rel.slice(0, 4).join(', ')}${rel.length > 4 ? ' ...' : ''}`);
}

// --- 8. gallery metadata (discoverability + listing quality) ---
{
  const missing = [];
  if (!Array.isArray(pkg.keywords) || pkg.keywords.length === 0) missing.push('keywords');
  if (!Array.isArray(pkg.categories) || pkg.categories.length === 0 || (pkg.categories.length === 1 && pkg.categories[0] === 'Other')) missing.push('categories (beyond "Other")');
  if (!pkg.bugs || !pkg.bugs.url) missing.push('bugs.url');
  if (!pkg.homepage) missing.push('homepage');
  for (const f of ['publisher', 'displayName', 'description']) {
    if (typeof pkg[f] !== 'string' || pkg[f].length === 0) missing.push(f);
  }
  record('manifest-metadata', missing.length === 0, missing.length === 0 ? 'keywords/categories/bugs/homepage/publisher/displayName/description all present' : `missing: ${missing.join(', ')}`);
}

// --- verdict + receipt ---
const failed = checks.filter((c) => !c.pass);
const verdict = failed.length === 0 ? 'PASS' : 'FAIL';
const receipt = {
  schema: 'labview-benchmark-actor/agent-last-gate@v1',
  ranAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  extensionVersion: pkg.version,
  verdict,
  passed: checks.length - failed.length,
  total: checks.length,
  checks,
};
const outDir = join(root, 'experiments', 'agent-last-gate');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);

for (const c of checks) {
  process.stdout.write(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  -- ${c.detail}\n`);
}
process.stdout.write(`\nAGENT LAST GATE: ${verdict} (${receipt.passed}/${receipt.total}) on ${receipt.platform} -- receipt: experiments/agent-last-gate/receipt.json\n`);
if (verdict !== 'PASS') {
  process.stdout.write('The candidate is NOT ready for the human last gate; fix the FAIL checks above.\n');
}
if (emitJson) {
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
process.exit(verdict === 'PASS' ? 0 : 1);
