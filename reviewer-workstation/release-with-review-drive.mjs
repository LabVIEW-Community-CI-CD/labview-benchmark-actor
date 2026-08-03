#!/usr/bin/env node
// release-with-review-drive-receipt@1 builder + validator (LBA-REQ-069, realizes ADR-0050). Seals, as a
// committed fail-closed receipt, ONE bound release-with-review loop over the net-only bus: the host drove the
// reviewer VM to STAGE a release candidate over `lbabus net` (LBA-REQ-068), a human SIGNED a visual PASS/FAIL of
// THAT candidate with an enrolled Ed25519 reviewer key (LBA-REQ-057), and the signed verdict ANNOUNCED over net
// with its semantic type (LBA-REQ-058) -- all bound to the SAME candidate identity.
//
// The NEW governance property is the BINDING: the candidate the human signed is provably the candidate the VM
// staged and the candidate the bus announced (component/version/commit/vsixSha256), so you cannot stage one
// candidate, sign a different one, and announce a third. This composes LBA-REQ-068 (net drive) + LBA-REQ-057
// (signed visual verdict) + LBA-REQ-058 (bus announce) into one governed loop; it REUSES their primitives
// (verifyReviewerVerdict / gateVisualReview / buildVerdictBusPost) rather than reimplementing them.
//
// Pure + rg-free + offline: the committed receipt re-derives its binding + verdict + digest byte-stably in CI
// (no VM / network / live human). Fails closed on a candidate the verdict did not cover, a sign-off that does
// not verify against the enrolled key, a gate that would not publish, a mis-derived announce, or a tampered
// digest.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  canonicalize,
  verifyReviewerVerdict,
  gateVisualReview,
  buildVerdictBusPost,
} from '../experiments/handoff-beacon/reviewerVerdict.mjs';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/release-with-review-drive-receipt@1';
export const REQUIREMENT = 'LBA-REQ-069';
export const ADR = 'ADR-0050';

// The `net` envelope type set a frame may carry (BusWire.Types, ADR-0003/0039). The staged frame + the announce
// frame must be one of these (net-only; no Discussion type exists).
export const NET_TYPES = ['HELLO', 'CLAIM', 'ACK', 'HANDOFF', 'DONE', 'PROGRESS', 'NOTE', 'RESOLVED', 'REFINE', 'BLOCKED'];

// The candidate identity (the 4 fields the reviewer verdict binds to). Two identities match iff all four agree.
export function candidatesMatch(a, b) {
  if (!a || !b) return false;
  return String(a.component) === String(b.component)
    && String(a.version) === String(b.version)
    && String(a.commit) === String(b.commit)
    && String(a.vsixSha256) === String(b.vsixSha256);
}

// The staging drive closed the loop over net iff it is a matched WIN frame of an allowed net type carrying a
// task + payload, bound to the candidate's component + version (what the VM reported it staged).
export function stagedOk(staged, candidate) {
  const s = staged ?? {};
  const c = candidate ?? {};
  return s.matched === true && !!s.frame
    && s.frame.senderId === 'WIN'
    && NET_TYPES.includes(s.frame.type)
    && typeof s.frame.task === 'string' && s.frame.task.length > 0
    && typeof s.frame.payload === 'string' && s.frame.payload.length > 0
    && s.candidate && String(s.candidate.component) === String(c.component) && String(s.candidate.version) === String(c.version);
}

// Compute the full binding over a receipt-shaped object, REUSING the existing verdict primitives. Returns the
// per-check booleans + the aggregate `proven` + human-readable reasons for any failure.
export function computeBinding(r) {
  const reasons = [];
  const candidate = r?.candidate ?? {};
  const staged = r?.staged ?? {};
  const review = r?.review ?? {};
  const verdict = review.verdict ?? {};
  const signOff = review.signOff ?? {};
  const allow = r?.reviewerAllowlist ?? {};
  const minVisualReviewers = r?.minVisualReviewers ?? r?.gate?.minVisualReviewers ?? 1;

  const stagedOverNet = stagedOk(staged, candidate);
  if (!stagedOverNet) reasons.push('the candidate was not staged over net by a matched WIN drive bound to the same component+version');

  const candidateMatchesVerdictTarget = candidatesMatch(candidate, verdict.target);
  if (!candidateMatchesVerdictTarget) reasons.push('the signed verdict target does not match the staged release candidate (component/version/commit/vsixSha256)');

  const vv = verifyReviewerVerdict(verdict, signOff, { reviewerAllowlist: allow });
  const verdictVerified = vv.ok;
  if (!verdictVerified) reasons.push('the reviewer sign-off does not verify: ' + vv.reasons.join('; '));

  const gate = gateVisualReview({ verdict, signOffs: [signOff], reviewerAllowlist: allow, minReviewers: minVisualReviewers });
  const gatePublish = gate.publish === true;
  if (!gatePublish) reasons.push('the visual-review gate would not publish: ' + gate.reasons.join('; '));

  const derived = buildVerdictBusPost({ verdict, signOff });
  const ann = r?.announce ?? {};
  const announceDerivedOk = ann.type === derived.type && ann.task === derived.task && ann.ref === derived.ref
    && ann.frame && ann.frame.senderId === 'WIN' && ann.frame.type === derived.type && ann.frame.task === derived.task
    && NET_TYPES.includes(derived.type);
  if (!announceDerivedOk) reasons.push('the net announce is not correctly derived from the signed verdict (type/task/ref) or is not a WIN net frame');

  const proven = stagedOverNet && candidateMatchesVerdictTarget && verdictVerified && gatePublish && announceDerivedOk;
  return { stagedOverNet, candidateMatchesVerdictTarget, verdictVerified, gatePublish, announceDerivedOk, proven, reasons };
}

