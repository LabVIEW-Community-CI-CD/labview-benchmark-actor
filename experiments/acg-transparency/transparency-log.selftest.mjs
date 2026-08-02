// transparency-log.selftest.mjs -- dependency-free self-test for the RFC 6962 Merkle transparency log
// (ADR-0022 / LBA-REQ-031). Hand-anchored known-answers + exhaustive round-trip + tamper fail-closed.

import crypto from 'node:crypto';
import {
  EMPTY_ROOT, leafHash, nodeHash, merkleRoot,
  inclusionProof, verifyInclusion,
  consistencyProof, verifyConsistency,
  signTreeHead, verifySignedTreeHead,
  entryLeaf, recordRelease, verifyReleaseInclusion,
  generateEnrolledKeypair,
} from './transparency-log.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok  ${msg}`); } else { fail += 1; console.error(`  FAIL ${msg}`); } };

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const leaves = (n) => Array.from({ length: n }, (_, i) => leafHash(`d${i}`));

// ---- known-answer hashing (RFC 6962 domain separation) ----------------------------------------------
ok(EMPTY_ROOT === sha(Buffer.alloc(0)), 'MTH({}) is SHA-256 of the empty string');
ok(leafHash('d0') === sha(Buffer.concat([Buffer.from([0x00]), Buffer.from('d0')])), 'leaf hash is SHA-256(0x00 || data)');
{
  const L0 = leafHash('d0');
  const L1 = leafHash('d1');
  const expected = sha(Buffer.concat([Buffer.from([0x01]), Buffer.from(L0, 'hex'), Buffer.from(L1, 'hex')]));
  ok(nodeHash(L0, L1) === expected, 'node hash is SHA-256(0x01 || left || right)');
  ok(nodeHash(L0, L1) !== leafHash(L0 + L1), 'domain separation: a node hash can never collide with a leaf hash');
}

// ---- known-answer roots (n = 1, 2, 3) ---------------------------------------------------------------
ok(merkleRoot(leaves(1)) === leafHash('d0'), 'root of a single-leaf tree is its leaf hash');
ok(merkleRoot(leaves(2)) === nodeHash(leafHash('d0'), leafHash('d1')), 'root of a 2-leaf tree is node(L0,L1)');
{
  // n=3: largest power of 2 < 3 is 2 -> node( node(L0,L1), L2 ), NOT the "promote odd" shape.
  const expect3 = nodeHash(nodeHash(leafHash('d0'), leafHash('d1')), leafHash('d2'));
  ok(merkleRoot(leaves(3)) === expect3, 'root of a 3-leaf tree uses the largest-power-of-2 split');
}
ok(merkleRoot([]) === EMPTY_ROOT, 'empty tree root is the empty-string hash');

// ---- inclusion proofs: exhaustive round-trip for sizes 1..9 -----------------------------------------
let inclusionAllOk = true;
for (let n = 1; n <= 9; n += 1) {
  const ls = leaves(n);
  const root = merkleRoot(ls);
  for (let m = 0; m < n; m += 1) {
    const proof = inclusionProof(ls, m);
    if (!verifyInclusion({ leaf: ls[m], index: m, treeSize: n, proof, root })) inclusionAllOk = false;
  }
}
ok(inclusionAllOk, 'every leaf at sizes 1..9 has an inclusion proof that reconstructs the root');

// ---- inclusion proofs fail closed on tamper ---------------------------------------------------------
{
  const ls = leaves(7);
  const root = merkleRoot(ls);
  const proof = inclusionProof(ls, 3);
  ok(verifyInclusion({ leaf: ls[3], index: 3, treeSize: 7, proof, root }), 'baseline inclusion (n=7, index 3) verifies');
  ok(!verifyInclusion({ leaf: ls[4], index: 3, treeSize: 7, proof, root }), 'a substituted leaf fails inclusion');
  ok(!verifyInclusion({ leaf: ls[3], index: 4, treeSize: 7, proof, root }), 'the wrong index fails inclusion');
  const tampered = proof.slice(); tampered[0] = leafHash('evil');
  ok(!verifyInclusion({ leaf: ls[3], index: 3, treeSize: 7, proof: tampered, root }), 'a tampered audit path fails inclusion');
  ok(!verifyInclusion({ leaf: ls[3], index: 3, treeSize: 7, proof, root: leafHash('evil') }), 'a forged root fails inclusion');
}

