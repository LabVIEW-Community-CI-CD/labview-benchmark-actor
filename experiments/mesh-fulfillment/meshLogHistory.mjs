#!/usr/bin/env node
// meshLogHistory.mjs -- the APPEND-ONLY consistency proof (LBA-REQ-079, realizes ADR-0060). ADR-0059 records the
// mesh-actor attestations into a signed Merkle transparency log and proves each is INCLUDED, and claims the log is
// "append-only, tamper-evident" -- but inclusion alone does not prove the log only GROWS. This layer closes that
// claim: it binds an EARLIER signed tree head + the CURRENT one and a CONSISTENCY PROOF (RFC-6962 section 2.1.2,
// reusing the ADR-0022 acg-transparency engine), admitted only when the later tree provably CONTAINS the earlier
// one unchanged -- so no entry was removed or rewritten as the log grew (e.g. as the second actor's receipt was
// appended). The current tree head is bound to the committed LBA-REQ-078 log by its Merkle ROOT (the content
// identity of the log), so this is THIS mesh log's append-only history.
//
// Pure + rg-free + offline: a committed history re-verifies both signed tree heads + the consistency proof
// byte-stably in CI (the enrolled log PUBLIC key is committed; the private key is not). Fails closed on an
// unsigned/wrong-key tree head, a non-growing or shrinking log, a consistency proof that does not verify (a
// rewritten/forked log), a current head that does not match the committed LBA-REQ-078 log root, or a tampered digest.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { entryLeaf, merkleRoot, signTreeHead, verifySignedTreeHead, consistencyProof, verifyConsistency } from '../acg-transparency/transparency-log.mjs';

export const HISTORY_SCHEMA = 'labview-benchmark-actor/logged-collection-history@1';
export const REQUIREMENT = 'LBA-REQ-079';
export const ADR = 'ADR-0060';

const leavesOf = (verified) => (verified?.attestations ?? []).map((a) => entryLeaf(a.attestation));

function canonicalHistory(h) {
  const head = (s) => (s ? { logIdentity: s.logIdentity, size: s.size, root: s.root, timestamp: s.timestamp } : null);
  return JSON.stringify({
    schema: h.schema, requirement: h.requirement, adr: h.adr,
    logIdentity: h.logIdentity,
    firstTreeHead: head(h.firstTreeHead),
    secondTreeHead: head(h.secondTreeHead),
    consistencyProof: Array.isArray(h.consistencyProof) ? h.consistencyProof : null,
  });
}

export function digestHistory(h) {
  return createHash('sha256').update(canonicalHistory(h)).digest('hex');
}

// Build an append-only history for a logged collection: an EARLIER signed tree head (the log at `firstSize`) + the
// CURRENT one (the full log) + the consistency proof between them, all over the real attestation leaves.
export function buildHistory({ verified, privateKeyPem, logIdentity, firstSize = 1, firstTimestamp, secondTimestamp } = {}) {
  const leaves = leavesOf(verified);
  const n = leaves.length;
  const m = Math.min(Math.max(firstSize, 1), n);
  const firstTreeHead = signTreeHead({ size: m, root: merkleRoot(leaves.slice(0, m)) }, { privateKeyPem, logIdentity, timestamp: firstTimestamp });
  const secondTreeHead = signTreeHead({ size: n, root: merkleRoot(leaves) }, { privateKeyPem, logIdentity, timestamp: secondTimestamp });
  const h = {
    schema: HISTORY_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    logIdentity: logIdentity ?? null,
    firstTreeHead,
    secondTreeHead,
    consistencyProof: consistencyProof(leaves, m),
  };
  h.digest = digestHistory(h);
  return h;
}

// Validate an append-only history: both tree heads verify against the enrolled log key + share the log identity,
// the log strictly GREW, the consistency proof proves the later tree contains the earlier unchanged, the current
// tree head is grounded in the real attestations AND matches the committed LBA-REQ-078 log root, and the digest
// re-derives. Fail-closed.
export function validateHistory(history, { verified, logged, logPublicKeyPem } = {}) {
  const findings = [];
  if (!history || history.schema !== HISTORY_SCHEMA) findings.push(`schema must be ${HISTORY_SCHEMA}`);
  if (history?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (history?.adr !== ADR) findings.push(`adr must be ${ADR}`);

  const first = history?.firstTreeHead;
  const second = history?.secondTreeHead;
  if (!verifySignedTreeHead(first, { publicKeyPem: logPublicKeyPem })) findings.push('the earlier tree head does not verify against the enrolled log key');
  if (!verifySignedTreeHead(second, { publicKeyPem: logPublicKeyPem })) findings.push('the current tree head does not verify against the enrolled log key');
  if (first?.logIdentity !== history?.logIdentity || second?.logIdentity !== history?.logIdentity) findings.push('the tree heads do not share the history log identity');

  // the log must have strictly grown (an append happened).
  if (!(Number.isInteger(first?.size) && Number.isInteger(second?.size) && first.size >= 1 && first.size < second.size)) findings.push('the log did not strictly grow (firstSize must be >= 1 and < secondSize)');

  // the consistency proof must prove the later tree contains the earlier one unchanged (append-only).
  const consistent = verifyConsistency({ firstSize: first?.size, firstRoot: first?.root, secondSize: second?.size, secondRoot: second?.root, proof: history?.consistencyProof ?? [] });
  if (!consistent) findings.push('the consistency proof does not prove append-only extension (the log was rewritten or forked)');

  // grounding: the current tree head is the real attestation set AND is the committed LBA-REQ-078 log (by root).
  if (verified) {
    const leaves = leavesOf(verified);
    if (second?.size !== leaves.length || second?.root !== merkleRoot(leaves)) findings.push('the current tree head is not the real attestation set');
  }
  if (logged) {
    if (second?.root !== logged?.signedTreeHead?.root || second?.size !== logged?.signedTreeHead?.size) findings.push('the current tree head does not match the committed LBA-REQ-078 log (root/size)');
  }

  if (history?.digest !== digestHistory(history)) findings.push('history digest does not match (tampered)');
  return { ok: findings.length === 0, proofOk: findings.length === 0, findings };
}

// CLI: validate the committed append-only history against the committed verified collection + LBA-REQ-078 log.
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
  const verified = read('mesh-run-verified-collection.json');
  const logged = read('mesh-run-logged-collection.json');
  const history = read('mesh-run-log-history.json');
  const logPublicKeyPem = read('mesh-log-history-key.json').publicKeyPem;
  const r = validateHistory(history, { verified, logged, logPublicKeyPem });
  if (!r.ok) {
    console.error('[mesh-append-only] FAIL');
    for (const f of r.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`[mesh-append-only] OK ${REQUIREMENT}: log "${history.logIdentity}" grew ${history.firstTreeHead.size} -> ${history.secondTreeHead.size} append-only (consistency proof verifies against root ${history.secondTreeHead.root.slice(0, 12)})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
