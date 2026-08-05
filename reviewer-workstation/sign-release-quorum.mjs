#!/usr/bin/env node
// sign-release-quorum.mjs -- a DETERMINISTIC, offline reviewer machine sign-off over a committed quorum verdict
// (ADR-0018 / LBA-REQ-027), replacing the net-drive ceremony (which times out). The reviewer runs this LOCALLY
// with their enrolled Ed25519 PRIVATE key (kept local, NEVER committed): it reads the committed cross-plane
// quorum, signs its bundleDigest, and writes the acg-human-signoff-v1 -- which carries only PUBLIC material
// (reviewer id, station, public key, signature) and is safe to commit. No network, no VM, no timeout.
//
// The signed bytes are exactly `${reviewer}\n${decision}\n${station}\n${bundleDigest(quorum)}` (sign-off.mjs), so
// the sign-off is verifiable by anyone against the committed quorum + the enrolled allowlist.
//
// Usage:
//   node reviewer-workstation/sign-release-quorum.mjs --key <privkey.pem> --reviewer <id> \
//        [--station WINDOWS_VM|LINUX_CODESPACE] [--quorum <attestation-or-quorum.json>] [--out <signoff.json>]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { signReleaseSignOff } from '../experiments/acg-reviewer/sign-off.mjs';
import { bundleDigest } from '../experiments/acg-provenance/attest.mjs';

// Accept either a cross-plane-attestation receipt (with a `.quorum`) or a bare quorum-verdict object.
export function quorumFromDoc(doc) {
  return doc && typeof doc === 'object' && doc.quorum ? doc.quorum : doc;
}

function main() {
  const argv = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  }
  if (!opt.key || !opt.reviewer) {
    console.error('usage: sign-release-quorum.mjs --key <privkey.pem> --reviewer <id> [--station WINDOWS_VM|LINUX_CODESPACE] [--quorum <path>] [--out <path>]');
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const quorumPath = typeof opt.quorum === 'string'
    ? opt.quorum
    : join(here, '..', 'experiments', 'acg-quorum', 'cross-plane-attestation-receipt.json');
  const quorum = quorumFromDoc(JSON.parse(readFileSync(quorumPath, 'utf8')));
  const privateKeyPem = readFileSync(opt.key, 'utf8');
  const station = typeof opt.station === 'string' ? opt.station : 'WINDOWS_VM';
  const signOff = signReleaseSignOff(quorum, { privateKeyPem, reviewer: opt.reviewer, decision: 'approve', station });
  console.error(`signed quorum bundleDigest=${bundleDigest(quorum)} as ${opt.reviewer} @ ${station} (crossPlane=${quorum.crossPlane}, verdict=${quorum.verdict})`);
  const json = JSON.stringify(signOff, null, 2);
  if (typeof opt.out === 'string') {
    writeFileSync(opt.out, json + '\n');
    console.error(`wrote ${opt.out} -- send this (it is PUBLIC; your private key stays local).`);
  } else {
    process.stdout.write(json + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
