#!/usr/bin/env node
// verify-visual-review.mjs -- fail-closed release gate for the reviewer VISUAL VERDICT (LBA-REQ-057, ADR-0037).
//
// A component release may publish only when a signed reviewer visual verdict for that <component, version> is
// 'pass' AND >= minReviewers ENROLLED reviewers signed exactly that verdict. This is layered ON TOP of
// verify-release-agreement.mjs (the WIN<->LINUX plane agreement): the machine planes agreeing is necessary but
// not sufficient -- a human must also have PASSED the actual built candidate, and that verdict is signed +
// verifiable (Ed25519, enrolled reviewer key). Reuses the gated gateVisualReview.
//
// Usage:
//   node tools/collab-cli/verify-visual-review.mjs --component extension <version> [--min 1]
//     -> reads components.<component>.releases.<version>.visualReview from release-agreement.json + the
//        committed reviewer-allowlist.json
//   node tools/collab-cli/verify-visual-review.mjs --verdict <record.json> --allowlist <allowlist.json> [--min 1]
//     -> verify a standalone { verdict, signOffs|signOff } record (used by the gate + CI)
// Exit: 0 = the visual review passes (cleared to publish); 1 = fail-closed; 2 = usage.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gateVisualReview } from '../../experiments/handoff-beacon/reviewerVerdict.mjs';

/**
 * Verify a visual-review record { verdict, signOffs|signOff } against the enrolled reviewer allowlist.
 * Returns the acg-visual-review-decision-v1 (from gateVisualReview): { publish, verdictPass, approvals, reasons }.
 */
export function verifyVisualReview({ record, reviewerAllowlist = {}, minReviewers = 1 } = {}) {
  const r = record && typeof record === 'object' ? record : {};
  const signOffs = Array.isArray(r.signOffs) ? r.signOffs : r.signOff ? [r.signOff] : [];
  return gateVisualReview({ verdict: r.verdict, signOffs, reviewerAllowlist, minReviewers });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opt = {};
  let versionArg = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) opt[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
    else if (!versionArg) versionArg = a;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const minReviewers = opt.min ? Number(opt.min) : 1;

  let record;
  let allowlist;
  let label;
  if (opt.verdict && opt.allowlist) {
    record = readJson(opt.verdict);
    allowlist = readJson(opt.allowlist);
    label = opt.verdict;
  } else {
    const component = typeof opt.component === 'string' ? opt.component : 'extension';
    const version = (versionArg || '').trim().replace(/^[a-z][a-z0-9-]*-v(?=\d)/i, '');
    if (!version) {
      console.error('usage: verify-visual-review.mjs --component <name> <version>  |  --verdict <record.json> --allowlist <allowlist.json>');
      process.exit(2);
    }
    const tagPrefix = component === 'extension' ? 'ext-v' : `${component}-v`;
    label = `${tagPrefix}${version}`;
    const doc = readJson(join(here, 'release-agreement.json'));
    const rel = doc.components && doc.components[component] && doc.components[component].releases && doc.components[component].releases[version];
    record = rel && rel.visualReview;
    allowlist = readJson(join(here, 'reviewer-allowlist.json'));
    if (!record) {
      console.error(`FAIL (fail-closed): no signed reviewer visual verdict (visualReview) for ${component} ${version} (${label}).`);
      console.error('Publishing requires a human PASS of the actual candidate, signed by an enrolled reviewer (LBA-REQ-057).');
      process.exit(1);
    }
  }

  const decision = verifyVisualReview({ record, reviewerAllowlist: allowlist, minReviewers });
  if (decision.publish) {
    console.log(`OK: ${label} has a passing signed reviewer visual verdict from: ${decision.approvals.join(', ')}.`);
    process.exit(0);
  }
  console.error(`FAIL (fail-closed): ${label} reviewer visual review did NOT pass.`);
  for (const r of decision.reasons) console.error(`  - ${r}`);
  process.exit(1);
}
