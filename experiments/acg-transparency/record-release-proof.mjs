#!/usr/bin/env node
// record-release-proof.mjs -- LIVE evidence (ADR-0022 / LBA-REQ-031): record the REAL committed witness
// attestations {codespace, host-linux} into a signed Merkle transparency log and prove verify-before-install
// admits each. The log PRIVATE key is held out-of-repo (~/.config/lba/acg-keys/acg-log.pem, like the witness
// keys); only its PUBLIC key is committed (enrollment/log-allowlist.json). Deterministic (fixed timestamp)
// so the committed receipt is stable and re-derived offline by acg-transparency-log-live.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import crypto from 'node:crypto';
import { recordRelease, verifyReleaseInclusion, generateEnrolledKeypair } from './transparency-log.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const rj = (p) => JSON.parse(readFileSync(join(repo, p), 'utf8'));

const LOG_IDENTITY = 'acg-log:linux';
const TIMESTAMP = '2026-08-01T00:00:00.000Z';

// Load (or enroll once, out-of-repo) the transparency-log signing key.
const keyDir = join(homedir(), '.config', 'lba', 'acg-keys');
const keyPath = join(keyDir, 'acg-log.pem');
let privateKeyPem;
let publicKeyPem;
if (existsSync(keyPath)) {
  privateKeyPem = readFileSync(keyPath, 'utf8');
  publicKeyPem = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
} else {
  const kp = generateEnrolledKeypair();
  privateKeyPem = kp.privateKeyPem;
  publicKeyPem = kp.publicKeyPem;
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
}

const attestations = [
  rj('experiments/acg-provenance/attestations/codespace.attestation.json'),
  rj('experiments/acg-provenance/attestations/host-linux.attestation.json'),
];
const bundles = [
  rj('experiments/acg-quorum/witnesses/codespace.bundle.json'),
  rj('experiments/acg-quorum/witnesses/host-linux.bundle.json'),
];
const witnessAllowlist = rj('experiments/acg-provenance/enrollment/allowlist.json');

const receipt = recordRelease(attestations, { privateKeyPem, logIdentity: LOG_IDENTITY, timestamp: TIMESTAMP });

const decisions = attestations.map((attestation, i) => ({
  witnessIdentity: attestation.witnessIdentity,
  ...verifyReleaseInclusion({ attestation, inclusion: receipt.inclusions[i], signedTreeHead: receipt.signedTreeHead, logPublicKeyPem: publicKeyPem }),
}));
const allIncluded = decisions.every((d) => d.included);

const write = (rel, obj) => writeFileSync(join(here, rel), `${JSON.stringify(obj, null, 2)}\n`);
mkdirSync(join(here, 'enrollment'), { recursive: true });
write('enrollment/log-allowlist.json', { [LOG_IDENTITY]: publicKeyPem });
write('release-transparency-receipt.json', {
  schema: 'labview-benchmark-actor/acg-transparency-log-proof-v1',
  note: 'the REAL {codespace, host} witness attestations recorded into one Ed25519-signed Merkle transparency log (RFC 6962). Each attestation has an inclusion proof against the signed root; the log private key is held out-of-repo.',
  logIdentity: LOG_IDENTITY,
  ...receipt,
});
write('inclusion-decision-receipt.json', {
  schema: 'labview-benchmark-actor/acg-verify-before-install-receipt-v1',
  note: 'verify-before-install decision: an artifact is installable only if its witness attestation is INCLUDED in the signed transparency log. Both real witnesses are included -> install admitted.',
  logIdentity: LOG_IDENTITY,
  allIncluded,
  decisions,
});
// The self-contained provenance envelope a gated ext-v* Release carries and the reviewer-workstation verifies
// OFFLINE before installing the .vsix: each witness's bundle + attestation + inclusion proof, the signed tree
// head, and the enrolled witness/log allowlists.
write('release-provenance-bundle.json', {
  schema: 'labview-benchmark-actor/acg-release-provenance-bundle-v1',
  note: 'verify-before-install envelope: admit installation only if >= quorumMin witnesses each have an enrolled-witness-signed attestation that is included in the signed transparency log.',
  quorumMin: 2,
  logAllowlist: { [LOG_IDENTITY]: publicKeyPem },
  witnessAllowlist,
  signedTreeHead: receipt.signedTreeHead,
  witnesses: attestations.map((attestation, i) => ({
    witnessIdentity: attestation.witnessIdentity,
    bundle: bundles[i],
    attestation,
    inclusion: receipt.inclusions[i],
  })),
});

console.log(`transparency log: size=${receipt.signedTreeHead.size} root=${receipt.signedTreeHead.root.slice(0, 12)}... allIncluded=${allIncluded} [${decisions.map((d) => `${d.witnessIdentity}:${d.included}`).join(' ')}]`);
