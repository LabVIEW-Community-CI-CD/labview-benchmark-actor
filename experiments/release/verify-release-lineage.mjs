#!/usr/bin/env node
// verify-release-lineage.mjs -- release-lineage guard (#417, LBA-REQ-016 / ADR-0010 GitFlow branch governance).
//
// Every ext-v* release tag must be an ancestor of BOTH main and develop. A release/X.Y.Z merges to main (--no-ff)
// AND back-merges to develop (--no-ff), so main and develop SHARE the release commit. If a back-merge is squashed
// or re-applies content, main and develop diverge in HISTORY (even when their content converges) -- and the NEXT
// release/* (cut from develop) 3-way-conflicts with main's seal commits (composite receipt, release-agreement,
// package.json, CHANGELOG, the version refs in verify-local-gates + the reseal selftest). This bit 1.1.0 AND 1.1.1.
//
// `computeLineage` is a PURE verdict over per-tag ancestry facts; `--check` probes live git and fails closed on any
// divergent tag. Run `--check` after a release (and before cutting the next release/*) to catch a divergent
// back-merge early; the pure verdict is gated by `release-lineage`.

import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Pure: given [{ tag, inMain, inDevelop }], the lineage is SHARED iff every release tag is an ancestor of BOTH.
// Returns { ok, shared:[tag], divergent:[{tag,inMain,inDevelop,reason}] } -- fail-closed (ok=false) on any divergence.
export function computeLineage({ releases = [] } = {}) {
  const divergent = releases
    .filter((r) => !(r.inMain && r.inDevelop))
    .map((r) => ({
      tag: r.tag,
      inMain: !!r.inMain,
      inDevelop: !!r.inDevelop,
      reason: !r.inMain
        ? 'not an ancestor of main (release was never merged to main)'
        : 'not an ancestor of develop (divergent/squashed back-merge -- back-merge the release branch --no-ff so main and develop share the release commit)',
    }));
  return {
    ok: divergent.length === 0,
    shared: releases.filter((r) => r.inMain && r.inDevelop).map((r) => r.tag),
    divergent,
  };
}

// Live leg: probe git for every ext-v* tag's ancestry vs main + develop. `git` is injectable for testing.
export function probeLineage({ mainRef = 'origin/main', developRef = 'origin/develop', git = defaultGit } = {}) {
  const tags = git(['tag', '-l', 'ext-v*']).split('\n').map((s) => s.trim()).filter(Boolean).sort();
  return tags.map((tag) => ({ tag, inMain: isAncestor(git, tag, mainRef), inDevelop: isAncestor(git, tag, developRef) }));
}
function defaultGit(args) { return execFileSync('git', args, { encoding: 'utf8' }); }
function isAncestor(git, tag, ref) {
  try { git(['merge-base', '--is-ancestor', tag, ref]); return true; } catch { return false; }
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes('--check')) {
    console.error('usage: verify-release-lineage.mjs --check [--main <ref>] [--develop <ref>]');
    process.exit(2);
  }
  const mi = argv.indexOf('--main');
  const di = argv.indexOf('--develop');
  const mainRef = mi >= 0 ? argv[mi + 1] : 'origin/main';
  const developRef = di >= 0 ? argv[di + 1] : 'origin/develop';
  const releases = probeLineage({ mainRef, developRef });
  for (const t of releases) console.log(`  ${t.inMain && t.inDevelop ? '\u2713' : '\u2717'} ${t.tag}  main=${t.inMain} develop=${t.inDevelop}`);
  const r = computeLineage({ releases });
  if (!r.ok) {
    console.error(`\n\u2717 ${r.divergent.length} release tag(s) diverge (main != develop):`);
    for (const d of r.divergent) console.error(`  - ${d.tag}: ${d.reason}`);
    console.error('\nreconcile: back-merge main into develop (--no-ff, or -s ours when develop already carries the content) so the release tag is an ancestor of BOTH.');
    process.exit(1);
  }
  console.log(`\n\u2713 all ${releases.length} release tag(s) are shared by ${mainRef} + ${developRef} (no divergence)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
