#!/usr/bin/env node
// Self-test for the opt-in verified tier (LBA-REQ-077 / ADR-0058). Pure + offline: proves the committed verified
// collection re-verifies its enrolled-actor attestations, a fresh round-trip verifies, and every fail-closed
// guard fires (unsigned, un-enrolled, wrong key, forged receipt, tampered digest). Gated by
// `mesh-verified-tier-attested`. Run: `node experiments/mesh-fulfillment/meshVerifiedTier.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateEnrolledKeypair } from '../acg-provenance/attest.mjs';
import { attestReturnedReceipt, buildVerifiedCollection, validateVerifiedCollection, VERIFIED_COLLECTION_SCHEMA, REQUIREMENT } from './meshVerifiedTier.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
const tasking = read('mesh-run-tasking.json');
const collection = read('mesh-run-collection.json');
const committedVerified = read('mesh-run-verified-collection.json');
const committedKeys = read('mesh-actor-keys.json').enrolled;
const clone = (o) => JSON.parse(JSON.stringify(o));

// Mint a fresh enrolled keyset + verified collection over the committed collection (for round-trip + mutations).
function fresh() {
  const enrolled = {};
  const priv = {};
  const attestations = collection.collected.map((c) => {
    const kp = generateEnrolledKeypair();
    enrolled[c.actorId] = kp.publicKeyPem;
    priv[c.actorId] = kp.privateKeyPem;
    return { actorId: c.actorId, plane: c.plane, attestation: attestReturnedReceipt(c.receipt, { privateKeyPem: kp.privateKeyPem, actorId: c.actorId }) };
  });
  return { verified: buildVerifiedCollection({ collection, attestations }), enrolled, priv };
}

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. the COMMITTED verified collection re-verifies against the committed collection + enrolled keys.
ok('committed verified collection re-verifies', () => {
  const r = validateVerifiedCollection(committedVerified, { collection, tasking, enrolledKeys: committedKeys });
  assert.equal(r.ok, true, `committed should verify: ${r.findings.join('; ')}`);
  assert.equal(committedVerified.schema, VERIFIED_COLLECTION_SCHEMA);
  assert.equal(committedVerified.requirement, REQUIREMENT);
  assert.equal(committedVerified.attestations.length, collection.collected.length, 'every collected receipt is attested');
});

// 2. a fresh round-trip (mint keys -> sign -> build -> validate) verifies.
ok('fresh enrolled round-trip verifies', () => {
  const { verified, enrolled } = fresh();
  assert.equal(validateVerifiedCollection(verified, { collection, tasking, enrolledKeys: enrolled }).ok, true);
});

// 3. FAIL-CLOSED: a collected receipt with NO attestation.
ok('rejects a collected receipt with no attestation', () => {
  const { verified, enrolled } = fresh();
  verified.attestations = verified.attestations.slice(0, 1); // drop one actor's attestation
  assert.equal(validateVerifiedCollection(verified, { collection, tasking, enrolledKeys: enrolled }).ok, false);
});

// 4. FAIL-CLOSED: an un-enrolled actor (its key is not in the allowlist).
ok('rejects an un-enrolled actor', () => {
  const { verified, enrolled } = fresh();
  const someActor = collection.collected[0].actorId;
  delete enrolled[someActor];
  const r = validateVerifiedCollection(verified, { collection, tasking, enrolledKeys: enrolled });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /not enrolled|does not verify/.test(f)));
});

// 5. FAIL-CLOSED: a presented key that does not match the enrolled key (wrong-actor / rogue key).
ok('rejects a key that does not match the enrolled key', () => {
  const { verified, enrolled } = fresh();
  const other = generateEnrolledKeypair();
  verified.attestations[0].attestation.publicKeyPem = other.publicKeyPem; // swap in a rogue key
  const r = validateVerifiedCollection(verified, { collection, tasking, enrolledKeys: enrolled });
  assert.equal(r.ok, false);
});

// 6. FAIL-CLOSED: a forged receipt -- the returned receipt is mutated after signing (digest no longer matches).
ok('rejects a forged (post-sign mutated) receipt', () => {
  const { verified, enrolled } = fresh();
  const tampered = clone(collection);
  tampered.collected[0].receipt.stats.mean += 1000; // tamper the timing after it was attested
  const r = validateVerifiedCollection(verified, { collection: tampered, tasking, enrolledKeys: enrolled });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /digest|does not verify/.test(f)));
});

// 7. FAIL-CLOSED: a tampered verified-collection digest.
ok('rejects a tampered verified digest', () => {
  const { verified, enrolled } = fresh();
  verified.digest = '0'.repeat(64);
  const r = validateVerifiedCollection(verified, { collection, tasking, enrolledKeys: enrolled });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /digest/.test(f)));
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# mesh-verified-tier selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
