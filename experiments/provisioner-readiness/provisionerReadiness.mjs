#!/usr/bin/env node
// provisioner-headless-readiness@1 verifier (LBA-REQ-049, realizes ADR-0023 Phase 1). Proves the golden-VM
// provisioner (cleanroom/ubuntu-labview/provision-guest.sh) installs EVERY prerequisite a fresh Ubuntu 24.04
// VM needs to run headless LabVIEWCLI benchmarks WITHOUT the manual fixes we hit live during bring-up:
//   - Xvfb (a headless X display for `xvfb-run -a LabVIEWCLI ...` over SSH),
//   - VI Server (TCP :3363) config for BOTH LabVIEW exe basenames -- labview.conf AND labviewcommunity.conf,
//     because LabVIEW picks its config FILE by the launched executable's basename,
//   - quoted access lists (LabVIEW silently ignores unquoted ones -> still -350000),
//   - the post-install reboot (VI Server binds :3363 only after a fresh-install reboot).
//
// A fail-closed gate keeps this hard-won knowledge from regressing: drop any step from the provisioner and
// the build turns red. Pure + tool-free by construction -- it reads the committed script TEXT and applies
// JS regex predicates, so it runs in CI with no VM, no LabVIEW, and no ripgrep.

import { createHash } from 'node:crypto';

export const READINESS_SCHEMA = 'labview-benchmark-actor/provisioner-headless-readiness@1';

// The headless-LabVIEW prerequisites, each a named predicate over the provisioner script text. ORDER is
// stable -- the receipt records checks in exactly this order.
export const REQUIRED_CHECKS = [
  {
    name: 'installs-xvfb',
    description: 'apt-installs Xvfb (headless X display for LabVIEWCLI over SSH)',
    test: (t) => /\bxvfb\b/i.test(t),
  },
  {
    name: 'vi-server-config-labview-conf',
    description: 'writes VI Server config into labview.conf (the -LabVIEWPath symlink basename)',
    test: (t) => /labview\.conf/.test(t),
  },
  {
    name: 'vi-server-config-labviewcommunity-conf',
    description: 'writes VI Server config into labviewcommunity.conf (VIPM launches the labviewcommunity basename)',
    test: (t) => /labviewcommunity\.conf/.test(t),
  },
  {
    name: 'vi-server-tcp-enabled-3363',
    description: 'enables VI Server TCP on port 3363',
    test: (t) => /server\.tcp\.enabled\s*=\s*TRUE/i.test(t) && /server\.tcp\.port\s*=\s*3363/.test(t),
  },
  {
    name: 'vi-server-access-quoted',
    description: 'quotes the VI Server access lists (LabVIEW ignores unquoted lists)',
    test: (t) => /server\.tcp\.access\s*=\s*"/.test(t) && /server\.vi\.access\s*=\s*"/.test(t),
  },
  {
    name: 'post-install-reboot',
    description: 'addresses the post-install reboot (VI Server binds :3363 only after a reboot)',
    test: (t) => /reboot/i.test(t),
  },
];

// Run every required check against the provisioner script text.
export function analyzeProvisioner(scriptText) {
  const t = String(scriptText || '');
  const checks = REQUIRED_CHECKS.map((c) => ({ name: c.name, description: c.description, present: !!c.test(t) }));
  const missing = checks.filter((c) => !c.present).map((c) => c.name);
  return { checks, missing, allPresent: missing.length === 0 };
}

// Canonical, deterministic verdict-bearing view (the digest input) -- schema + script path + each check's
// name/present + the ready verdict. Descriptions are documentation, not part of the identity.
function canonical(receipt) {
  return JSON.stringify({
    schema: receipt.schema,
    scriptPath: receipt.scriptPath,
    checks: (receipt.checks || []).map((c) => ({ name: c.name, present: c.present })),
    ready: receipt.ready,
  });
}

export function digestReadinessReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build a provisioner-headless-readiness@1 receipt from the provisioner script text.
export function buildReadinessReceipt({ scriptText, scriptPath }) {
  const { checks, missing, allPresent } = analyzeProvisioner(scriptText);
  const receipt = {
    schema: READINESS_SCHEMA,
    scriptPath: scriptPath || 'cleanroom/ubuntu-labview/provision-guest.sh',
    checks,
    missing,
    ready: allPresent,
    verdict: {
      ready: allPresent,
      reason: allPresent
        ? 'the provisioner installs every headless-LabVIEW prerequisite (Xvfb, VI Server :3363 for both exe basenames, quoted access, reboot)'
        : `the provisioner is missing headless-LabVIEW prerequisites: ${missing.join(', ')}`,
    },
  };
  receipt.digest = digestReadinessReceipt(receipt);
  return receipt;
}

// Validate a committed receipt against the ACTUAL provisioner script text: re-derive the checks from the
// script, assert the receipt records exactly the required set with matching present values, assert the
// ready verdict matches the rule, and assert the digest is intact. Fail-closed -- any drift (a dropped
// provisioner step, a forged verdict, a tampered digest) yields ok=false.
export function validateReadinessReceipt(receipt, scriptText) {
  const findings = [];
  if (!receipt || receipt.schema !== READINESS_SCHEMA) findings.push(`schema must be ${READINESS_SCHEMA}`);
  if (!receipt || !Array.isArray(receipt.checks) || !receipt.verdict) {
    return { ok: false, ready: false, findings: findings.concat('missing checks/verdict') };
  }
  const derived = analyzeProvisioner(scriptText);
  for (const d of derived.checks) {
    const rec = receipt.checks.find((c) => c.name === d.name);
    if (!rec) findings.push(`receipt is missing required check ${d.name}`);
    else if (rec.present !== d.present) findings.push(`check ${d.name} present=${rec.present} contradicts the script (${d.present})`);
  }
  if (receipt.checks.length !== derived.checks.length) findings.push('receipt records a different check set than required');
  if (receipt.ready !== derived.allPresent) findings.push(`ready=${receipt.ready} contradicts the derived checks (${derived.allPresent})`);
  if (receipt.verdict.ready !== derived.allPresent) findings.push(`verdict.ready=${receipt.verdict.ready} contradicts the derived checks (${derived.allPresent})`);
  if (receipt.digest !== digestReadinessReceipt(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, ready: !!receipt.ready && findings.length === 0, findings };
}
