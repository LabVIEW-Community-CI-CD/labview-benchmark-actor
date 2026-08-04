#!/usr/bin/env node
// meshAttested.mjs -- the composite MESH-RUN-ATTESTED decision (LBA-REQ-080, realizes ADR-0061). The integration
// capstone of the mesh subsystem: ONE fail-closed verdict that a release consumer checks to trust a mesh run
// end-to-end, composing the whole 072-079 chain and requiring every layer to hold AND to name the SAME run
// identity:
//
//   fulfillment (LBA-REQ-073) AND cross-plane parity (LBA-REQ-072) AND the verified tier (LBA-REQ-077) AND the
//   transparency inclusion (LBA-REQ-078) AND the append-only proof (LBA-REQ-079)  ->  mesh-run-attested@1
//
// It REUSES every sub-verifier (decideFulfillment / validateReceipt(parity) / validateVerifiedCollection /
// validateLoggedCollection / validateHistory) -- no new proof logic, only their conjunction + the cross-proof
// identity binding. Pure + rg-free + offline: the committed decision re-derives byte-stably from the committed
// source receipts (currency). Fails closed if ANY layer fails or the layers do not all name the same identity.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { decideFulfillment } from './meshFulfillment.mjs';
import { validateReceipt as validateParityReceipt } from '../launch-parity/launchParity.mjs';
import { validateVerifiedCollection } from './meshVerifiedTier.mjs';
import { validateLoggedCollection } from './meshTransparency.mjs';
import { validateHistory } from './meshLogHistory.mjs';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/mesh-run-attested@1';
export const REQUIREMENT = 'LBA-REQ-080';
export const ADR = 'ADR-0061';

// Decide whether a mesh run is FULLY ATTESTED by conjoining the five sub-proofs + binding them to one identity.
export function decideAttested(ctx = {}) {
  const { fulfillment, parity, tasking, collection, verified, logged, history, enrolledKeys = {}, logPublicKeyPem, historyPublicKeyPem } = ctx;
  const reasons = [];

  const fulfillmentDecision = decideFulfillment(fulfillment);
  const gFulfillment = fulfillmentDecision.fulfilled === true;
  if (!gFulfillment) reasons.push(`fulfillment (073): ${fulfillmentDecision.reasons.join('; ')}`);

  const parityResult = validateParityReceipt(parity);
  const gParity = parityResult.ok === true && parity?.parity?.parityProven === true;
  if (!gParity) reasons.push(`parity (072): ${(parityResult.findings ?? ['parity not proven']).join('; ')}`);

  const verifiedResult = validateVerifiedCollection(verified, { collection, tasking, enrolledKeys });
  const gVerified = verifiedResult.ok === true;
  if (!gVerified) reasons.push(`verified-tier (077): ${verifiedResult.findings.join('; ')}`);

  const loggedResult = validateLoggedCollection(logged, { verified, collection, tasking, enrolledKeys, logPublicKeyPem });
  const gLogged = loggedResult.ok === true;
  if (!gLogged) reasons.push(`transparency-inclusion (078): ${loggedResult.findings.join('; ')}`);

  const historyResult = validateHistory(history, { verified, logged, logPublicKeyPem: historyPublicKeyPem });
  const gAppendOnly = historyResult.ok === true;
  if (!gAppendOnly) reasons.push(`append-only (079): ${historyResult.findings.join('; ')}`);

  // Cross-proof identity binding: every layer must name the SAME benchmark run identity.
  const identities = {
    fulfillment: fulfillment?.identity ?? null,
    parity: parity?.launchIdentity ?? null,
    verified: verified?.identity ?? null,
    logged: logged?.identity ?? null,
  };
  const identity = identities.fulfillment;
  const identityConsistent = typeof identity === 'string' && identity.length > 0
    && Object.values(identities).every((i) => i === identity)
    && fulfillmentDecision.identity === identity;
  if (!identityConsistent) reasons.push(`identity: the sub-proofs do not all name the same run identity (${JSON.stringify(identities)})`);

  const gates = { fulfillment: gFulfillment, parity: gParity, verifiedTier: gVerified, transparencyInclusion: gLogged, appendOnly: gAppendOnly };
  const attested = Object.values(gates).every(Boolean) && identityConsistent;
  return { gates, identity, identityConsistent, attested, reasons };
}

