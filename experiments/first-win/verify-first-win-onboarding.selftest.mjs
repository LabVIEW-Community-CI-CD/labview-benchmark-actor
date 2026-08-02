#!/usr/bin/env node
// Self-test for firstWinOnboarding.mjs (LBA-REQ-033, realizes ADR-0023 Phase 1). Proves the roadmap's First
// Win is COVERED: the committed receipt composes all six flow steps to real, Proven, on-disk realizations and
// records the live lba-golden demonstration (activation confirmed). Fails closed if a realization is missing,
// activation was not confirmed, the completeness verdict is forged, or the digest is tampered. Pure -- no VM.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFirstWinReceipt, validateFirstWinReceipt, digestFirstWinReceipt,
  analyzeFlow, FIRST_WIN_SCHEMA, FIRST_WIN_STEPS,
} from './firstWinOnboarding.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const realExists = (rel) => existsSync(join(repoRoot, rel));
const committed = JSON.parse(readFileSync(join(here, 'fixtures', 'first-win-onboarding-receipt.json'), 'utf8'));

let n = 0;
const ok = (m) => { n++; console.log(`ok ${n} - ${m}`); };

// 1. the committed receipt validates against the real repo and the flow is complete
{
  const v = validateFirstWinReceipt(committed, realExists);
  assert.ok(v.ok && v.complete, `committed receipt must validate + be complete: ${v.findings.join('; ')}`);
  assert.equal(committed.schema, FIRST_WIN_SCHEMA, 'schema is first-win-onboarding@1');
  assert.equal(committed.requirement, 'LBA-REQ-033', 'covers LBA-REQ-033');
  assert.equal(committed.steps.length, FIRST_WIN_STEPS.length, 'all flow steps present');
  ok('committed first-win receipt validates against the repo; flow complete (6/6 steps + activation confirmed live)');
}

// 2. deterministic + current: a rebuild from the real repo + committed live evidence reproduces the digest
{
  const rebuilt = buildFirstWinReceipt({ existsFn: realExists, liveEvidence: committed.liveEvidence });
  assert.equal(rebuilt.digest, committed.digest, 'fixture is stale -- regenerate if the flow or live evidence changed');
  ok('receipt is deterministic + current (stable digest from the real repo)');
}

// 3. every flow step resolves on disk and maps to a requirement
{
  const a = analyzeFlow(realExists);
  assert.ok(a.allResolved, `every realization must resolve; missing: ${a.missing.join(', ')}`);
  assert.ok(a.steps.every((s) => /^LBA-REQ-\d+$/.test(s.provenReq)), 'every step cites a requirement');
  ok('every flow step resolves to a committed realization mapped to a requirement');
}

const hide = (path) => (rel) => (rel === path ? false : realExists(rel));

// 4. FAIL CLOSED: a slice realization is missing (deleted)
{
  const noProbe = hide('experiments/activation/probe-activation.sh');
  const a = analyzeFlow(noProbe);
  assert.ok(!a.allResolved && a.missing.includes('experiments/activation/probe-activation.sh'), 'hiding the probe -> unresolved');
  const v = validateFirstWinReceipt(committed, noProbe);
  assert.ok(!v.ok, 'the committed complete receipt must FAIL when a flow realization is missing');
  ok('fail-closed: a missing flow realization is caught');
}

// 5. FAIL CLOSED: activation was not confirmed
{
  const unconfirmed = buildFirstWinReceipt({ existsFn: realExists, liveEvidence: { ...committed.liveEvidence, activationConfirmed: false } });
  assert.equal(unconfirmed.verdict.complete, false, 'no confirmed activation -> not complete');
  const v = validateFirstWinReceipt(unconfirmed, realExists);
  assert.ok(!v.ok, 'a receipt without a confirmed activation must FAIL');
  ok('fail-closed: an unconfirmed activation is rejected');
}

// 6. FAIL CLOSED: a forged complete verdict while a realization is missing (resealed digest)
{
  const noReg = hide('experiments/activation/registerMeshActor.mjs');
  const forged = buildFirstWinReceipt({ existsFn: noReg, liveEvidence: committed.liveEvidence }); // honest: complete=false
  forged.verdict.complete = true;              // forge the verdict
  forged.steps = committed.steps;              // claim all steps resolved
  forged.digest = digestFirstWinReceipt(forged); // re-seal to hide it
  const v = validateFirstWinReceipt(forged, noReg);
  assert.ok(!v.ok, 'a forged completeness verdict must be rejected when a realization is missing');
  ok('fail-closed: a forged completeness verdict (with a resealed digest) is rejected');
}

// 7. FAIL CLOSED: a tampered digest
{
  const tampered = { ...committed, digest: '0'.repeat(64) };
  const v = validateFirstWinReceipt(tampered, realExists);
  assert.ok(!v.ok && v.findings.some((f) => /digest/.test(f)), 'a tampered digest must be rejected');
  ok('fail-closed: a tampered digest is rejected');
}

console.log(`\n# first-win-onboarding self-test: ${n}/${n} passed`);
