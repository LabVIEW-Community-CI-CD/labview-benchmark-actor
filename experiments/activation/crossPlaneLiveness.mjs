#!/usr/bin/env node
// Cross-plane LabVIEW liveness (LBA-REQ-042, ADR-0030): the capability-routed executor (ADR-0029) can now
// reach MORE THAN ONE LabVIEW-capable instance -- this host and a LabVIEW VM. Running the known-answer
// activation probe (LabVIEWCLI RunVI on AddTwoNumbers) on EVERY LabVIEW plane, concurrently, and asserting
// each returned the known answer proves the fleet has >= 2 independent, activated, operational LabVIEW
// planes -- the substrate for real cross-plane benchmark comparison (docs/roadmap.md North Star).
//
// This is the PURE, deterministic core (build + validate). The live probe dispatch lives in
// runCrossPlaneLiveness.mjs. Reuses the activation-receipt verdict rule (buildActivationReceipt.mjs).

import { decideActivated, parseProbeOutput } from './buildActivationReceipt.mjs';

export const LIVENESS_SCHEMA = 'labview-benchmark-actor/cross-plane-liveness@1';

// planes: [{ instance, hostname, os, inputs:[a,b], expectedOutput, exitCode, output }] (raw probe stdout).
// Derives each plane's activation verdict from its probe output (known answer + clean run) and aggregates.
export function buildLivenessReceipt({ workload, planes }) {
  const built = planes.map((p) => {
    const parsed = parseProbeOutput(p.output);
    const activated = decideActivated({
      exitCode: p.exitCode ?? 0, operationSucceeded: parsed.operationSucceeded,
      parsedOutput: parsed.parsedOutput, expectedOutput: p.expectedOutput, knownAnswer: true,
    });
    return {
      instance: p.instance, hostname: p.hostname, os: p.os || 'linux',
      labviewVersion: parsed.labviewVersion, inputs: p.inputs, expectedOutput: p.expectedOutput,
      parsedOutput: parsed.parsedOutput, operationSucceeded: parsed.operationSucceeded, activated,
    };
  }).sort((a, b) => a.instance.localeCompare(b.instance));
  return { schema: LIVENESS_SCHEMA, workload, planeCount: built.length, planes: built, allActivated: built.every((p) => p.activated) };
}

// Validate a committed liveness receipt: >= 2 distinct planes, each returned its known answer and is
// activated, and every plane is live. Fail-closed on any violation.
export function validateLiveness(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== LIVENESS_SCHEMA) return { ok: false, findings: [`schema must be ${LIVENESS_SCHEMA}`] };
  const planes = receipt.planes || [];
  if (planes.length < 2) findings.push('cross-plane liveness needs >= 2 LabVIEW planes');
  if (receipt.planeCount !== planes.length) findings.push(`planeCount ${receipt.planeCount} != planes ${planes.length}`);
  for (const p of planes) {
    if (p.parsedOutput == null || p.parsedOutput !== p.expectedOutput) findings.push(`plane ${p.instance} returned ${p.parsedOutput} != expected ${p.expectedOutput}`);
    if (p.operationSucceeded !== true) findings.push(`plane ${p.instance} did not report RunVI success`);
    if (p.activated !== true) findings.push(`plane ${p.instance} is not activated`);
  }
  if (new Set(planes.map((p) => p.hostname)).size < planes.length) findings.push('planes are not distinct (hostnames not unique)');
  if (receipt.allActivated !== true) findings.push('allActivated is not true');
  return { ok: findings.length === 0, findings, planes: planes.map((p) => p.instance) };
}
