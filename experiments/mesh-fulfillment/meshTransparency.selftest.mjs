#!/usr/bin/env node
// Self-test for transparency-logging the verified-tier attestations (LBA-REQ-078 / ADR-0059). Pure + offline:
// proves the committed logged collection re-verifies its signed tree head + every inclusion proof, a fresh
// round-trip verifies, and every fail-closed guard fires (wrong log key, missing inclusion, tampered proof,
// verified-binding mismatch, tampered digest). Gated by `mesh-attestations-transparency-logged`.
// Run: `node experiments/mesh-fulfillment/meshTransparency.selftest.mjs`.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateEnrolledKeypair } from '../acg-transparency/transparency-log.mjs';
import { buildLoggedCollection, validateLoggedCollection, LOGGED_COLLECTION_SCHEMA, REQUIREMENT } from './meshTransparency.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
const tasking = read('mesh-run-tasking.json');
const collection = read('mesh-run-collection.json');
const verified = read('mesh-run-verified-collection.json');
const enrolledKeys = read('mesh-actor-keys.json').enrolled;
const committedLogged = read('mesh-run-logged-collection.json');
const committedLogKey = read('mesh-log-key.json').publicKeyPem;
const clone = (o) => JSON.parse(JSON.stringify(o));

// Mint a fresh log keypair + record the committed verified collection's attestations (for round-trip + mutation).
function freshLogged() {
  const kp = generateEnrolledKeypair();
  const logPublicKeyPem = crypto.createPublicKey(kp.privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
  const logged = buildLoggedCollection({ verified, privateKeyPem: kp.privateKeyPem, logIdentity: 'test-log', timestamp: '2026-08-03T00:00:00.000Z' });
  return { logged, logPublicKeyPem };
}
const args = (logged, logPublicKeyPem) => ({ verified, collection, tasking, enrolledKeys, logPublicKeyPem });

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. the COMMITTED logged collection re-verifies (signed tree head + every inclusion proof).
ok('committed logged collection re-verifies', () => {
  const r = validateLoggedCollection(committedLogged, { verified, collection, tasking, enrolledKeys, logPublicKeyPem: committedLogKey });
  assert.equal(r.ok, true, `committed should verify: ${r.findings.join('; ')}`);
  assert.equal(committedLogged.schema, LOGGED_COLLECTION_SCHEMA);
  assert.equal(committedLogged.requirement, REQUIREMENT);
  assert.equal(committedLogged.signedTreeHead.size, verified.attestations.length, 'the tree logs every attestation');
});

// 2. a fresh round-trip (mint log key -> record -> verify) validates.
ok('fresh transparency-log round-trip verifies', () => {
  const { logged, logPublicKeyPem } = freshLogged();
  assert.equal(validateLoggedCollection(logged, args(logged, logPublicKeyPem)).ok, true);
});

// 3. FAIL-CLOSED: the signed tree head is verified against the WRONG log key.
ok('rejects a tree head signed by the wrong log key', () => {
  const { logged } = freshLogged();
  const rogue = generateEnrolledKeypair();
  const roguePub = crypto.createPublicKey(rogue.privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
  const r = validateLoggedCollection(logged, { verified, collection, tasking, enrolledKeys, logPublicKeyPem: roguePub });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /tree head/.test(f)));
});

// 4. FAIL-CLOSED: an attestation with no inclusion proof.
ok('rejects a missing inclusion proof', () => {
  const { logged, logPublicKeyPem } = freshLogged();
  logged.inclusions = logged.inclusions.slice(0, 1); // drop one inclusion
  logged.digest = undefined;
  assert.equal(validateLoggedCollection(logged, args(logged, logPublicKeyPem)).ok, false);
});

// 5. FAIL-CLOSED: a tampered inclusion proof (does not reconstruct the signed root).
ok('rejects a tampered inclusion proof', () => {
  const { logged, logPublicKeyPem } = freshLogged();
  const inc = logged.inclusions.find((i) => Array.isArray(i.proof) && i.proof.length > 0);
  inc.proof[0] = 'f'.repeat(64); // corrupt the sibling hash
  const r = validateLoggedCollection(logged, args(logged, logPublicKeyPem));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /not included|reconstruct/.test(f)));
});

// 6. FAIL-CLOSED: the logged collection does not bind to the verified collection (verifiedDigest mismatch).
ok('rejects a verified-collection binding mismatch', () => {
  const { logged, logPublicKeyPem } = freshLogged();
  logged.verifiedDigest = '0'.repeat(64);
  logged.digest = undefined;
  assert.equal(validateLoggedCollection(logged, args(logged, logPublicKeyPem)).ok, false);
});

// 7. FAIL-CLOSED: a tampered logged digest.
ok('rejects a tampered logged digest', () => {
  const { logged, logPublicKeyPem } = freshLogged();
  logged.digest = '0'.repeat(64);
  const r = validateLoggedCollection(logged, args(logged, logPublicKeyPem));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /digest/.test(f)));
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# mesh-transparency-log selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
