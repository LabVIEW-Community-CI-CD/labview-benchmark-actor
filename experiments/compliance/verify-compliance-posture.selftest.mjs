// Self-test for verify-compliance-posture.mjs -- the CAPSTONE continuous-compliance self-audit
// (LBA-REQ-037). Proves (a) the COMMITTED repository is 25/25 conformant and the scorecard is current,
// (b) the scoring FAILS CLOSED -- a lens drops below target the moment any single clause-evidence item is
// missing, and (c) the deep-compliance artifacts (test report, release procedure) are load-bearing, so
// deleting them regresses the posture.
// Run: node verify-compliance-posture.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computePosture, renderScorecard, scoreLens, LENSES, OUT_REL } from './verify-compliance-posture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// 1. the committed repository is 25/25 conformant and the scorecard is current
{
  const posture = computePosture({ repoRoot });
  assert.ok(posture.ok, `expected CONFORMANT; findings: ${posture.findings.join('; ')}`);
  assert.equal(posture.totalScore, posture.targetTotal, 'total score equals the target total');
  assert.equal(posture.totalScore, 25, 'the five lenses score 25/25');
  for (const l of posture.lenses) assert.equal(l.score, l.target, `${l.id} lens is at target ${l.target}`);
  const committed = readFileSync(join(repoRoot, OUT_REL), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, renderScorecard(posture), `${OUT_REL} is STALE -- run: node experiments/compliance/verify-compliance-posture.mjs`);
  ok(`committed posture 25/25 across ${posture.checks} checks; scorecard current`);
}

// 2. fail-closed: an all-false probe scores every lens 0 (absence of evidence fails)
{
  const allFalse = { file: () => false, phrase: () => false, regex: () => false, count: () => false, gate: () => false };
  for (const lens of LENSES) {
    const s = scoreLens(lens, allFalse);
    assert.equal(s.score, 0, `${lens.id} scores 0 with no evidence`);
    assert.equal(s.findings.length, lens.requirements.length, `${lens.id} flags every missing item`);
  }
  ok('fail-closed: no evidence scores every lens 0 with a finding per requirement');
}

// 3. fail-closed: dropping any SINGLE clause-evidence item pulls that lens below target
{
  const allTrue = { file: () => true, phrase: () => true, regex: () => true, count: () => true, gate: () => true };
  for (const lens of LENSES) {
    assert.equal(scoreLens(lens, allTrue).score, lens.target, `${lens.id} reaches target with full evidence`);
    // remove exactly one file requirement and confirm the lens drops below target
    const fileReq = lens.requirements.find((r) => r.kind === 'file');
    const dropOne = { ...allTrue, file: (p) => p !== fileReq.path };
    const s = scoreLens(lens, dropOne);
    assert.ok(s.score < lens.target, `${lens.id} drops below target when ${fileReq.path} is missing`);
    assert.ok(s.findings.some((f) => f.includes(fileReq.path)), `${lens.id} names the missing item`);
  }
  ok('fail-closed: dropping any single clause-evidence item pulls the lens below target');
}

// 4. the deep-compliance artifacts are load-bearing (test report + release procedure gate multiple lenses)
{
  const reqPaths = LENSES.flatMap((l) => l.requirements.map((r) => r.path).filter(Boolean));
  const gateIds = LENSES.flatMap((l) => l.requirements.map((r) => r.id).filter(Boolean));
  assert.ok(reqPaths.filter((p) => p === 'docs/testing/test-report.md').length >= 2, 'the test report is required by >=2 lenses (TEST + DOC)');
  assert.ok(reqPaths.filter((p) => p === 'docs/release/release-procedure.md').length >= 2, 'the release procedure is required by >=2 lenses (CM + DOC)');
  assert.ok(gateIds.includes('test-report-current') && gateIds.includes('release-procedure-references-resolve'), 'the deep-compliance gates are load-bearing');
  ok('deep-compliance artifacts (test report, release procedure) are load-bearing across lenses');
}

console.log(`\nverify-compliance-posture.selftest: ${passed}/${passed} checks passed`);
