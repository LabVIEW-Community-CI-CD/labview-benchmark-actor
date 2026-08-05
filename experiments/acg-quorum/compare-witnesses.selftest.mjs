#!/usr/bin/env node
// compare-witnesses.selftest.mjs -- LBA-REQ-024 (ADR-0015). Proves the Actor Corroboration Grid quorum:
// tiered anchors (OS-independent across all witnesses; Linux-only across the Linux subset), graded confidence,
// >=majority concurrence, distinct-environment independence (ADR-0017), and fail-closed on divergence.
import assert from 'node:assert/strict';
import { compareWitnesses } from './compare-witnesses.mjs';

let n = 0;
const ok = (m) => { console.log(`  ok  ${m}`); n++; };

const gate = (verdict = 'pass') => ({ verdict, lbabus: { version: '0.13.0', sourceCommit: 'abc123' } });
const linux = (plane, over = {}) => ({ plane, os: 'linux', gate: gate(), screenshot: { seriesHash: 'S1', pngSha256: 'P-linux' }, ubuntu: 'noble', ...over });
const win = (over = {}) => ({ plane: 'WIN', os: 'windows', gate: gate(), screenshot: { seriesHash: 'S1', pngSha256: 'P-win' }, ...over });

// 1. Full agreement across a heterogeneous 3-witness grid -> pass, confidence 1.0, all concur.
{
  const r = compareWitnesses([linux('CODESPACE'), linux('VBOX'), win()]);
  assert.equal(r.verdict, 'pass'); assert.equal(r.confidence, 1); assert.equal(r.concurring, 3);
  assert.equal(r.crossPlane, true);
  ok('heterogeneous 3-witness full agreement -> pass, confidence 1.0');
}
// 2. WIN is NOT penalized for lacking the Linux-only anchors (pngSha256/ubuntu are N/A for windows).
{
  const r = compareWitnesses([linux('CODESPACE'), linux('VBOX'), win()]);
  assert.ok(!r.divergences.some((d) => d.witness === 'WIN'), 'WIN should have no anchor divergences');
  ok('WIN not penalized for lacking Linux-only anchors');
}
// 3. One Linux witness diverges on a LINUX-ONLY anchor (pngSha256) -> majority still concurs -> pass, confidence < 1.
{
  const r = compareWitnesses([linux('CODESPACE'), linux('VBOX', { screenshot: { seriesHash: 'S1', pngSha256: 'P-DIFF' } }), win()]);
  assert.equal(r.verdict, 'pass'); assert.ok(r.confidence < 1); assert.equal(r.majority, true);
  assert.ok(r.divergences.some((d) => d.anchor === 'pngSha256' && d.witness === 'VBOX'));
  ok('one Linux-only (pngSha256) divergence -> majority pass, confidence < 1, divergence named');
}
// 4. Two witnesses diverge on an OS-INDEPENDENT anchor (seriesHash) -> majority fails -> FAIL CLOSED.
{
  const r = compareWitnesses([
    linux('CODESPACE'),
    linux('VBOX', { screenshot: { seriesHash: 'S-X', pngSha256: 'P-linux' } }),
    win({ screenshot: { seriesHash: 'S-Y', pngSha256: 'P-win' } }),
  ]);
  assert.equal(r.verdict, 'fail'); assert.equal(r.majority, false);
  ok('two OS-independent (seriesHash) divergences -> majority fails -> fail closed');
}
// 5. Independence (ADR-0068): witnesses on the SAME OS-plane -- even DISTINCT linux contexts -- are one plane, not
//    cross-plane, so the quorum fails closed (a linux-only quorum is not corroborated).
{
  const r = compareWitnesses([linux('CODESPACE'), linux('VBOX')]);
  assert.equal(r.crossPlane, false); assert.equal(r.verdict, 'fail');
  ok('distinct linux contexts are one plane (not cross-plane) -> fail closed');
}
// 6. A consensus gate verdict != pass -> fail (a red gate cannot be corroborated to green).
{
  const r = compareWitnesses([linux('CODESPACE', { gate: gate('fail') }), linux('VBOX', { gate: gate('fail') }), win({ gate: gate('fail') })]);
  assert.equal(r.verdict, 'fail'); assert.equal(r.consensusVerdict, 'fail');
  ok('consensus gate verdict=fail -> fail closed');
}
// 7. Fewer than two witnesses -> error (a quorum needs a quorum).
{
  const r = compareWitnesses([linux('CODESPACE')]);
  assert.equal(r.verdict, 'error');
  ok('single witness -> error (no quorum)');
}

console.log(`compare-witnesses self-test: ${n}/${n} PASS`);
