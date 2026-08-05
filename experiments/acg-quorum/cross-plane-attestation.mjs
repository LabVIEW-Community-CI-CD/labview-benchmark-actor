#!/usr/bin/env node
// cross-plane-attestation.mjs -- LBA-REQ-088 / ADR-0070. Captures the LIVE genuine cross-plane corroboration
// (LBA-REQ-087, the acg-cross-plane-corroboration workflow) as a DURABLE, committed, tamper-evident attestation.
//
// Two GENUINE witnesses -- one produced on the LINUX plane (a real ubuntu-latest runner) and one on the WINDOWS
// plane (a real windows-latest runner) from the SAME commit -- are quorum-compared (compare-witnesses.mjs, the
// ADR-0068 os-plane quorum). The receipt is CROSS-PLANE CORROBORATED only when that quorum PASSES *and* spans
// BOTH os-planes (crossPlane). It FAILS CLOSED on a single-plane witness set (the shipped 1.0.0 defect: LINUX +
// VMware-Ubuntu were BOTH the linux plane), a non-pass gate verdict, a quorum that does not re-derive from the
// embedded witnesses, or a tampered digest.
//
// This is the honest MACHINE half of the 1.0.0 re-seal: a genuine two-plane machine corroboration, sourced from
// real CI planes with recorded provenance (the workflow run that produced each witness). The HUMAN half -- an
// enrolled Ed25519 sign-off over this quorum + a signed visual verdict (composite-release-decision, LBA-REQ-070)
// -- stays the reviewer's local-key act and is deliberately NOT synthesized here.
//
// Pure + offline + dependency-free: the gate re-derives the quorum + digest byte-stably in CI (no VM / network /
// live human), so a valid verdict can never be paired with a different (tampered) witness set.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { compareWitnesses } from './compare-witnesses.mjs';
import { canonicalize } from '../acg-provenance/attest.mjs';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/cross-plane-corroboration-attestation@1';
export const REQUIREMENT = 'LBA-REQ-088';
export const ADR = 'ADR-0070';

// The corroboration verdict over a receipt-shaped object: re-derive the os-plane quorum from the embedded
// witnesses; CORROBORATED iff the quorum passes AND spans both os-planes (crossPlane). Also report the distinct
// os-planes the witness set actually spans (sorted) so a single-plane set is self-evident.
export function computeVerdict(receipt) {
  const witnesses = Array.isArray(receipt?.witnesses) ? receipt.witnesses : [];
  const quorum = compareWitnesses(witnesses);
  const planes = [...new Set(witnesses.map((w) => String(w?.os ?? '?').toLowerCase()))].sort();
  const crossPlaneCorroborated = quorum.verdict === 'pass' && quorum.crossPlane === true;
  return { quorum, planes, crossPlaneCorroborated };
}

// Digest over the verdict-bearing fields (schema/requirement/adr, provenance, the embedded witnesses, the derived
// quorum, and the aggregate verdict) -- NOT the descriptive prose. Recursive canonical-key sort (attest.mjs).
function canonical(receipt) {
  return canonicalize({
    schema: receipt.schema,
    requirement: receipt.requirement,
    adr: receipt.adr,
    provenance: receipt.provenance ?? null,
    witnesses: receipt.witnesses ?? [],
    quorum: receipt.quorum ?? null,
    verdict: { crossPlaneCorroborated: receipt.verdict?.crossPlaneCorroborated },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build an attestation from the captured genuine witnesses + their CI provenance. Provenance shape:
//   { workflow, runId, runUrl, commit, capturedAt }  -- the workflow run that produced the witnesses.
export function buildReceipt({ provenance, witnesses }) {
  const draft = {
    schema: RECEIPT_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    provenance: provenance ?? null,
    witnesses: Array.isArray(witnesses) ? witnesses : [],
  };
  const d = computeVerdict(draft);
  draft.quorum = d.quorum;
  draft.planes = d.planes;
  draft.verdict = {
    crossPlaneCorroborated: d.crossPlaneCorroborated,
    reason: d.crossPlaneCorroborated
      ? `two genuine planes (${d.planes.join(' + ')}) corroborate at ${d.quorum.consensus.version}/${String(d.quorum.consensus.sourceCommit).slice(0, 9)}: quorum pass, confidence ${d.quorum.confidence}, crossPlane over version/sourceCommit/verdict/seriesHash`
      : `cross-plane corroboration withheld: quorum=${d.quorum.verdict}, crossPlane=${d.quorum.crossPlane}, planes=${d.planes.join('+') || 'none'}`,
  };
  draft.digest = digestReceipt(draft);
  return draft;
}

// Validate a committed attestation: schema/requirement/adr, the quorum re-derives from the embedded witnesses,
// the set is genuinely cross-plane corroborated, the verdict matches the rule, and the digest re-derives. Fail-closed.
export function validateReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (receipt?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (receipt?.adr !== ADR) findings.push(`adr must be ${ADR}`);
  const d = computeVerdict(receipt ?? {});
  if (canonicalize(receipt?.quorum ?? null) !== canonicalize(d.quorum)) {
    findings.push('the committed quorum does not re-derive from the embedded witnesses (tampered)');
  }
  if (!d.crossPlaneCorroborated) {
    findings.push(`not cross-plane corroborated: quorum=${d.quorum.verdict}, crossPlane=${d.quorum.crossPlane}, planes=${d.planes.join('+') || 'none'}`);
  }
  if (receipt?.verdict?.crossPlaneCorroborated !== d.crossPlaneCorroborated) {
    findings.push(`verdict.crossPlaneCorroborated=${receipt?.verdict?.crossPlaneCorroborated} contradicts the rule (${d.crossPlaneCorroborated})`);
  }
  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, proofOk: !!receipt?.verdict?.crossPlaneCorroborated && findings.length === 0, findings };
}

// CLI: validate the committed receipt next to this module (offline, deterministic). Exit 1 on any finding.
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const receiptPath = join(here, 'cross-plane-attestation-receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const result = validateReceipt(receipt);
  if (!result.ok) {
    console.error(`[cross-plane-attestation] FAIL ${receiptPath}`);
    for (const f of result.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`[cross-plane-attestation] OK ${REQUIREMENT}: ${receipt.planes.join(' + ')} corroborate at ${receipt.quorum.consensus.version}/${String(receipt.quorum.consensus.sourceCommit).slice(0, 9)} (confidence ${receipt.quorum.confidence}, crossPlane); provenance run ${receipt.provenance?.runId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
