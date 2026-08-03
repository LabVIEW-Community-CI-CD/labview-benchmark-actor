#!/usr/bin/env node
// verify-composite-release.mjs -- fail-closed release gate for the COMPOSITE release decision (LBA-REQ-071,
// ADR-0052). A component release may publish ONLY when the committed composite-release-decision receipt for that
// <component, version> proves BOTH the machine corroboration gate (gateReleasePublish, ADR-0018) AND the human
// visual gate (gateVisualReview, LBA-REQ-057) pass AND both name the SAME net-staged candidate (LBA-REQ-068/069).
//
// This is the ENFORCEMENT of the governed composite decision (LBA-REQ-070/ADR-0051): the extension-release
// workflow runs this in the `agreement` job, and the `release` (publish) job depends on `agreement`, so no .vsix
// publishes without a proven, candidate-bound composite decision. Layered ON TOP of verify-release-agreement.mjs
// (the WIN<->LINUX plane agreement) + verify-visual-review.mjs (the human visual verdict). Reuses the gated
// validateReceipt from the composite-release-decision verifier -- no gating logic is reimplemented here.
//
// Usage: node tools/collab-cli/verify-composite-release.mjs --component <name> <version>
// Exit: 0 = the composite decision passes (cleared to publish); 1 = fail-closed; 2 = usage.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { validateReceipt } from '../../reviewer-workstation/composite-release-decision.mjs';

// Verify a committed composite receipt clears a <component, version> release: it must NAME that candidate AND be
// a proven composite decision. Fails closed (returns publish=false + reasons) on any mismatch or unproven receipt.
export function verifyCompositeRelease({ receipt, component, version } = {}) {
  const reasons = [];
  const c = receipt?.candidate ?? {};
  if (String(c.component) !== String(component)) reasons.push(`the composite receipt candidate.component "${c.component}" does not match "${component}"`);
  if (String(c.version) !== String(version)) reasons.push(`the composite receipt candidate.version "${c.version}" does not match "${version}"`);
  const v = validateReceipt(receipt);
  for (const f of v.findings) reasons.push(f);
  if (!v.proofOk) reasons.push('the composite release decision is not proven (both gates must publish, bound to one net-staged candidate)');
  return { publish: reasons.length === 0, reasons };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const opt = {};
  let versionArg = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) opt[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
    else if (!versionArg) versionArg = a;
  }
  const component = typeof opt.component === 'string' ? opt.component : 'extension';
  const version = (versionArg || '').trim().replace(/^[a-z][a-z0-9-]*-v(?=\d)/i, '');
  if (!version) {
    console.error('usage: verify-composite-release.mjs --component <name> <version>');
    process.exit(2);
  }
  const tagPrefix = component === 'extension' ? 'ext-v' : `${component}-v`;
  const label = `${tagPrefix}${version}`;
  const here = dirname(fileURLToPath(import.meta.url));
  const receiptPath = join(here, '..', '..', 'reviewer-workstation', 'composite-release-decision-receipt.json');
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    console.error(`FAIL (fail-closed): no committed composite release-decision receipt for ${component} ${version} (${label}).`);
    console.error('Publishing requires a proven composite decision -- machine + human gates, bound to the net-staged candidate (LBA-REQ-071/070).');
    process.exit(1);
  }
  const decision = verifyCompositeRelease({ receipt, component, version });
  if (decision.publish) {
    console.log(`OK: ${label} has a proven composite release decision (machine + human gates, bound to the net-staged candidate).`);
    process.exit(0);
  }
  console.error(`FAIL (fail-closed): ${label} composite release decision did NOT pass.`);
  for (const r of decision.reasons) console.error(`  - ${r}`);
  process.exit(1);
}
