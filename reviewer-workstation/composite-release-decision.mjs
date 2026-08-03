#!/usr/bin/env node
// composite-release-decision-receipt@1 builder + validator (LBA-REQ-070, realizes ADR-0051). Seals, as a
// committed fail-closed receipt, the CAPSTONE release decision: a candidate publishes ONLY when BOTH the MACHINE
// corroboration gate (gateReleasePublish -- quorum + an enrolled human sign-off over the quorum, ADR-0018) AND
// the HUMAN visual gate (gateVisualReview -- an enrolled signed PASS of the built candidate, LBA-REQ-057) pass,
// AND both are bound to the SAME net-staged candidate (LBA-REQ-068/069).
//
// The NEW governance property is the CROSS-GATE BINDING: the machine quorum consensus (version + sourceCommit),
// the human visual verdict target (component/version/commit/vsixSha256), and the net staging drive all name the
// SAME candidate -- so you cannot machine-PASS candidate A, human-PASS candidate B, and publish. It REUSES
// gateReleaseWithReview (which composes gateReleasePublish + gateVisualReview) + candidatesMatch/stagedOk from
// the LBA-REQ-069 module; it reimplements NO signing/gating.
//
// Pure + rg-free + offline: the committed receipt re-derives its decision + binding + digest byte-stably in CI
// (no VM / network / live human). Fails closed when either gate would not publish, when the machine consensus or
// the visual target does not name the staged candidate, or when the digest is tampered.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { canonicalize } from '../experiments/handoff-beacon/reviewerVerdict.mjs';
import { gateReleaseWithReview } from '../experiments/handoff-beacon/release-with-review.mjs';
import { candidatesMatch, stagedOk } from './release-with-review-drive.mjs';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/composite-release-decision-receipt@1';
export const REQUIREMENT = 'LBA-REQ-070';
export const ADR = 'ADR-0051';

// Compute the composite decision + the cross-gate candidate binding over a receipt-shaped object, REUSING
// gateReleaseWithReview (machine gate AND visual gate). Returns the per-check booleans + `proven` + reasons.
export function computeDecision(r) {
  const reasons = [];
  const candidate = r?.candidate ?? {};
  const staged = r?.staged ?? {};
  const machine = r?.machine ?? {};
  const visual = r?.visual ?? {};
  const allow = r?.reviewerAllowlist ?? {};
  const minReviewers = r?.gate?.minReviewers ?? 1;
  const minVisualReviewers = r?.gate?.minVisualReviewers ?? 1;

  const decision = gateReleaseWithReview({
    quorumVerdict: machine.quorumVerdict,
    quorumSignOffs: Array.isArray(machine.signOffs) ? machine.signOffs : [],
    verdict: visual.verdict,
    verdictSignOffs: visual.signOff ? [visual.signOff] : [],
    reviewerAllowlist: allow,
    minReviewers,
    minVisualReviewers,
  });
  const machinePublish = decision.machine?.publish === true;
  const visualPublish = decision.visual?.publish === true;
  if (!machinePublish) reasons.push('the machine corroboration gate would not publish: ' + (decision.machine?.reasons ?? []).join('; '));
  if (!visualPublish) reasons.push('the human visual gate would not publish: ' + (decision.visual?.reasons ?? []).join('; '));

  const stagedOverNet = stagedOk(staged, candidate);
  if (!stagedOverNet) reasons.push('the candidate was not staged over net by a matched WIN drive bound to the same component+version');

  const visualTargetBound = candidatesMatch(candidate, visual.verdict?.target);
  if (!visualTargetBound) reasons.push('the human visual verdict target does not name the staged candidate (component/version/commit/vsixSha256)');

  const consensus = machine.quorumVerdict?.consensus ?? {};
  const machineConsensusBound = String(consensus.version) === String(candidate.version)
    && String(consensus.sourceCommit) === String(candidate.commit);
  if (!machineConsensusBound) reasons.push('the machine quorum consensus (version + sourceCommit) does not name the staged candidate');

  const proven = machinePublish && visualPublish && stagedOverNet && visualTargetBound && machineConsensusBound;
  return { machinePublish, visualPublish, stagedOverNet, visualTargetBound, machineConsensusBound, proven, reasons, decision };
}

