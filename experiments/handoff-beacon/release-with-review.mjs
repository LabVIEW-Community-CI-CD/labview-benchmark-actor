// release-with-review.mjs -- compose the machine release gate with the human VISUAL review gate (LBA-REQ-057,
// ADR-0037). Experiments-only (NOT staged into the extension): it imports the ADR-0018 machine gate
// (acg-reviewer/sign-off.mjs) + the ADR-0037 visual gate (reviewerVerdict.mjs, dependency-free + stageable).
//
// A release publishes only when BOTH pass: the machine corroboration (quorum + human sign-off over the quorum)
// AND the human's VISUAL PASS/FAIL of the actual built candidate. Neither substitutes for the other -- this is
// how the reviewer-VM visual verdict wires INTO the existing gateReleasePublish decision.

import { gateVisualReview } from './reviewerVerdict.mjs';
import { gateReleasePublish } from '../acg-reviewer/sign-off.mjs';

export function gateReleaseWithReview({
  quorumVerdict,
  quorumSignOffs = [],
  verdict,
  verdictSignOffs = [],
  reviewerAllowlist = {},
  minReviewers = 1,
  minVisualReviewers = 1,
} = {}) {
  const machine = gateReleasePublish({ quorumVerdict, signOffs: quorumSignOffs, reviewerAllowlist, minReviewers });
  const visual = gateVisualReview({ verdict, signOffs: verdictSignOffs, reviewerAllowlist, minReviewers: minVisualReviewers });
  return {
    schema: 'labview-benchmark-actor/acg-release-with-review-decision-v1',
    publish: machine.publish === true && visual.publish === true,
    machine,
    visual,
    reasons: [
      ...(machine.publish ? [] : machine.reasons.map((r) => `machine: ${r}`)),
      ...(visual.publish ? [] : visual.reasons.map((r) => `visual: ${r}`)),
    ],
  };
}
