#!/usr/bin/env node
// grid.selftest.mjs -- dependency-free end-to-end self-test for the Actor Corroboration Grid (LBA-REQ-023).
// Proves the umbrella gate: a release is corroborated + released ONLY when independence + quorum + attestation +
// mesh all hold AND a human sign-off accompanies the verdict; any failing stage blocks (fail closed).

import assert from 'node:assert/strict';
import { runGrid } from './grid.mjs';
import { compareWitnesses } from '../acg-quorum/compare-witnesses.mjs';
import { signBundle, generateEnrolledKeypair } from '../acg-provenance/attest.mjs';
import { signReleaseSignOff } from '../acg-reviewer/sign-off.mjs';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };

const mkBundle = (plane, o = {}) => ({
  schema: 'labview-benchmark-actor/acg-witness-bundle-v1',
  plane,
  os: o.os ?? 'linux',
  gate: { verdict: 'pass', lbabus: { version: o.version ?? '0.13.0', sourceCommit: o.sourceCommit ?? 'c0ffee1' } },
  screenshot: { seriesHash: o.seriesHash ?? 'ser-shared', pngSha256: o.png ?? 'png-linux' },
  ubuntu: (o.os ?? 'linux') === 'linux' ? 'noble' : null,
});
const idOf = (plane) => `acg-witness:${plane.toLowerCase()}`;

// Build a standard 3-witness enrolled grid + an approving human sign-off over its quorum verdict.
function buildGrid(bundleOverrides = {}) {
  const planes = ['CODESPACE', 'VBOX', 'WIN'];
  const kp = Object.fromEntries(planes.map((p) => [p, generateEnrolledKeypair()]));
  const bundles = { CODESPACE: mkBundle('CODESPACE'), VBOX: mkBundle('VBOX'), WIN: mkBundle('WIN', { os: 'windows', png: 'png-win' }), ...bundleOverrides };
  const witnesses = planes.map((p) => ({ bundle: bundles[p], attestation: signBundle(bundles[p], { privateKeyPem: kp[p].privateKeyPem, identity: idOf(p) }) }));
  const allowlist = Object.fromEntries(planes.map((p) => [idOf(p), kp[p].publicKeyPem]));
  const enrollment = { environments: [{ plane: 'CODESPACE', os: 'linux' }, { plane: 'VBOX', os: 'linux' }, { plane: 'WIN', os: 'windows' }] };
  const reviewer = generateEnrolledKeypair();
  const reviewerAllowlist = { 'reviewer:alice': reviewer.publicKeyPem };
  const quorum = compareWitnesses(witnesses.map((w) => w.bundle));
  const signOff = signReleaseSignOff(quorum, { privateKeyPem: reviewer.privateKeyPem, reviewer: 'reviewer:alice', station: 'LINUX_CODESPACE', decision: 'approve' });
  return { witnesses, allowlist, enrollment, reviewerAllowlist, signOff };
}

// 1. HAPPY PATH: every stage holds + a human sign-off -> released.
ok('a fully corroborated + signed grid is released', () => {
  const g = buildGrid();
  const r = runGrid({ witnesses: g.witnesses, allowlist: g.allowlist, enrollment: g.enrollment, signOffs: [g.signOff], reviewerAllowlist: g.reviewerAllowlist });
  assert.equal(r.released, true, r.reasons.join('; '));
  assert.equal(r.machineCorroborated, true);
  for (const s of Object.keys(r.stages)) assert.equal(r.stages[s].ok, true, `stage ${s} not ok`);
});

// 2. machineCorroborated but NO human sign-off -> blocked at the human gate.
ok('a corroborated grid with no sign-off is blocked at the human gate', () => {
  const g = buildGrid();
  const r = runGrid({ witnesses: g.witnesses, allowlist: g.allowlist, enrollment: g.enrollment, signOffs: [], reviewerAllowlist: g.reviewerAllowlist });
  assert.equal(r.machineCorroborated, true);
  assert.equal(r.released, false);
  assert.equal(r.stages.humanSignOff.ok, false);
  assert.match(r.reasons.join(' '), /human sign-off/);
});

// 3. N-of-a-kind (two same-environment witnesses) -> independence blocks the machine grid.
ok('an N-of-a-kind witness set is not corroborated', () => {
  const kpA = generateEnrolledKeypair(); const kpB = generateEnrolledKeypair();
  const a = mkBundle('CODESPACE'); const b = mkBundle('CODESPACE', { png: 'png-2' });
  const witnesses = [
    { bundle: a, attestation: signBundle(a, { privateKeyPem: kpA.privateKeyPem, identity: 'acg-witness:codespace' }) },
    { bundle: b, attestation: signBundle(b, { privateKeyPem: kpB.privateKeyPem, identity: 'acg-witness:codespace-2' }) },
  ];
  const allowlist = { 'acg-witness:codespace': kpA.publicKeyPem, 'acg-witness:codespace-2': kpB.publicKeyPem };
  const r = runGrid({ witnesses, allowlist, enrollment: { environments: [{ plane: 'CODESPACE', os: 'linux' }] } });
  assert.equal(r.machineCorroborated, false);
  assert.equal(r.released, false);
  assert.match(r.reasons.join(' '), /independence/);
});

// 4. a sub-majority quorum (three divergent anchors) is not corroborated.
ok('a sub-majority quorum is not corroborated', () => {
  const g = buildGrid({ CODESPACE: mkBundle('CODESPACE', { version: '1' }), VBOX: mkBundle('VBOX', { version: '2' }), WIN: mkBundle('WIN', { os: 'windows', png: 'png-win', version: '3' }) });
  const r = runGrid({ witnesses: g.witnesses, allowlist: g.allowlist, enrollment: g.enrollment, signOffs: [g.signOff], reviewerAllowlist: g.reviewerAllowlist });
  assert.equal(r.stages.quorum.ok, false);
  assert.equal(r.machineCorroborated, false);
  assert.match(r.reasons.join(' '), /quorum/);
});

// 5. a tampered attestation blocks verify-before-consume.
ok('a tampered attestation is not corroborated', () => {
  const g = buildGrid();
  g.witnesses[0].attestation = { ...g.witnesses[0].attestation, signature: Buffer.from('nope').toString('base64') };
  const r = runGrid({ witnesses: g.witnesses, allowlist: g.allowlist, enrollment: g.enrollment, signOffs: [g.signOff], reviewerAllowlist: g.reviewerAllowlist });
  assert.equal(r.stages.attestation.ok, false);
  assert.equal(r.machineCorroborated, false);
  assert.match(r.reasons.join(' '), /attestation/);
});

// 6. the mesh stage re-derives the same quorum in the happy path.
ok('the mesh stage re-derives the quorum', () => {
  const g = buildGrid();
  const r = runGrid({ witnesses: g.witnesses, allowlist: g.allowlist, enrollment: g.enrollment, signOffs: [g.signOff], reviewerAllowlist: g.reviewerAllowlist });
  assert.equal(r.stages.mesh.ok, true);
  assert.match(r.stages.mesh.ledgerHash, /^[0-9a-f]{64}$/);
});

console.log(`grid self-test: ${pass}/${pass} PASS`);
