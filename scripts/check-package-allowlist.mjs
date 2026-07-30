#!/usr/bin/env node
/**
 * #123 durable packaging guard -- the allow-set assertion that supersedes the interim size-only guard in
 * .github/workflows/extension-release.yml.
 *
 * Runs `vsce ls` (the authoritative list of what the .vsix would ship, honoring .vscodeignore) and FAILS
 * CLOSED when any packaged path falls outside the runtime allow-set, or when a supplied built .vsix exceeds
 * the size ceiling. This makes the 14 GB VM-disk leak class un-shippable: if a .vscodeignore regression ever
 * re-admits reviewer-workstation/.vagrant (or node_modules / experiments / tools / docs / src / cleanroom),
 * the extra paths are outside the allow-set and the release fails instead of publishing a fat .vsix.
 *
 * Usage:
 *   node scripts/check-package-allowlist.mjs [path/to/built.vsix]
 * The optional .vsix path adds a hard size ceiling on the actual artifact (the release workflow passes it).
 * Requires the extension compiled (out/ present) and @vscode/vsce installed (a devDependency) -- both hold
 * after `npm ci && npm run package` in the release job.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A real runtime .vsix is ~18 KB; any non-runtime leak blows well past this. */
const MAX_VSIX_BYTES = 1024 * 1024; // 1 MiB

/**
 * The ONLY paths a runtime .vsix may contain. Every `vsce ls` line must match one of these. `vsce` always
 * includes the four special files (package.json, README.md, CHANGELOG.md, LICENSE) plus whatever the
 * .vscodeignore does not exclude -- for this extension that is exactly the compiled `out/**` and the bundled
 * `media/**` (viewer, icon, embedded AGENTS.md, deterministic mprr series).
 */
const ALLOW = [
  /^LICENSE(\.md|\.txt)?$/,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^package\.json$/,
  /^media\/.+$/,
  /^out\/.+$/,
];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`::error::${message}`);
  process.exitCode = 1;
}

/** List what the .vsix would ship, via the pinned local @vscode/vsce (no network reach). */
function vsceList() {
  const bin = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
  const runner = existsSync(bin)
    ? { cmd: bin, args: ['ls'] }
    : { cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['--no-install', 'vsce', 'ls'] };
  const stdout = execFileSync(runner.cmd, runner.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

const files = vsceList();
if (files.length === 0) {
  fail('vsce ls produced no files -- packaging is broken.');
  process.exit(1);
}

const offenders = files.filter((file) => !ALLOW.some((pattern) => pattern.test(file)));
if (offenders.length > 0) {
  fail(
    `.vsix would ship ${offenders.length} path(s) outside the runtime allow-set -- packaging leak (audit .vscodeignore):`,
  );
  for (const offender of offenders) {
    console.error(`    - ${offender}`);
  }
  console.error('  Allow-set: LICENSE, README.md, CHANGELOG.md, package.json, media/**, out/**');
}

const vsixPath = process.argv[2];
if (vsixPath) {
  if (!existsSync(vsixPath)) {
    fail(`expected a built .vsix at '${vsixPath}' for the size-ceiling check.`);
  } else {
    const bytes = statSync(vsixPath).size;
    if (bytes > MAX_VSIX_BYTES) {
      fail(`.vsix is ${bytes} bytes (> ${MAX_VSIX_BYTES}) -- non-runtime content leaked; refusing to release.`);
    } else {
      console.log(`.vsix size OK: ${bytes} bytes (<= ${MAX_VSIX_BYTES}).`);
    }
  }
}

if (process.exitCode === 1) {
  process.exit(1);
}
console.log(
  `packaging allow-set OK: ${files.length} file(s), all within {LICENSE, README.md, CHANGELOG.md, package.json, media/**, out/**}.`,
);
