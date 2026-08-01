#!/usr/bin/env node
// verify-release-inclusion.mjs -- reviewer-workstation VERIFY-BEFORE-INSTALL (ADR-0022 / LBA-REQ-031,
// closing LBA-REQ-025's reviewer-workstation clause). Given a release-provenance bundle, admit installation
// ONLY when at least `quorumMin` witnesses each have (1) an attestation signed by an ENROLLED witness that
// binds to its own bundle, AND (2) an inclusion proof placing that attestation in the Ed25519-SIGNED Merkle
// transparency log. Fail-closed: exit 0 admits install, any non-zero BLOCKS it. Dependency-free.
//
// Usage: node verify-release-inclusion.mjs [--provenance <path>]
//   default path: <this dir>/release-provenance-bundle.json

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { verifyWitnessAttestation } from '../acg-provenance/attest.mjs';
import { verifyReleaseInclusion } from './transparency-log.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

export function verifyReleaseProvenance(bundle) {
  const reasons = [];
  const quorumMin = Number.isInteger(bundle?.quorumMin) ? bundle.quorumMin : 2;
  const witnessAllowlist = bundle?.witnessAllowlist ?? {};
  const logAllowlist = bundle?.logAllowlist ?? {};
  const sth = bundle?.signedTreeHead;
  const logPublicKeyPem = sth ? logAllowlist[sth.logIdentity] : undefined;
  if (!logPublicKeyPem) reasons.push('the signing log identity is not enrolled in the log allowlist');

  let verified = 0;
  for (const w of bundle?.witnesses ?? []) {
    const attOk = verifyWitnessAttestation(w.bundle, w.attestation, { allowlist: witnessAllowlist });
    if (!attOk.ok) { reasons.push(`${w.witnessIdentity}: attestation does not verify (${(attOk.reasons || []).join('; ') || 'invalid'})`); continue; }
    const inc = verifyReleaseInclusion({ attestation: w.attestation, inclusion: w.inclusion, signedTreeHead: sth, logPublicKeyPem });
    if (!inc.included) { reasons.push(`${w.witnessIdentity}: ${inc.reason}`); continue; }
    verified += 1;
  }
  const admit = reasons.length === 0 && verified >= quorumMin;
  if (!admit && verified < quorumMin) reasons.push(`verified ${verified} witness(es); need >= ${quorumMin}`);
  return { admit, verified, quorumMin, reasons };
}

// CLI
if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) {
  const pArg = argOf('--provenance', join(here, 'release-provenance-bundle.json'));
  const provenancePath = isAbsolute(pArg) ? pArg : resolve(process.cwd(), pArg);
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(provenancePath, 'utf8'));
  } catch (err) {
    console.error(`verify-before-install: BLOCK -- cannot read provenance bundle ${provenancePath}: ${err.message}`);
    process.exit(1);
  }
  const result = verifyReleaseProvenance(bundle);
  if (result.admit) {
    console.log(`verify-before-install: ADMIT -- ${result.verified}/${result.quorumMin} witnesses attested + logged`);
    process.exit(0);
  }
  console.error(`verify-before-install: BLOCK -- ${result.reasons.join('; ')}`);
  process.exit(1);
}