// Digest over the verdict-bearing fields (the candidate, the staging identity, the signed review, the enrolled
// allowlist, the announce, and the aggregate verdict) -- NOT the descriptive prose (transport / capability /
// note / capturedAt). Uses the recursive canonical-key sort so nested review/verdict/signOff order is stable.
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
    review: receipt.review ?? null,
    reviewerAllowlist: receipt.reviewerAllowlist ?? null,
    announce: receipt.announce ?? null,
    gate: { minVisualReviewers: receipt.gate?.minVisualReviewers ?? 1 },
    verdict: { releaseWithReviewProven: receipt.verdict?.releaseWithReviewProven },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build a release-with-review-drive receipt from a captured round: the candidate, the net staging drive, and the
// signed review `{ verdict, signOff }` + the enrolled reviewer allowlist. The announce is DERIVED from the
// signed verdict (buildVerdictBusPost, LBA-REQ-058) so it is provably correct by construction.
export function buildReceipt(capture) {
  const candidate = capture.candidate ?? null;
  const staged = capture.staged ?? null;
  const review = capture.review ?? null;
  const reviewerAllowlist = capture.reviewerAllowlist ?? {};
  const minVisualReviewers = capture.minVisualReviewers ?? 1;
  const derived = buildVerdictBusPost(review ?? {});
  const announce = {
    type: derived.type,
    task: derived.task,
    ref: derived.ref,
    reviewer: derived.reviewer,
    summary: derived.summary,
    frame: { type: derived.type, task: derived.task, senderId: 'WIN', matched: true },
  };
  const draft = {
    schema: RECEIPT_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    transport: capture.transport
      ?? 'lbabus net -- bus-msg@1, ADR-0003/0004 (TCP 7420; guest->host via VirtualBox NAT 10.0.2.2). NET-ONLY: staging + the verdict announce ride net, not a GitHub Discussion (ADR-0047).',
    capability: capture.capability ?? null,
    candidate,
    staged,
    review,
    reviewerAllowlist,
    announce,
    gate: { minVisualReviewers },
    capturedAt: capture.capturedAt ?? null,
    note: capture.note ?? null,
  };
  const b = computeBinding({ ...draft, minVisualReviewers });
  draft.binding = {
    stagedOverNet: b.stagedOverNet,
    candidateMatchesVerdictTarget: b.candidateMatchesVerdictTarget,
    verdictVerified: b.verdictVerified,
    gatePublish: b.gatePublish,
    announceDerivedOk: b.announceDerivedOk,
  };
  draft.verdict = {
    releaseWithReviewProven: b.proven,
    reason: b.proven
      ? `the net-staged candidate ${candidate.component} ${candidate.version} was signed ${String(review.verdict.verdict).toUpperCase()} by an enrolled reviewer + announced ${derived.type} over net -- one bound release-with-review loop`
      : ('binding incomplete: ' + b.reasons.join('; ')),
  };
  draft.digest = digestReceipt(draft);
  return draft;
}

// Validate a committed receipt: schema/requirement/adr, the full binding (staged-over-net, candidate<->verdict
// target, verified sign-off, gate publishes, announce correctly derived), the verdict matches the rule, and the
// digest re-derives. Fail-closed.
export function validateReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (receipt?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (receipt?.adr !== ADR) findings.push(`adr must be ${ADR}`);
  const b = computeBinding({
    candidate: receipt?.candidate,
    staged: receipt?.staged,
    review: receipt?.review,
    reviewerAllowlist: receipt?.reviewerAllowlist,
    announce: receipt?.announce,
    minVisualReviewers: receipt?.gate?.minVisualReviewers ?? 1,
  });
  for (const r of b.reasons) findings.push(r);
  if (receipt?.verdict?.releaseWithReviewProven !== b.proven) {
    findings.push(`verdict.releaseWithReviewProven=${receipt?.verdict?.releaseWithReviewProven} contradicts the rule (${b.proven})`);
  }
  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, proofOk: !!receipt?.verdict?.releaseWithReviewProven && findings.length === 0, findings };
}

// CLI: validate the committed receipt next to this module (offline, deterministic). Exit 1 on any finding.
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const receiptPath = join(here, 'release-with-review-drive-receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const result = validateReceipt(receipt);
  if (!result.ok) {
    console.error(`[release-with-review-drive] FAIL ${receiptPath}`);
    for (const f of result.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`[release-with-review-drive] OK ${REQUIREMENT}: candidate ${receipt.candidate.component} ${receipt.candidate.version} staged over net + signed ${String(receipt.review.verdict.verdict).toUpperCase()} + announced ${receipt.announce.type}; verdict proven=${result.proofOk}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