// ---- consistency proofs: append-only round-trip + tamper --------------------------------------------
let consistencyAllOk = true;
for (let n = 2; n <= 9; n += 1) {
  const ls = leaves(n);
  const secondRoot = merkleRoot(ls);
  for (let m = 1; m < n; m += 1) {
    const firstRoot = merkleRoot(ls.slice(0, m));
    const proof = consistencyProof(ls, m);
    if (!verifyConsistency({ firstSize: m, firstRoot, secondSize: n, secondRoot, proof })) consistencyAllOk = false;
  }
}
ok(consistencyAllOk, 'every prefix m<n at sizes 2..9 has a consistency proof the new head honors');
{
  const ls = leaves(8);
  const secondRoot = merkleRoot(ls);
  const firstRoot = merkleRoot(ls.slice(0, 5));
  const proof = consistencyProof(ls, 5);
  ok(verifyConsistency({ firstSize: 5, firstRoot, secondSize: 8, secondRoot, proof }), 'baseline consistency (5 -> 8) verifies');
  const forgedFirst = merkleRoot([...ls.slice(0, 4), leafHash('rewritten')]);
  ok(!verifyConsistency({ firstSize: 5, firstRoot: forgedFirst, secondSize: 8, secondRoot, proof }),
    'a rewritten history (different old root) fails consistency -- the log is append-only');
}

// ---- signed tree heads (Ed25519, enrolled-key trust root) -------------------------------------------
{
  const log = generateEnrolledKeypair();
  const ls = leaves(4);
  const sth = signTreeHead({ size: 4, root: merkleRoot(ls) }, { privateKeyPem: log.privateKeyPem, logIdentity: 'acg-log:test', timestamp: '2026-08-01T00:00:00.000Z' });
  ok(verifySignedTreeHead(sth), 'a signed tree head verifies with its embedded key');
  ok(verifySignedTreeHead(sth, { publicKeyPem: log.publicKeyPem }), 'a signed tree head verifies against the enrolled log key');
  ok(!verifySignedTreeHead({ ...sth, root: leafHash('evil') }), 'a tampered root fails signed-tree-head verification');
  ok(!verifySignedTreeHead({ ...sth, size: 5 }), 'a tampered size fails signed-tree-head verification');
  const rogue = generateEnrolledKeypair();
  ok(!verifySignedTreeHead(sth, { publicKeyPem: rogue.publicKeyPem }), 'a rogue key does not verify the signed tree head');
}

// ---- end-to-end: record attestations, then verify-before-install ------------------------------------
{
  const log = generateEnrolledKeypair();
  const att = (digest, identity) => ({ schema: 'labview-benchmark-actor/acg-witness-attestation-v1', subject: { digest }, witnessIdentity: identity, algorithm: 'ed25519' });
  const attestations = [
    att('a'.repeat(64), 'acg-witness:codespace'),
    att('b'.repeat(64), 'acg-witness:host-linux'),
    att('c'.repeat(64), 'acg-witness:vbox'),
  ];
  const receipt = recordRelease(attestations, { privateKeyPem: log.privateKeyPem, logIdentity: 'acg-log:release', timestamp: '2026-08-01T00:00:00.000Z' });
  ok(receipt.inclusions.length === 3 && receipt.signedTreeHead.size === 3, 'recordRelease logs every attestation under one signed tree head');

  const decideAll = attestations.map((a, i) => verifyReleaseInclusion({ attestation: a, inclusion: receipt.inclusions[i], signedTreeHead: receipt.signedTreeHead, logPublicKeyPem: log.publicKeyPem }));
  ok(decideAll.every((d) => d.included), 'every logged attestation is verified as included (install allowed)');

  // an attestation NOT in the log cannot be passed off with someone else's proof.
  const outsider = att('d'.repeat(64), 'acg-witness:rogue');
  const forged = verifyReleaseInclusion({ attestation: outsider, inclusion: receipt.inclusions[0], signedTreeHead: receipt.signedTreeHead, logPublicKeyPem: log.publicKeyPem });
  ok(!forged.included, 'an un-logged attestation reusing a real proof is NOT included (install blocked)');

  // a tree head signed by the wrong log key is rejected.
  const rogueLog = generateEnrolledKeypair();
  const badKey = verifyReleaseInclusion({ attestation: attestations[0], inclusion: receipt.inclusions[0], signedTreeHead: receipt.signedTreeHead, logPublicKeyPem: rogueLog.publicKeyPem });
  ok(!badKey.included, 'inclusion under a tree head not signed by the enrolled log key is blocked');
}

console.log(`transparency-log self-test: ${pass}/${pass + fail} PASS`);
if (fail > 0) process.exit(1);
