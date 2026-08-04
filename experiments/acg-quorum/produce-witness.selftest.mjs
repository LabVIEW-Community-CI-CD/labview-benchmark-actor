#!/usr/bin/env node
// produce-witness.selftest.mjs -- proves the plane witness producer + cross-plane corroboration (LBA-REQ-087,
// ADR-0069). A witness carries the deterministic anchors (version/sourceCommit/verdict/seriesHash); a LINUX plane
// and a WINDOWS plane with the SAME anchors CROSS-PLANE corroborate (ADR-0068); a divergent, non-pass, or
// same-plane pair fails closed. Dependency-free.
import assert from 'node:assert/strict';
import { produceWitness, deterministicSeriesHash } from './produce-witness.mjs';
import { corroboratePlanes } from './corroborate-planes.mjs';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };

const COMMIT = 'a'.repeat(40);
// produceWitness computes the OS of the CURRENT plane; we simulate the OTHER plane by cloning + flipping os (in
// CI each plane genuinely produces its own -- here we prove the corroboration LOGIC deterministically).
const here = produceWitness({ plane: 'TEST-HERE', verdict: 'pass', version: '9.9.9', sourceCommit: COMMIT });
const other = (os, over = {}) => ({ ...JSON.parse(JSON.stringify(here)), plane: `TEST-${os}`, os, ubuntu: os === 'linux' ? 'noble' : null, ...over });

ok('a produced witness carries the deterministic corroboration anchors', () => {
  assert.equal(here.schema, 'labview-benchmark-actor/acg-witness-bundle-v1');
  assert.equal(here.gate.verdict, 'pass');
  assert.equal(here.gate.lbabus.version, '9.9.9');
  assert.equal(here.gate.lbabus.sourceCommit, COMMIT);
  assert.equal(here.screenshot.seriesHash, deterministicSeriesHash());
  assert.ok(['linux', 'windows', 'macos'].includes(here.os));
});

ok('a linux + windows plane with the same anchors CROSS-PLANE corroborate', () => {
  const { ok: cok, verdict } = corroboratePlanes([other('linux'), other('windows')]);
  assert.equal(cok, true, JSON.stringify(verdict.divergences));
  assert.equal(verdict.crossPlane, true);
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.divergences.length, 0);
});

ok('two SAME-plane witnesses (both linux) do NOT corroborate (single plane)', () => {
  const { ok: cok, verdict } = corroboratePlanes([other('linux', { plane: 'L1' }), other('linux', { plane: 'L2' })]);
  assert.equal(cok, false);
  assert.equal(verdict.crossPlane, false);
});

ok('a divergent anchor (different seriesHash) fails closed', () => {
  const win = other('windows', { screenshot: { seriesHash: 'DIFFERENT', pngSha256: null } });
  const { ok: cok } = corroboratePlanes([other('linux'), win]);
  assert.equal(cok, false);
});

ok('a non-pass gate verdict fails closed', () => {
  const g = { verdict: 'fail', lbabus: here.gate.lbabus };
  const { ok: cok } = corroboratePlanes([other('linux', { gate: g }), other('windows', { gate: g })]);
  assert.equal(cok, false);
});

console.log(`produce-witness self-test: ${pass}/${pass} PASS`);
