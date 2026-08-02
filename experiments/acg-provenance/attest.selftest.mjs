#!/usr/bin/env node
// attest.selftest.mjs -- dependency-free self-test for the ACG provenance + attestation engine (LBA-REQ-025).
// Proves witness attestations sign/verify, FAIL CLOSED on tamper / un-enrolled identity / rogue key / bad
// signature, and that verify-before-consume blocks a release unless every attestation verifies, the witnesses
// are distinct enrolled identities, AND the quorum re-computed over the attested bundles passes.

import assert from 'node:assert/strict';
import { generateEnrolledKeypair, signBundle, verifyWitnessAttestation, verifyBeforeConsume, bundleDigest, canonicalize } from './attest.mjs';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };

const mkBundle = (plane, o = {}) => ({
  schema: 'labview-benchmark-actor/acg-witness-bundle-v1',
  plane,
  os: o.os ?? 'linux',
  gate: { verdict: o.verdict ?? 'pass', lbabus: { version: o.version ?? '0.13.0', sourceCommit: o.sourceCommit ?? 'c0ffee1' } },
  screenshot: { seriesHash: o.seriesHash ?? 'ser-shared', pngSha256: o.pngSha256 ?? 'png-linux' },
  ubuntu: (o.os ?? 'linux') === 'linux' ? (o.ubuntu ?? 'noble') : null,
});

// Enroll two distinct witness identities.
const codespaceKp = generateEnrolledKeypair();
const hostKp = generateEnrolledKeypair();
const allowlist = { 'witness:codespace': codespaceKp.publicKeyPem, 'witness:host': hostKp.publicKeyPem };

// 1. sign -> verify roundtrip.
ok('sign then verify a witness attestation', () => {
  const b = mkBundle('CODESPACE');
  const att = signBundle(b, { privateKeyPem: codespaceKp.privateKeyPem, identity: 'witness:codespace' });
  assert.equal(att.schema, 'labview-benchmark-actor/acg-witness-attestation-v1');
  assert.equal(att.subject.digest, bundleDigest(b));
  const r = verifyWitnessAttestation(b, att, { allowlist });
  assert.equal(r.ok, true, r.reasons.join('; '));
});

// 2. a tampered bundle fails (the digest no longer matches).
ok('tampered bundle fails verification', () => {
  const b = mkBundle('CODESPACE');
  const att = signBundle(b, { privateKeyPem: codespaceKp.privateKeyPem, identity: 'witness:codespace' });
  const tampered = { ...b, gate: { ...b.gate, verdict: 'fail' } };
  const r = verifyWitnessAttestation(tampered, att, { allowlist });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /subject digest does not match/);
});

// 3. an un-enrolled identity fails.
ok('un-enrolled identity fails', () => {
  const b = mkBundle('ROGUE');
  const rogue = generateEnrolledKeypair();
  const att = signBundle(b, { privateKeyPem: rogue.privateKeyPem, identity: 'witness:rogue' });
  const r = verifyWitnessAttestation(b, att, { allowlist });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /not enrolled/);
});

// 4. an enrolled identity presented with a rogue key fails (key does not match the enrolled one).
ok('enrolled identity with a rogue key fails', () => {
  const b = mkBundle('CODESPACE');
  const impostor = generateEnrolledKeypair();
  const att = signBundle(b, { privateKeyPem: impostor.privateKeyPem, identity: 'witness:codespace' });
  const r = verifyWitnessAttestation(b, att, { allowlist });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /does not match the enrolled key/);
});

// 5. a corrupted signature fails.
ok('corrupted signature fails', () => {
  const b = mkBundle('CODESPACE');
  const att = signBundle(b, { privateKeyPem: codespaceKp.privateKeyPem, identity: 'witness:codespace' });
  const bad = { ...att, signature: Buffer.from('not-the-signature').toString('base64') };
  const r = verifyWitnessAttestation(b, bad, { allowlist });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /signature does not verify/);
});

