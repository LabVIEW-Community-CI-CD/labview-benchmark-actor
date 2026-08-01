#!/usr/bin/env node
// release-decision-proof.mjs -- evidence that the real corroborated release is BLOCKED pending human sign-off
// (ADR-0018, LBA-REQ-027). Runs the LBA-REQ-027 gate over the committed machine-quorum verdict (the live
// {codespace, host} corroboration) with NO human sign-off yet -> publish:false while quorumPass:true, showing the
// machine gate passed but the human gate is un-skippable. Recording a REAL sign-off is the operator/reviewer step
// (a human judgement -- not fabricated here). Deterministic; the decision is re-derived by acg-reviewer-release-decision.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gateReleasePublish } from './sign-off.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const quorumVerdict = JSON.parse(readFileSync(join(repo, 'experiments/acg-quorum/corroboration-receipt.json'), 'utf8'));
const decision = gateReleasePublish({ quorumVerdict, signOffs: [] });
const receipt = {
  schema: 'labview-benchmark-actor/acg-release-decision-receipt-v1',
  note: 'the machine quorum corroborated the release; publish is BLOCKED pending a recorded human sign-off (ADR-0018). A real sign-off is the operator/reviewer judgement step, not fabricated here.',
  producedAt: new Date().toISOString(),
  quorumVerdict: quorumVerdict.verdict,
  decision,
};
writeFileSync(join(here, 'release-decision-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`release decision: publish=${decision.publish} quorumPass=${decision.quorumPass} reasons=${decision.reasons.join('; ')}`);