// Digest over the verdict-bearing fields (candidate, staging identity, the machine quorum + sign-offs, the
// visual verdict + sign-off, the enrolled allowlist, the gate thresholds, and the aggregate verdict) -- NOT the
// descriptive prose. Recursive canonical-key sort so nested quorum/verdict/signOff order is stable.
function canonical(receipt) {
  return canonicalize({
    schema: receipt.schema,
    requirement: receipt.requirement,
    adr: receipt.adr,
    candidate: receipt.candidate ?? null,
    staged: {
      drive: receipt.staged?.drive ?? null,
      vm: receipt.staged?.vm ?? null,
      matched: receipt.staged?.matched === true,
      frame: receipt.staged?.frame ?? null,
      candidate: receipt.staged?.candidate ?? null,
    },
    machine: receipt.machine ?? null,
    visual: receipt.visual ?? null,
    reviewerAllowlist: receipt.reviewerAllowlist ?? null,
    gate: { minReviewers: receipt.gate?.minReviewers ?? 1, minVisualReviewers: receipt.gate?.minVisualReviewers ?? 1 },
    verdict: { compositeReleaseProven: receipt.verdict?.compositeReleaseProven },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build a composite-release-decision receipt from a captured round: the candidate, the net staging drive, the
// machine `{ quorumVerdict, signOffs }`, and the visual `{ verdict, signOff }` + the enrolled reviewer allowlist.
export function buildReceipt(capture) {
  const candidate = capture.candidate ?? null;
  const staged = capture.staged ?? null;
  const machine = capture.machine ?? null;
  const visual = capture.visual ?? null;
  const reviewerAllowlist = capture.reviewerAllowlist ?? {};
  const gate = { minReviewers: capture.minReviewers ?? 1, minVisualReviewers: capture.minVisualReviewers ?? 1 };
  const draft = {
    schema: RECEIPT_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    transport: capture.transport
      ?? 'lbabus net -- bus-msg@1, ADR-0003/0004 (TCP 7420; guest->host via VirtualBox NAT 10.0.2.2). NET-ONLY: staging rides net, not a GitHub Discussion (ADR-0047).',
    capability: capture.capability ?? null,
    candidate,
    staged,
    machine,
    visual,
    reviewerAllowlist,
    gate,
    capturedAt: capture.capturedAt ?? null,
    note: capture.note ?? null,
  };
  const d = computeDecision(draft);
  draft.binding = {
    machinePublish: d.machinePublish,
    visualPublish: d.visualPublish,
    stagedOverNet: d.stagedOverNet,
    visualTargetBound: d.visualTargetBound,
    machineConsensusBound: d.machineConsensusBound,
  };
  draft.decision = { schema: d.decision.schema, publish: d.decision.publish === true, machinePublish: d.machinePublish, visualPublish: d.visualPublish };
  draft.verdict = {
    compositeReleaseProven: d.proven,
    reason: d.proven
      ? `both gates publish for ${candidate.component} ${candidate.version}: machine quorum + enrolled sign-off (ADR-0018) AND human visual PASS (LBA-REQ-057), bound to the same net-staged candidate`
      : ('composite decision blocked: ' + d.reasons.join('; ')),
  };
  draft.digest = digestReceipt(draft);
  return draft;
}

// Validate a committed receipt: schema/requirement/adr, both gates publish, the machine consensus + the visual
// target both name the net-staged candidate, the verdict matches the rule, and the digest re-derives. Fail-closed.
export function validateReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (receipt?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (receipt?.adr !== ADR) findings.push(`adr must be ${ADR}`);
  const d = computeDecision(receipt ?? {});
  for (const r of d.reasons) findings.push(r);
  if (receipt?.verdict?.compositeReleaseProven !== d.proven) {
    findings.push(`verdict.compositeReleaseProven=${receipt?.verdict?.compositeReleaseProven} contradicts the rule (${d.proven})`);
  }
  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, proofOk: !!receipt?.verdict?.compositeReleaseProven && findings.length === 0, findings };
}

// CLI: validate the committed receipt next to this module (offline, deterministic). Exit 1 on any finding.
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const receiptPath = join(here, 'composite-release-decision-receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const result = validateReceipt(receipt);
  if (!result.ok) {
    console.error(`[composite-release-decision] FAIL ${receiptPath}`);
    for (const f of result.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`[composite-release-decision] OK ${REQUIREMENT}: ${receipt.candidate.component} ${receipt.candidate.version} publishes (machine=${result.proofOk && receipt.binding.machinePublish}, visual=${receipt.binding.visualPublish}); verdict proven=${result.proofOk}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
