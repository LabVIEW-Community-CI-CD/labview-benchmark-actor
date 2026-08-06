#!/usr/bin/env node
// golden-activation-readiness@1 -- validates a live guest's pre-activation prerequisites without handling
// credentials. The user still performs NI/VIPM activation; this receipt proves automation reached the handoff.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const GOLDEN_ACTIVATION_READINESS_SCHEMA = 'labview-benchmark-actor/golden-activation-readiness@1';

export const REQUIRED_RUNTIME_CHECKS = Object.freeze([
  'labviewCli',
  'labviewBinary',
  'probeVi',
  'python3',
  'xvfb',
  'xdpyinfo',
  'vipmPackage',
  'vipmCommand',
  'labviewConf',
  'labviewCommunityConf',
  'viServerTcp',
  'viServerAccess',
  'passwordlessSudo',
]);

function runtimeChecks(capture) {
  const checks = capture?.checks && typeof capture.checks === 'object' ? capture.checks : {};
  return Object.fromEntries(REQUIRED_RUNTIME_CHECKS.map((name) => [name, checks[name] === true]));
}

function canonical(receipt) {
  return JSON.stringify({
    schema: receipt.schema,
    checks: receipt.checks,
    missing: receipt.missing,
    ready: receipt.ready,
    verdict: { ready: receipt.verdict?.ready },
  });
}

export function digestGoldenActivationReadiness(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

export function buildGoldenActivationReadinessReceipt(capture) {
  const checks = runtimeChecks(capture);
  const missing = REQUIRED_RUNTIME_CHECKS.filter((name) => checks[name] !== true);
  const ready = missing.length === 0;
  const receipt = {
    schema: GOLDEN_ACTIVATION_READINESS_SCHEMA,
    checks,
    missing,
    ready,
    verdict: {
      ready,
      reason: ready
        ? 'the golden actor has LabVIEWCLI, VIPM, Xvfb, VI Server configuration, and a safe user activation handoff'
        : `the golden actor is not activation-ready: ${missing.join(', ')}`,
    },
  };
  receipt.digest = digestGoldenActivationReadiness(receipt);
  return receipt;
}

export function validateGoldenActivationReadinessReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== GOLDEN_ACTIVATION_READINESS_SCHEMA) {
    findings.push(`schema must be ${GOLDEN_ACTIVATION_READINESS_SCHEMA}`);
  }
  const checks = runtimeChecks(receipt);
  if (!receipt?.checks || Object.keys(receipt.checks).length !== REQUIRED_RUNTIME_CHECKS.length) {
    findings.push('receipt must contain exactly the required readiness checks');
  }
  const missing = REQUIRED_RUNTIME_CHECKS.filter((name) => checks[name] !== true);
  if (JSON.stringify(receipt?.missing) !== JSON.stringify(missing)) {
    findings.push('missing checks do not match the readiness checks');
  }
  const ready = missing.length === 0;
  if (receipt?.ready !== ready) findings.push(`ready=${receipt?.ready} contradicts the checks (${ready})`);
  if (receipt?.verdict?.ready !== ready) findings.push(`verdict.ready=${receipt?.verdict?.ready} contradicts the checks (${ready})`);
  if (receipt?.digest !== digestGoldenActivationReadiness(receipt)) findings.push('digest does not match the readiness-bearing fields');
  return { ok: findings.length === 0, ready: ready && findings.length === 0, findings };
}

function main() {
  const [, , capturePath, receiptPath] = process.argv;
  if (!capturePath || !receiptPath) {
    console.error('usage: node goldenActivationReadiness.mjs <capture.json> <receipt.json>');
    process.exit(2);
  }
  const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
  if (capture.schema !== 'labview-benchmark-actor/golden-activation-readiness-capture@1') {
    console.error('golden activation readiness: unsupported capture schema');
    process.exit(1);
  }
  const receipt = buildGoldenActivationReadinessReceipt(capture);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const result = validateGoldenActivationReadinessReceipt(receipt);
  if (!result.ok) {
    console.error(`golden activation readiness: invalid receipt: ${result.findings.join('; ')}`);
    process.exit(1);
  }
  console.log(`golden activation readiness: ${result.ready ? 'READY' : 'INCOMPLETE'} (${receipt.missing.join(', ') || 'all checks present'})`);
  process.exit(result.ready ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
