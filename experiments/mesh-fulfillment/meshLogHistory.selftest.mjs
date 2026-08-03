#!/usr/bin/env node
// Self-test for the append-only consistency proof (LBA-REQ-079 / ADR-0060). Pure + offline: proves the committed
// history re-verifies both signed tree heads + the consistency proof + binds to the committed LBA-REQ-078 log, a
// fresh round-trip verifies, and every fail-closed guard fires (wrong key, non-growing log, tampered proof,
// wrong current root, tampered digest). Gated by `mesh-log-append-only`.
// Run: `node experiments/mesh-fulfillment/meshLogHistory.selftest.mjs`.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateEnrolledKeypair } from '../acg-transparency/transparency-log.mjs';
import { buildHistory, validateHistory, digestHistory, HISTORY_SCHEMA, REQUIREMENT } from './meshLogHistory.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
const verified = read('mesh-run-verified-collection.json');
const logged = read('mesh-run-logged-collection.json');
const committedHistory = read('mesh-run-log-history.json');
const committedKey = read('mesh-log-history-key.json').publicKeyPem;

// Mint a fresh log key + build a history (size-1 -> full) over the committed verified attestations.
function fresh(opts = {}) {
  const kp = generateEnrolledKeypair();
  const logPublicKeyPem = crypto.createPublicKey(kp.privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
  const history = buildHistory({ verified, privateKeyPem: kp.privateKeyPem, logIdentity: 'test-log', firstTimestamp: '2026-08-03T00:00:00.000Z', secondTimestamp: '2026-08-03T00:05:00.000Z', ...opts });
  return { history, logPublicKeyPem };
}

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

// 1. the COMMITTED history re-verifies + binds to the committed LBA-REQ-078 log.
ok('committed history re-verifies + binds to the 078 log', () => {
  const r = validateHistory(committedHistory, { verified, logged, logPublicKeyPem: committedKey });
  assert.equal(r.ok, true, `committed should verify: ${r.findings.join('; ')}`);
  assert.equal(committedHistory.schema, HISTORY_SCHEMA);
  assert.equal(committedHistory.requirement, REQUIREMENT);
  assert.ok(committedHistory.firstTreeHead.size < committedHistory.secondTreeHead.size, 'the log grew');
  assert.equal(committedHistory.secondTreeHead.root, logged.signedTreeHead.root, 'current head is the 078 log');
});

// 2. a fresh round-trip (mint key -> build size-1 -> full -> verify) validates.
ok('fresh append-only round-trip verifies', () => {
  const { history, logPublicKeyPem } = fresh();
  assert.equal(validateHistory(history, { verified, logged, logPublicKeyPem }).ok, true);
});

// 3. FAIL-CLOSED: the tree heads are verified against the WRONG log key.
ok('rejects tree heads signed by the wrong log key', () => {
  const { history } = fresh();
  const rogue = generateEnrolledKeypair();
  const roguePub = crypto.createPublicKey(rogue.privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
  const r = validateHistory(history, { verified, logged, logPublicKeyPem: roguePub });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /tree head/.test(f)));
});

// 4. FAIL-CLOSED: a non-growing log (first size == full size) is not a proof of append-only growth.
ok('rejects a non-growing log', () => {
  const { history, logPublicKeyPem } = fresh({ firstSize: verified.attestations.length });
  const r = validateHistory(history, { verified, logged, logPublicKeyPem });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /grow/.test(f)));
});

// 5. FAIL-CLOSED: a tampered consistency proof (does not prove append-only extension).
ok('rejects a tampered consistency proof', () => {
  const { history, logPublicKeyPem } = fresh();
  history.consistencyProof = ['f'.repeat(64)];
  history.digest = digestHistory(history); // re-seal so ONLY the consistency check can fail
  const r = validateHistory(history, { verified, logged, logPublicKeyPem });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /consistency|append-only/.test(f)));
});

// 6. FAIL-CLOSED: the current tree head does not match the committed LBA-REQ-078 log root.
ok('rejects a current head that does not match the 078 log', () => {
  const { history, logPublicKeyPem } = fresh();
  const wrongLogged = JSON.parse(JSON.stringify(logged));
  wrongLogged.signedTreeHead.root = '0'.repeat(64);
  const r = validateHistory(history, { verified, logged: wrongLogged, logPublicKeyPem });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /078 log|does not match/.test(f)));
});

// 7. FAIL-CLOSED: a tampered history digest.
ok('rejects a tampered history digest', () => {
  const { history, logPublicKeyPem } = fresh();
  history.digest = '0'.repeat(64);
  const r = validateHistory(history, { verified, logged, logPublicKeyPem });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => /digest/.test(f)));
});

let n = 0;
for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
console.log(`# mesh-log-append-only selftest ${n}/${cases.length} passed`);
if (n !== cases.length) process.exit(1);
