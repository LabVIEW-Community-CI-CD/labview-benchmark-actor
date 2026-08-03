#!/usr/bin/env node
// enroll-reviewer.mjs -- mint an ENROLLED Ed25519 reviewer keypair for the visual-verdict signing
// (LBA-REQ-057, ADR-0037). Writes the PRIVATE key to --key-out (0600, kept LOCAL to the reviewer station, never
// committed) and prints the reviewer -> publicKeyPem allowlist entry (JSON) on stdout, to be added to the
// committed reviewer allowlist (tools/collab-cli/reviewer-allowlist.json). Reuses the same Ed25519 enrollment as
// the machine witnesses (acg-provenance/attest.mjs), via the dependency-free reviewerVerdict.mjs.
//
// Usage: node reviewer-workstation/enroll-reviewer.mjs --reviewer <id> --key-out <priv.pem>

import { writeFileSync, chmodSync } from 'node:fs';
import { generateEnrolledKeypair } from '../experiments/handoff-beacon/reviewerVerdict.mjs';

const arg = (k, d = '') => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
};

const reviewer = arg('reviewer');
const keyOut = arg('key-out');
if (!reviewer || !keyOut) {
  console.error('usage: enroll-reviewer.mjs --reviewer <id> --key-out <priv.pem>');
  process.exit(2);
}

const { privateKeyPem, publicKeyPem } = generateEnrolledKeypair();
writeFileSync(keyOut, privateKeyPem);
try { chmodSync(keyOut, 0o600); } catch { /* best-effort on non-POSIX */ }

// The allowlist entry (public key) goes into the committed reviewer allowlist; the private key stays local.
process.stdout.write(`${JSON.stringify({ [reviewer]: publicKeyPem }, null, 2)}\n`);
console.error(`enrolled "${reviewer}": private key -> ${keyOut} (keep it local; NEVER commit it).`);
console.error('Add the public-key entry above to tools/collab-cli/reviewer-allowlist.json and set');
console.error('labviewBenchmarkActor.reviewerId + labviewBenchmarkActor.reviewerKeyPath in the reviewer VM.');
