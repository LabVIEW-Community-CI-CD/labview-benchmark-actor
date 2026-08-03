#!/usr/bin/env node
// meshVerifiedTier.mjs -- the opt-in VERIFIED TIER (LBA-REQ-077, realizes ADR-0058). The fan-out collection
// (LBA-REQ-076) proves each returned receipt is identity-bound + structurally valid, but NOT that it came from a
// REAL enrolled actor -- an actor could fabricate a trend. The verified tier raises the trust bar: each returned
// actor receipt is SIGNED by the actor's ENROLLED Ed25519 key (reusing the ADR-0016 acg-provenance attestation
// engine, `signBundle` / `verifyWitnessAttestation`), and a verified collection admits a receipt only when it
// carries a valid attestation from its DECLARED, ENROLLED actor. Opt-in: a plain fan-out (076) still works; the
// verified tier is the higher-assurance mode a requester can require.
//
// Pure + rg-free + offline: a committed verified collection re-verifies its attestations byte-stably in CI (the
// enrolled PUBLIC keys are committed; the private keys are not). Fails closed on an unsigned/forged receipt, an
// un-enrolled actor, a wrong-actor signature, an orphan attestation, a collection-digest mismatch, or a tampered
// digest.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { signBundle, verifyWitnessAttestation } from '../acg-provenance/attest.mjs';
import { validateCollection, digestCollection } from './meshFanout.mjs';

export const VERIFIED_COLLECTION_SCHEMA = 'labview-benchmark-actor/verified-receipt-collection@1';
export const REQUIREMENT = 'LBA-REQ-077';
export const ADR = 'ADR-0058';

// Attest ONE actor's returned receipt with the actor's enrolled key -> an acg-witness-attestation-v1 (ADR-0016).
export function attestReturnedReceipt(receipt, { privateKeyPem, actorId } = {}) {
  return signBundle(receipt, { privateKeyPem, identity: actorId });
}

function canonicalVerified(v) {
  return JSON.stringify({
    schema: v.schema, requirement: v.requirement, adr: v.adr,
    dispatchId: v.dispatchId, identity: v.identity,
    collectionDigest: v.collectionDigest,
    attestations: Array.isArray(v.attestations)
      ? v.attestations.map((a) => ({ actorId: a.actorId, plane: a.plane, digest: a.attestation?.subject?.digest ?? null, witnessIdentity: a.attestation?.witnessIdentity ?? null }))
      : null,
  });
}

export function digestVerified(v) {
  return createHash('sha256').update(canonicalVerified(v)).digest('hex');
}

// Build a verified collection: bind a validated 076 collection (by its digest) to per-actor enrolled-key
// attestations (each an acg-witness-attestation-v1 over that actor's returned receipt).
export function buildVerifiedCollection({ collection, attestations } = {}) {
  const v = {
    schema: VERIFIED_COLLECTION_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    dispatchId: collection?.dispatchId ?? null,
    identity: collection?.identity ?? null,
    collectionDigest: collection ? digestCollection(collection) : null,
    attestations: (attestations ?? []).map((a) => ({ actorId: a.actorId, plane: a.plane, attestation: a.attestation })),
  };
  v.digest = digestVerified(v);
  return v;
}

// Validate a verified collection: it binds to the given 076 collection (which itself validates against the
// tasking), every collected receipt carries a valid attestation from its DECLARED + ENROLLED actor over the
// ACTUAL returned receipt, there are no orphan attestations, and the digest re-derives. Fail-closed.
export function validateVerifiedCollection(verified, { collection, tasking, enrolledKeys = {} } = {}) {
  const findings = [];
  if (!verified || verified.schema !== VERIFIED_COLLECTION_SCHEMA) findings.push(`schema must be ${VERIFIED_COLLECTION_SCHEMA}`);
  if (verified?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (verified?.adr !== ADR) findings.push(`adr must be ${ADR}`);

  // the underlying 076 collection must itself validate (structural + identity-bound).
  const vc = validateCollection(collection, tasking);
  if (!vc.ok) findings.push(...vc.findings.map((f) => `collection: ${f}`));

  // bind to the exact collection.
  if (verified?.collectionDigest !== (collection ? digestCollection(collection) : null)) findings.push('verified collection does not bind to the collection (collectionDigest mismatch)');
  if (verified?.dispatchId !== collection?.dispatchId) findings.push('verified dispatchId does not match the collection');
  if (verified?.identity !== collection?.identity) findings.push('verified identity does not match the collection');

  const collected = Array.isArray(collection?.collected) ? collection.collected : [];
  const attByActor = new Map((verified?.attestations ?? []).map((a) => [a.actorId, a]));
  collected.forEach((c, i) => {
    const att = attByActor.get(c.actorId);
    if (!att) { findings.push(`collected[${i}] actor "${c.actorId}" has no attestation`); return; }
    if (att.plane !== c.plane) findings.push(`collected[${i}] attestation plane != the collected plane`);
    if (att.attestation?.witnessIdentity !== c.actorId) findings.push(`collected[${i}] attestation is not by the declared actor "${c.actorId}"`);
    // the attestation must verify over the ACTUAL returned receipt against the enrolled allowlist.
    const v = verifyWitnessAttestation(c.receipt, att.attestation, { allowlist: enrolledKeys });
    if (!v.ok) findings.push(`collected[${i}] attestation by "${c.actorId}" does not verify: ${v.reasons.join('; ')}`);
  });
  // no orphan attestations (each attestation maps to a collected receipt).
  for (const a of verified?.attestations ?? []) {
    if (!collected.some((c) => c.actorId === a.actorId)) findings.push(`attestation for "${a.actorId}" has no collected receipt`);
  }

  if (verified?.digest !== digestVerified(verified)) findings.push('verified digest does not match (tampered)');
  return { ok: findings.length === 0, proofOk: findings.length === 0, findings };
}

// CLI: validate the committed verified collection against the committed collection + tasking + enrolled keys.
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
  const tasking = read('mesh-run-tasking.json');
  const collection = read('mesh-run-collection.json');
  const verified = read('mesh-run-verified-collection.json');
  const enrolledKeys = read('mesh-actor-keys.json').enrolled ?? {};
  const r = validateVerifiedCollection(verified, { collection, tasking, enrolledKeys });
  if (!r.ok) {
    console.error('[mesh-verified-tier] FAIL');
    for (const f of r.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`[mesh-verified-tier] OK ${REQUIREMENT}: ${verified.attestations.length} enrolled-actor attestation(s) verified over the collected receipts (identity ${verified.identity.slice(0, 12)})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
