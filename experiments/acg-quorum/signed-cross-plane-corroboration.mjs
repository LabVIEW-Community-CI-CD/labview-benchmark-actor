#!/usr/bin/env node
// signed-cross-plane-corroboration.mjs -- LBA-REQ-089 / ADR-0071. The genuine RE-SEAL of the corroboration the
// shipped 1.0.0 got wrong: a GENUINE cross-plane machine quorum (LBA-REQ-088, the durable attestation) carrying an
// ENROLLED human sign-off over it (ADR-0018 / LBA-REQ-027). This is the machine corroboration gate the composite
// release decision consumes -- now genuinely two-plane, not the single-plane quorum-1.0.0.json defect.
//
// It REUSES gateReleasePublish (the ADR-0018 quorum + enrolled-sign-off gate) and adds ONE requirement on top: the
// quorum must be genuinely cross-plane (verdict pass AND crossPlane), and its consensus must NAME the candidate
// (version + sourceCommit). It reimplements NO signing/gating. The human sign-off is signed with the reviewer's
// LOCAL Ed25519 key (never committed); this module only VERIFIES it against the enrolled allowlist -- it never
// synthesizes a signature.
//
// Pure + offline + dependency-free: the gate re-derives the decision + digest byte-stably in CI. Fails closed when
// the quorum is not cross-plane, is not pass, does not name the candidate, has no verified enrolled approval, or
// when the digest is tampered.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { gateReleasePublish } from '../acg-reviewer/sign-off.mjs';
import { canonicalize } from '../acg-provenance/attest.mjs';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/signed-cross-plane-corroboration@1';
export const REQUIREMENT = 'LBA-REQ-089';
export const ADR = 'ADR-0071';

// The decision over a receipt-shaped object: the ADR-0018 gate publishes (quorum pass + an enrolled approving
// sign-off over exactly this verdict) AND the quorum is genuinely cross-plane AND its consensus names the candidate.
export function computeDecision(r) {
  const reasons = [];
  const quorum = r?.quorum ?? {};
  const candidate = r?.candidate ?? {};
  const allow = r?.reviewerAllowlist ?? {};
  const minReviewers = r?.gate?.minReviewers ?? 1;

  const gate = gateReleasePublish({ quorumVerdict: quorum, signOffs: Array.isArray(r?.signOffs) ? r.signOffs : [], reviewerAllowlist: allow, minReviewers });
  if (!gate.publish) reasons.push('the machine corroboration gate (quorum + enrolled sign-off) would not publish: ' + gate.reasons.join('; '));

  const crossPlane = quorum.crossPlane === true;
  if (!crossPlane) reasons.push('the quorum is not genuinely cross-plane (it does not span both os-planes)');

  const namesCandidate = String(quorum?.consensus?.version) === String(candidate.version)
    && String(quorum?.consensus?.sourceCommit) === String(candidate.commit);
  if (!namesCandidate) reasons.push('the quorum consensus (version + sourceCommit) does not name the candidate');

  const proven = gate.publish && crossPlane && namesCandidate;
  return { proven, crossPlane, machinePublish: gate.publish, namesCandidate, approvals: gate.approvals, reasons, gate };
}

// Digest over the verdict-bearing fields only (not the prose). Recursive canonical-key sort (attest.mjs).
function canonical(receipt) {
  return canonicalize({
    schema: receipt.schema,
    requirement: receipt.requirement,
    adr: receipt.adr,
    candidate: receipt.candidate ?? null,
    provenance: receipt.provenance ?? null,
    quorum: receipt.quorum ?? null,
    signOffs: receipt.signOffs ?? [],
    reviewerAllowlist: receipt.reviewerAllowlist ?? null,
    gate: { minReviewers: receipt.gate?.minReviewers ?? 1 },
    verdict: { signedCrossPlaneCorroborated: receipt.verdict?.signedCrossPlaneCorroborated },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Assemble a re-seal from the genuine cross-plane quorum + the reviewer sign-off(s) + the enrolled allowlist.
export function buildReceipt({ candidate, provenance, quorum, signOffs, reviewerAllowlist, minReviewers = 1 }) {
  const draft = {
    schema: RECEIPT_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    candidate: candidate ?? null,
    provenance: provenance ?? null,
    quorum: quorum ?? null,
    signOffs: Array.isArray(signOffs) ? signOffs : [],
    reviewerAllowlist: reviewerAllowlist ?? {},
    gate: { minReviewers },
  };
  const d = computeDecision(draft);
  draft.decision = { machinePublish: d.machinePublish, crossPlane: d.crossPlane, namesCandidate: d.namesCandidate, approvals: d.approvals };
  draft.verdict = {
    signedCrossPlaneCorroborated: d.proven,
    reason: d.proven
      ? `extension ${candidate.version} @ ${String(candidate.commit).slice(0, 9)} is corroborated across BOTH os-planes (crossPlane, quorum pass) AND carries an enrolled human sign-off over that quorum (${d.approvals.join(', ')}) -- the genuine two-plane re-seal of the machine corroboration`
      : ('signed cross-plane corroboration blocked: ' + d.reasons.join('; ')),
  };
  draft.digest = digestReceipt(draft);
  return draft;
}

// Validate a committed re-seal: schema/requirement/adr, the decision proves, the verdict matches the rule, digest
// re-derives. Fail-closed.
export function validateReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (receipt?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (receipt?.adr !== ADR) findings.push(`adr must be ${ADR}`);
  const d = computeDecision(receipt ?? {});
  for (const r of d.reasons) findings.push(r);
  if (receipt?.verdict?.signedCrossPlaneCorroborated !== d.proven) {
    findings.push(`verdict.signedCrossPlaneCorroborated=${receipt?.verdict?.signedCrossPlaneCorroborated} contradicts the rule (${d.proven})`);
  }
  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, proofOk: !!receipt?.verdict?.signedCrossPlaneCorroborated && findings.length === 0, findings };
}

// CLI: validate the committed receipt next to this module (offline). Exit 1 on any finding.
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const receiptPath = join(here, 'signed-cross-plane-corroboration-receipt.json');
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    console.error(`[signed-cross-plane-corroboration] no committed re-seal receipt yet (awaiting the enrolled reviewer sign-off over the cross-plane quorum).`);
    process.exit(1);
  }
  const result = validateReceipt(receipt);
  if (!result.ok) {
    console.error(`[signed-cross-plane-corroboration] FAIL ${receiptPath}`);
    for (const f of result.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`[signed-cross-plane-corroboration] OK ${REQUIREMENT}: ${receipt.candidate.component} ${receipt.candidate.version} @ ${String(receipt.candidate.commit).slice(0, 9)} cross-plane corroborated + signed by ${receipt.decision.approvals.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