function canonical(receipt) {
  return JSON.stringify({
    schema: receipt.schema, requirement: receipt.requirement, adr: receipt.adr,
    identity: receipt.identity ?? null,
    gates: receipt.gates ?? null,
    identityConsistent: receipt.identityConsistent ?? null,
    verdict: { attested: receipt.verdict?.attested },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build the composite mesh-run-attested receipt from the source receipts.
export function buildReceipt(ctx = {}) {
  const d = decideAttested(ctx);
  const receipt = {
    schema: RECEIPT_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    identity: d.identity,
    gates: d.gates,
    identityConsistent: d.identityConsistent,
    verdict: {
      attested: d.attested,
      reason: d.attested
        ? `mesh run ${String(d.identity).slice(0, 12)} is FULLY ATTESTED: fulfilled (073) + cross-plane parity (072) + enrolled-signed (077) + transparency-included (078) + append-only (079), all naming the same identity`
        : `mesh run NOT attested: ${d.reasons.join(' | ')}`,
    },
  };
  receipt.digest = digestReceipt(receipt);
  return receipt;
}

// Validate a committed attested receipt: it must re-derive byte-stably from the committed source receipts
// (currency), its verdict must match the re-derived decision, and its digest must re-derive. Fail-closed.
export function validateReceipt(receipt, ctx = {}) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (receipt?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (receipt?.adr !== ADR) findings.push(`adr must be ${ADR}`);

  const d = decideAttested(ctx);
  if (JSON.stringify(receipt?.gates) !== JSON.stringify(d.gates)) findings.push('gates do not match the re-derived decision (stale)');
  if (receipt?.identity !== d.identity) findings.push('identity does not match the re-derived decision');
  if (receipt?.identityConsistent !== d.identityConsistent) findings.push('identityConsistent does not match the re-derived decision');
  if (receipt?.verdict?.attested !== d.attested) findings.push(`verdict.attested=${receipt?.verdict?.attested} contradicts the re-derived decision (${d.attested})`);
  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match (tampered)');
  return { ok: findings.length === 0, proofOk: receipt?.verdict?.attested === true && findings.length === 0, findings };
}

// Read all committed mesh-run source receipts (offline) into a decision context.
export function committedContext(here) {
  const read = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
  return {
    fulfillment: read('mesh-run-fulfillment-receipt.json'),
    parity: read(join('..', 'launch-parity', 'cross-plane-launch-parity-receipt.json')),
    tasking: read('mesh-run-tasking.json'),
    collection: read('mesh-run-collection.json'),
    verified: read('mesh-run-verified-collection.json'),
    logged: read('mesh-run-logged-collection.json'),
    history: read('mesh-run-log-history.json'),
    enrolledKeys: read('mesh-actor-keys.json').enrolled ?? {},
    logPublicKeyPem: read('mesh-log-key.json').publicKeyPem,
    historyPublicKeyPem: read('mesh-log-history-key.json').publicKeyPem,
  };
}

// CLI: validate the committed attested decision against the committed source receipts (offline, deterministic).
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const ctx = committedContext(here);
  const receipt = JSON.parse(readFileSync(join(here, 'mesh-run-attested-receipt.json'), 'utf8'));
  const r = validateReceipt(receipt, ctx);
  if (!r.ok || !r.proofOk) {
    console.error('[mesh-run-attested] FAIL');
    for (const f of r.findings) console.error(`  - ${f}`);
    if (r.ok && !r.proofOk) console.error(`  - verdict is not attested: ${receipt.verdict?.reason}`);
    process.exit(1);
  }
  const g = receipt.gates;
  console.log(`[mesh-run-attested] OK ${REQUIREMENT}: run ${String(receipt.identity).slice(0, 12)} fully attested [fulfillment=${g.fulfillment} parity=${g.parity} verified=${g.verifiedTier} inclusion=${g.transparencyInclusion} append-only=${g.appendOnly}]`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
