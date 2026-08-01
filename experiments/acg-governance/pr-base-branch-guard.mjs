#!/usr/bin/env node
// pr-base-branch-guard.mjs -- ACG governance: PRs target develop, not main (ADR-0021, LBA-REQ-030).
//
// GitFlow (ADR-0010) makes `develop` the integration branch and `main` a protected release branch. Stale
// main-based pull requests (#211 / #215 / #217) once dumped integration content onto main because nothing
// mechanically stated where feature work targets. This is the automated PR-base check: a pull request that
// targets `main` is allowed ONLY when its head is a release-lane source (`develop`, `release/*`, `hotfix/*`);
// any other head targeting `main` is BLOCKED and must re-target `develop`. Dependency-free (Node builtins only).

const stripRef = (r) => String(r || '').replace(/^refs\/heads\//, '').trim();
const RELEASE_HEAD_PATTERNS = [/^release\//i, /^hotfix\//i];

// Evaluate the base-branch policy for a pull request from `headRef` into `baseRef`.
export function evaluateBasePolicy(baseRef, headRef) {
  const base = stripRef(baseRef);
  const head = stripRef(headRef);
  if (!base) return { allowed: false, base, head, reason: 'no base branch provided' };
  if (base !== 'main') {
    return { allowed: true, base, head, reason: `base '${base}' is not the protected release branch; non-release work belongs here` };
  }
  // base === 'main': ONLY release/* and hotfix/* may target main, via --no-ff (ADR-0010). main NEVER takes develop
  // directly -- a release branch is cut from develop and merged into main (and back into develop); develop and main
  // both receive release/hotfix, but develop itself never merges straight into main.
  const isReleaseSource = RELEASE_HEAD_PATTERNS.some((re) => re.test(head));
  if (isReleaseSource) return { allowed: true, base, head, reason: `release-lane head '${head}' may target main via --no-ff` };
  const guidance = head === 'develop'
    ? `'develop' must not merge directly into main -- cut a release/* branch from develop`
    : `non-release pull request from '${head || '(unknown head)'}' must target develop, not main`;
  return { allowed: false, base, head, reason: `${guidance}; only release/* and hotfix/* target main (ADR-0021)` };
}

// CLI: pr-base-branch-guard.mjs [<baseRef> <headRef>]  (falls back to GITHUB_BASE_REF / GITHUB_HEAD_REF).
// Exits 0 when the base is allowed, 1 (with a GitHub ::error:: annotation) when it is blocked.
if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2] || process.env.GITHUB_BASE_REF || '';
  const head = process.argv[3] || process.env.GITHUB_HEAD_REF || '';
  const r = evaluateBasePolicy(base, head);
  console.log(`${r.allowed ? 'OK' : 'BLOCKED'} [${r.head || '?'} -> ${r.base || '?'}]: ${r.reason}`);
  if (!r.allowed) {
    console.error(`::error title=PR base-branch policy (ADR-0021)::${r.reason}`);
    process.exit(1);
  }
}
