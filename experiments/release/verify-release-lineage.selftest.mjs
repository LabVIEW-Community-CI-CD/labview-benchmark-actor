#!/usr/bin/env node
// Self-test for the release-lineage guard (#417, LBA-REQ-016). Pure + offline: proves a fully-shared lineage
// passes and every divergence (a tag not in develop -- the 1.1.1 defect -- or not in main) fails closed with an
// actionable reason. Also proves the live probe maps an injected git's ancestry answers into the verdict.
// Gated by `release-lineage`. Run: `node experiments/release/verify-release-lineage.selftest.mjs`.

import assert from 'node:assert/strict';
import { computeLineage, probeLineage } from './verify-release-lineage.mjs';

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. HAPPY PATH: every release tag is an ancestor of both main and develop.
ok('a fully-shared lineage passes', () => {
  const r = computeLineage({ releases: [
    { tag: 'ext-v1.0.0', inMain: true, inDevelop: true },
    { tag: 'ext-v1.1.0', inMain: true, inDevelop: true },
    { tag: 'ext-v1.1.1', inMain: true, inDevelop: true },
  ] });
  assert.equal(r.ok, true);
  assert.equal(r.divergent.length, 0);
  assert.deepEqual(r.shared, ['ext-v1.0.0', 'ext-v1.1.0', 'ext-v1.1.1']);
});

// 2. FAIL-CLOSED: a tag in main but NOT develop (the exact 1.1.1 divergence) is caught with a back-merge hint.
ok('a tag in main but not develop fails closed (the 1.1.1 divergence)', () => {
  const r = computeLineage({ releases: [
    { tag: 'ext-v1.1.0', inMain: true, inDevelop: true },
    { tag: 'ext-v1.1.1', inMain: true, inDevelop: false },
  ] });
  assert.equal(r.ok, false);
  assert.equal(r.divergent.length, 1);
  assert.equal(r.divergent[0].tag, 'ext-v1.1.1');
  assert.ok(/not an ancestor of develop/.test(r.divergent[0].reason) && /back-merge/.test(r.divergent[0].reason));
});

// 3. FAIL-CLOSED: a tag in develop but not main (never merged to main) is caught.
ok('a tag not in main fails closed', () => {
  const r = computeLineage({ releases: [{ tag: 'ext-v2.0.0', inMain: false, inDevelop: true }] });
  assert.equal(r.ok, false);
  assert.ok(/not an ancestor of main/.test(r.divergent[0].reason));
});

// 4. an empty release set is vacuously shared (no tags -> no divergence).
ok('an empty release set is ok', () => {
  assert.equal(computeLineage({ releases: [] }).ok, true);
  assert.equal(computeLineage({}).ok, true);
});

// 5. probeLineage maps an injected git's ancestry answers into per-tag facts (live leg logic, offline).
ok('probeLineage maps injected git ancestry into per-tag facts', () => {
  // Fake git: two tags; ext-v1.1.1 is an ancestor of main but NOT develop.
  const git = (args) => {
    if (args[0] === 'tag') return 'ext-v1.1.0\next-v1.1.1\n';
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      const [, , tag, ref] = args;
      const ancestor = (tag === 'ext-v1.1.0') || (tag === 'ext-v1.1.1' && ref === 'origin/main');
      if (!ancestor) throw new Error('not an ancestor');
      return '';
    }
    return '';
  };
  const releases = probeLineage({ git });
  const v = computeLineage({ releases });
  assert.equal(releases.length, 2);
  assert.equal(v.ok, false);
  assert.equal(v.divergent[0].tag, 'ext-v1.1.1');
  assert.equal(v.divergent[0].inMain, true);
  assert.equal(v.divergent[0].inDevelop, false);
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# verify-release-lineage selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
