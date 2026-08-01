// transparency-log.mjs -- an append-only, tamper-evident Merkle TRANSPARENCY LOG: the rekor analogue for
// the Actor Corroboration Grid (ADR-0022 / LBA-REQ-031). It is the "provenance stored in a transparency
// log" tier of LBA-REQ-025 and the machine core of reviewer-workstation verify-before-install.
//
// Construction is grounded in the Merkle tree referenced by github.com/Etelis/Merkle_Tree (leaves ->
// pairwise hash -> a signed root, with per-leaf inclusion proofs) but HARDENED to RFC 6962 (Certificate
// Transparency), which is what a real transparency log (rekor) uses:
//   * DOMAIN SEPARATION -- leaves hash 0x00||data, interior nodes hash 0x01||left||right. The reference's
//     bare SHA256(a||b) (no tag) lets an interior node be forged as a leaf (second-preimage / leaf-vs-node
//     confusion); domain separation closes that. This log backs release provenance, so it must resist it.
//   * A DETERMINISTIC largest-power-of-2 split (not "promote the odd node"), so the tree shape -- and thus
//     every inclusion and consistency proof -- is canonical and independently recomputable.
//   * Ed25519 SIGNED TREE HEADS reusing the enrolled-key primitives of the attestation chain (attest.mjs),
//     not a separate RSA key, so the grid keeps ONE trust root.
// Dependency-free (node:crypto only). RFC 6962 sections cited inline.

import crypto from 'node:crypto';
import { canonicalize, generateEnrolledKeypair } from '../acg-provenance/attest.mjs';

export const STH_SCHEMA = 'labview-benchmark-actor/acg-signed-tree-head-v1';
export const LOG_RECEIPT_SCHEMA = 'labview-benchmark-actor/acg-transparency-receipt-v1';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const toBuf = (hex) => Buffer.from(hex, 'hex');
const toHex = (buf) => Buffer.from(buf).toString('hex');

// ---- RFC 6962 section 2.1 domain-separated hashing --------------------------------------------------
// MTH({}) = SHA-256() of the empty string.
export const EMPTY_ROOT = toHex(sha256(Buffer.alloc(0)));

// MTH({d}) = SHA-256(0x00 || d).
export function leafHash(data) {
  const d = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  return toHex(sha256(Buffer.concat([Buffer.from([0x00]), d])));
}

// interior node = SHA-256(0x01 || left || right).
export function nodeHash(leftHex, rightHex) {
  return toHex(sha256(Buffer.concat([Buffer.from([0x01]), toBuf(leftHex), toBuf(rightHex)])));
}