// 6. verify-before-consume: two distinct enrolled, attested, corroborating witnesses -> consumable.
ok('verify-before-consume passes for a fully attested corroborating grid', () => {
  const cs = mkBundle('CODESPACE', { ubuntu: 'noble' });
  const host = mkBundle('HOST', { ubuntu: 'noble' });
  const witnesses = [
    { bundle: cs, attestation: signBundle(cs, { privateKeyPem: codespaceKp.privateKeyPem, identity: 'witness:codespace' }) },
    { bundle: host, attestation: signBundle(host, { privateKeyPem: hostKp.privateKeyPem, identity: 'witness:host' }) },
  ];
  const d = verifyBeforeConsume({ witnesses, allowlist });
  assert.equal(d.consume, true, d.reasons.join('; '));
  assert.equal(d.verdict.verdict, 'pass');
});

// 7. verify-before-consume rejects N-of-a-kind (the same identity signing two "witnesses").
ok('verify-before-consume rejects N-of-a-kind identities', () => {
  const a = mkBundle('CODESPACE');
  const b = mkBundle('CODESPACE-2');
  const witnesses = [
    { bundle: a, attestation: signBundle(a, { privateKeyPem: codespaceKp.privateKeyPem, identity: 'witness:codespace' }) },
    { bundle: b, attestation: signBundle(b, { privateKeyPem: codespaceKp.privateKeyPem, identity: 'witness:codespace' }) },
  ];
  const d = verifyBeforeConsume({ witnesses, allowlist });
  assert.equal(d.consume, false);
  assert.match(d.reasons.join(' '), /not distinct \(N-of-a-kind\)/);
});

// 8. verify-before-consume blocks when the re-computed quorum does not pass (bundles diverge on a release anchor).
ok('verify-before-consume blocks a non-pass corroboration', () => {
  const cs = mkBundle('CODESPACE', { sourceCommit: 'aaaaaaa' });
  const host = mkBundle('HOST', { sourceCommit: 'bbbbbbb' }); // divergent OS-independent anchor
  const witnesses = [
    { bundle: cs, attestation: signBundle(cs, { privateKeyPem: codespaceKp.privateKeyPem, identity: 'witness:codespace' }) },
    { bundle: host, attestation: signBundle(host, { privateKeyPem: hostKp.privateKeyPem, identity: 'witness:host' }) },
  ];
  const d = verifyBeforeConsume({ witnesses, allowlist });
  assert.equal(d.consume, false);
  assert.match(d.reasons.join(' '), /verdict is fail, not pass/);
});

// 9. verify-before-consume blocks when one witness bundle is tampered after signing.
ok('verify-before-consume blocks a tampered witness', () => {
  const cs = mkBundle('CODESPACE');
  const host = mkBundle('HOST');
  const csAtt = signBundle(cs, { privateKeyPem: codespaceKp.privateKeyPem, identity: 'witness:codespace' });
  const witnesses = [
    { bundle: { ...cs, gate: { ...cs.gate, lbabus: { ...cs.gate.lbabus, version: '9.9.9' } } }, attestation: csAtt },
    { bundle: host, attestation: signBundle(host, { privateKeyPem: hostKp.privateKeyPem, identity: 'witness:host' }) },
  ];
  const d = verifyBeforeConsume({ witnesses, allowlist });
  assert.equal(d.consume, false);
  assert.match(d.reasons.join(' '), /subject digest does not match/);
});

// 10. canonicalization is key-order-independent (the digest is stable regardless of insertion order).
ok('canonicalize is deterministic regardless of key order', () => {
  const x = { b: 1, a: { d: 4, c: 3 } };
  const y = { a: { c: 3, d: 4 }, b: 1 };
  assert.equal(canonicalize(x), canonicalize(y));
  assert.equal(bundleDigest(x), bundleDigest(y));
});

console.log(`attest self-test: ${pass}/${pass} PASS`);
