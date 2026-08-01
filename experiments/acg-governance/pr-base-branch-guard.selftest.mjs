#!/usr/bin/env node
// pr-base-branch-guard.selftest.mjs -- dependency-free self-test for the PR base-branch policy (LBA-REQ-030).
// Encodes the corrected GitFlow rule: every non-release PR targets develop; main NEVER takes develop directly --
// only release/* and hotfix/* target main (and they also merge back into develop).

import assert from 'node:assert/strict';
import { evaluateBasePolicy } from './pr-base-branch-guard.mjs';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };
const allowed = (base, head) => evaluateBasePolicy(base, head).allowed;

// Non-release work targets develop -> allowed.
ok('feature -> develop is allowed', () => assert.equal(allowed('develop', 'linux/acg-p2-foo'), true));
ok('authoring -> develop is allowed', () => assert.equal(allowed('develop', 'authoring/dqmh'), true));

// The release lane targets main -> allowed.
ok('release/* -> main is allowed', () => assert.equal(allowed('main', 'release/1.2.0'), true));
ok('hotfix/* -> main is allowed', () => assert.equal(allowed('main', 'hotfix/urgent'), true));

// main NEVER takes develop directly, nor feature work.
ok('develop -> main is BLOCKED', () => {
  const r = evaluateBasePolicy('main', 'develop');
  assert.equal(r.allowed, false);
  assert.match(r.reason, /develop.*must not merge directly into main/);
});
ok('feature -> main is BLOCKED', () => {
  const r = evaluateBasePolicy('main', 'linux/some-feature');
  assert.equal(r.allowed, false);
  assert.match(r.reason, /must target develop, not main/);
});
ok('an unknown head -> main is BLOCKED', () => assert.equal(allowed('main', ''), false));

// develop AND main both take release/hotfix (develop side).
ok('release/* -> develop is allowed', () => assert.equal(allowed('develop', 'release/1.2.0'), true));
ok('hotfix/* -> develop is allowed', () => assert.equal(allowed('develop', 'hotfix/urgent'), true));

// Ref normalization + a missing base.
ok('refs/heads/ prefixes are normalized', () => {
  assert.equal(allowed('refs/heads/main', 'refs/heads/release/9.9.9'), true);
  assert.equal(allowed('refs/heads/main', 'refs/heads/develop'), false);
});
ok('a missing base is blocked', () => assert.equal(allowed('', 'develop'), false));

console.log(`pr-base-branch-guard self-test: ${pass}/${pass} PASS`);
