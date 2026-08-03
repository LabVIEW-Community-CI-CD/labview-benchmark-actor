#!/usr/bin/env node
// meshTransparency.mjs -- transparency-log the verified-tier attestations (LBA-REQ-078, realizes ADR-0059). The
// verified tier (LBA-REQ-077) proves each returned receipt is signed by its ENROLLED actor, but the set of
// attestations is not publicly auditable: a compromised key could sign, and nothing records the attestations in
// an append-only, tamper-evident log. This layer records each verified-tier attestation into an RFC-6962 Merkle
// transparency log (reusing the ADR-0022 acg-transparency engine), signs the tree head with the enrolled log key,
// and admits a logged collection only when EVERY attestation carries a valid inclusion proof against the SIGNED
// tree head -- so the mesh receipts are enrolled-signed AND publicly auditable (verify-before-consume: BOTH the
// witness signature and the transparency inclusion).
//
// Pure + rg-free + offline: a committed logged collection re-verifies its signed tree head + every inclusion proof
// byte-stably in CI (the enrolled log PUBLIC key is committed; the private key is not). Fails closed on an
// unsigned/wrong-key tree head, a missing or non-reconstructing inclusion proof, a verified-collection binding
// mismatch, or a tampered digest.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { recordRelease, verifyReleaseInclusion, verifySignedTreeHead } from '../acg-transparency/transparency-log.mjs';
import { validateVerifiedCollection, digestVerified } from './meshVerifiedTier.mjs';

export const LOGGED_COLLECTION_SCHEMA = 'labview-benchmark-actor/logged-verified-collection@1';
export const REQUIREMENT = 'LBA-REQ-078';
export const ADR = 'ADR-0059';

const attestationsOf = (verified) => (verified?.attestations ?? []).map((a) => a.attestation);

function canonicalLogged(l) {
  return JSON.stringify({
    schema: l.schema, requirement: l.requirement, adr: l.adr,
    dispatchId: l.dispatchId, identity: l.identity,
    verifiedDigest: l.verifiedDigest,
    logIdentity: l.logIdentity,
    treeHead: l.signedTreeHead ? { size: l.signedTreeHead.size, root: l.signedTreeHead.root, timestamp: l.signedTreeHead.timestamp } : null,
    inclusions: Array.isArray(l.inclusions) ? l.inclusions.map((i) => ({ witnessIdentity: i.witnessIdentity, index: i.index, leaf: i.leaf })) : null,
  });
}

export function digestLogged(l) {
  return createHash('sha256').update(canonicalLogged(l)).digest('hex');
}

// Record a verified collection's attestations into a fresh transparency log -> a logged collection bound to the
// verified collection (by digest) with a signed tree head + per-attestation inclusion proofs.
export function buildLoggedCollection({ verified, privateKeyPem, logIdentity, timestamp } = {}) {
  const record = recordRelease(attestationsOf(verified), { privateKeyPem, logIdentity, timestamp });
  const l = {
    schema: LOGGED_COLLECTION_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    dispatchId: verified?.dispatchId ?? null,
    identity: verified?.identity ?? null,
    verifiedDigest: verified ? digestVerified(verified) : null,
    logIdentity: logIdentity ?? null,
    signedTreeHead: record.signedTreeHead,
    inclusions: record.inclusions,
  };
  l.digest = digestLogged(l);
  return l;
}

// Validate a logged collection: the underlying verified collection (077) must hold, the logged wrapper must bind
// to it (verifiedDigest), the signed tree head must verify against the enrolled log key, and EVERY attestation
// must carry a valid inclusion proof against the signed tree head. Fail-closed.
export function validateLoggedCollection(logged, { verified, collection, tasking, enrolledKeys = {}, logPublicKeyPem } = {}) {
  const findings = [];
  if (!logged || logged.schema !== LOGGED_COLLECTION_SCHEMA) findings.push(`schema must be ${LOGGED_COLLECTION_SCHEMA}`);
  if (logged?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (logged?.adr !== ADR) findings.push(`adr must be ${ADR}`);

  // the verified tier (077) must itself hold.
  const vv = validateVerifiedCollection(verified, { collection, tasking, enrolledKeys });
  if (!vv.ok) findings.push(...vv.findings.map((f) => `verified: ${f}`));

  // bind to the exact verified collection.
  if (logged?.verifiedDigest !== (verified ? digestVerified(verified) : null)) findings.push('logged collection does not bind to the verified collection (verifiedDigest mismatch)');
  if (logged?.dispatchId !== verified?.dispatchId) findings.push('logged dispatchId does not match the verified collection');
  if (logged?.identity !== verified?.identity) findings.push('logged identity does not match the verified collection');

  // the signed tree head must verify against the enrolled log key.
  if (!verifySignedTreeHead(logged?.signedTreeHead, { publicKeyPem: logPublicKeyPem })) findings.push('signed tree head does not verify against the enrolled log key');

  // every verified-tier attestation must be INCLUDED in the log (inclusion proof reconstructs the signed root).
  const attestations = attestationsOf(verified);
  const inclusionByIdentity = new Map((logged?.inclusions ?? []).map((i) => [i.witnessIdentity, i]));
  if ((logged?.signedTreeHead?.size ?? -1) !== attestations.length) findings.push('signed tree head size does not match the attestation count');
  for (const att of attestations) {
    const inclusion = inclusionByIdentity.get(att?.witnessIdentity);
    if (!inclusion) { findings.push(`attestation by "${att?.witnessIdentity}" has no inclusion proof`); continue; }
    const r = verifyReleaseInclusion({ attestation: att, inclusion, signedTreeHead: logged.signedTreeHead, logPublicKeyPem });
    if (!r.included) findings.push(`attestation by "${att?.witnessIdentity}" is not included: ${r.reason}`);
  }

  if (logged?.digest !== digestLogged(logged)) findings.push('logged digest does not match (tampered)');
  return { ok: findings.length === 0, proofOk: findings.length === 0, findings };
}

// CLI: validate the committed logged collection against the committed verified/collection/tasking/keys + log key.
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
  const tasking = read('mesh-run-tasking.json');
  const collection = read('mesh-run-collection.json');
  const verified = read('mesh-run-verified-collection.json');
  const enrolledKeys = read('mesh-actor-keys.json').enrolled ?? {};
  const logged = read('mesh-run-logged-collection.json');
  const logKey = read('mesh-log-key.json');
  const r = validateLoggedCollection(logged, { verified, collection, tasking, enrolledKeys, logPublicKeyPem: logKey.publicKeyPem });
  if (!r.ok) {
    console.error('[mesh-transparency-log] FAIL');
    for (const f of r.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`[mesh-transparency-log] OK ${REQUIREMENT}: ${logged.inclusions.length} attestation(s) included in log "${logged.logIdentity}" (tree size ${logged.signedTreeHead.size}, root ${logged.signedTreeHead.root.slice(0, 12)})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