// largest power of two STRICTLY less than n (n >= 2).
function largestPow2LessThan(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

// MTH(D[0:n]) over an array of leaf hashes (hex), RFC 6962 section 2.1 recursive definition.
export function merkleRoot(leafHashes) {
  const n = leafHashes.length;
  if (n === 0) return EMPTY_ROOT;
  if (n === 1) return leafHashes[0];
  const k = largestPow2LessThan(n);
  return nodeHash(merkleRoot(leafHashes.slice(0, k)), merkleRoot(leafHashes.slice(k)));
}

// ---- RFC 6962 section 2.1.1 inclusion (audit) path --------------------------------------------------
// PATH(m, D[0:n]) -> array of sibling hashes (hex), leaf-to-root order.
export function inclusionProof(leafHashes, m) {
  const n = leafHashes.length;
  if (m < 0 || m >= n) throw new Error(`inclusionProof: index ${m} out of range [0, ${n})`);
  if (n === 1) return [];
  const k = largestPow2LessThan(n);
  if (m < k) return [...inclusionProof(leafHashes.slice(0, k), m), merkleRoot(leafHashes.slice(k))];
  return [...inclusionProof(leafHashes.slice(k), m - k), merkleRoot(leafHashes.slice(0, k))];
}

// Verify an inclusion proof WITHOUT the full tree (RFC 6962 section 2.1.1): recompute the root from the
// leaf hash + index + tree size + audit path. This is the verify-before-install security path.
export function verifyInclusion({ leaf, index, treeSize, proof, root }) {
  if (!Number.isInteger(index) || !Number.isInteger(treeSize)) return false;
  if (index < 0 || index >= treeSize) return false;
  let fn = index;
  let sn = treeSize - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return false; // audit path longer than the tree allows
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(p, r);
      while ((fn & 1) === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && r === root;
}

// ---- RFC 6962 sections 2.1.2 / 2.1.3 consistency (append-only) proofs -------------------------------
// PROOF(m, D[0:n]) for 0 < m <= n -- proves the size-n tree only appended to the size-m tree.
export function consistencyProof(leafHashes, m) {
  const n = leafHashes.length;
  if (m <= 0 || m > n) throw new Error(`consistencyProof: m ${m} out of range (0, ${n}]`);
  if (m === n) return [];
  return subProof(m, leafHashes, true);
}
function subProof(m, leaves, b) {
  const n = leaves.length;
  if (m === n) return b ? [] : [merkleRoot(leaves)];
  const k = largestPow2LessThan(n);
  if (m <= k) return [...subProof(m, leaves.slice(0, k), b), merkleRoot(leaves.slice(k))];
  return [...subProof(m - k, leaves.slice(k), false), merkleRoot(leaves.slice(0, k))];
}

// Verify a consistency proof (RFC 6962 section 2.1.2) between a signed old head and a signed new head,
// without either full tree.
export function verifyConsistency({ firstSize, firstRoot, secondSize, secondRoot, proof }) {
  if (firstSize > secondSize) return false;
  if (firstSize === 0) return true; // an empty tree is a prefix of every tree
  if (firstSize === secondSize) return firstRoot === secondRoot && proof.length === 0;
  let path = proof.slice();
  const isPow2 = (x) => (x & (x - 1)) === 0;
  if (isPow2(firstSize)) path = [firstRoot, ...path];
  if (path.length === 0) return false;
  let fn = firstSize - 1;
  let sn = secondSize - 1;
  while ((fn & 1) === 1) { fn >>= 1; sn >>= 1; }
  let fr = path[0];
  let sr = path[0];
  for (let i = 1; i < path.length; i++) {
    const c = path[i];
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      while ((fn & 1) === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else {
      sr = nodeHash(sr, c);
    }
    fn >>= 1; sn >>= 1;
  }
  return fr === firstRoot && sr === secondRoot && sn === 0;
}

// ---- Signed tree heads (Ed25519, reusing the enrolled-key trust root) -------------------------------
const sthMessage = (logIdentity, size, root, timestamp) => canonicalize({ logIdentity, size, root, timestamp });

export function signTreeHead({ size, root }, { privateKeyPem, logIdentity, timestamp } = {}) {
  const ts = timestamp ?? new Date().toISOString();
  const message = Buffer.from(sthMessage(logIdentity, size, root, ts), 'utf8');
  const signature = crypto.sign(null, message, privateKeyPem).toString('base64');
  const publicKeyPem = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
  return { schema: STH_SCHEMA, logIdentity, size, root, timestamp: ts, algorithm: 'ed25519', publicKeyPem, signature };
}

export function verifySignedTreeHead(sth, { publicKeyPem } = {}) {
  if (!sth || sth.schema !== STH_SCHEMA || typeof sth.signature !== 'string') return false;
  const key = publicKeyPem ?? sth.publicKeyPem;
  if (!key) return false;
  const message = Buffer.from(sthMessage(sth.logIdentity, sth.size, sth.root, sth.timestamp), 'utf8');
  try {
    return crypto.verify(null, message, key, Buffer.from(sth.signature, 'base64'));
  } catch {
    return false;
  }
}

// ---- Transparency-log entries + release recording ---------------------------------------------------
// A log entry binds an attestation's bundle digest to the witness identity that signed it. The leaf is the
// domain-separated hash of the canonical entry so the same attestation always yields the same leaf.
export function entryLeaf(attestation) {
  return leafHash(canonicalize({
    digest: attestation?.subject?.digest,
    witnessIdentity: attestation?.witnessIdentity,
    algorithm: attestation?.algorithm,
  }));
}

// Record a set of witness attestations into a fresh transparency log: build the Merkle tree over their
// entry leaves, sign the tree head with the enrolled log key, and emit a per-attestation inclusion proof.
export function recordRelease(attestations, { privateKeyPem, logIdentity, timestamp } = {}) {
  const leaves = attestations.map(entryLeaf);
  const signedTreeHead = signTreeHead({ size: leaves.length, root: merkleRoot(leaves) }, { privateKeyPem, logIdentity, timestamp });
  const inclusions = attestations.map((att, index) => ({
    witnessIdentity: att.witnessIdentity,
    index,
    treeSize: leaves.length,
    leaf: leaves[index],
    proof: inclusionProof(leaves, index),
  }));
  return { schema: LOG_RECEIPT_SCHEMA, signedTreeHead, inclusions };
}

// The transparency half of verify-before-install: an artifact's attestation is installable only if it is
// INCLUDED in a transparency log whose tree head is signed by the enrolled log key. Fail-closed on any
// signature / binding / proof mismatch. (The attestation's OWN witness signature is checked separately by
// attest.mjs verifyWitnessAttestation; verify-before-install requires BOTH.)
export function verifyReleaseInclusion({ attestation, inclusion, signedTreeHead, logPublicKeyPem }) {
  if (!verifySignedTreeHead(signedTreeHead, { publicKeyPem: logPublicKeyPem })) {
    return { included: false, reason: 'signed tree head signature does not verify against the enrolled log key' };
  }
  if (!inclusion || inclusion.leaf !== entryLeaf(attestation)) {
    return { included: false, reason: 'inclusion leaf does not match the supplied attestation' };
  }
  if (inclusion.treeSize !== signedTreeHead.size) {
    return { included: false, reason: 'inclusion tree size does not match the signed tree head' };
  }
  const ok = verifyInclusion({
    leaf: inclusion.leaf,
    index: inclusion.index,
    treeSize: inclusion.treeSize,
    proof: inclusion.proof,
    root: signedTreeHead.root,
  });
  return ok ? { included: true } : { included: false, reason: 'inclusion proof does not reconstruct the signed root' };
}

export { generateEnrolledKeypair };
