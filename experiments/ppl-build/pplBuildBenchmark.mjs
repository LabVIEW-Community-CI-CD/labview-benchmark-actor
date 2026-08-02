#!/usr/bin/env node
// ppl-build-benchmark@1 builder + validator (LBA-REQ-051, realizes ADR-0033). Reproduces the ni/labview-icon-editor
// project's REAL CI build -- the "Editor Packed Library" build specification -> a Packed Project Library
// (.lvlibp) -- via `LabVIEWCLI -OperationName ExecuteBuildSpec` inside the same NI LabVIEW container the
// icon-editor CI uses (nationalinstruments/labview:2026q1-linux). This is the BUILDER actor of the 2-actor
// icon-editor grid (the companion actor runs the LUnit tests). The RESULT identity (project + target +
// build spec + the generated artifact name + success) is machine-independent, so the SAME build is
// comparable across planes; the build TIME (and the .lvlibp byte size, which embeds build-time variability)
// are performance/descriptive metrics, NOT in the resultHash or digest.
//
// Pure + rg-free + offline: a committed receipt re-derives its resultHash + verdict + digest byte-stably in
// CI (which has no LabVIEW / Docker). The gate fails closed on a stale/tampered resultHash, a forged verdict,
// or a tampered digest.

import { createHash } from 'node:crypto';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/ppl-build-benchmark@1';

// Machine-independent build identity: what was built (project + target + build spec) and what it produced
// (the generated artifact name) plus LabVIEW's success verdict. Excludes timing + byte size (plane-variable).
export function computeResultHash({ project, target, buildSpec, generatedArtifact, operationSucceeded }) {
  const canon = JSON.stringify({
    project: project ?? null,
    target: target ?? null,
    buildSpec: buildSpec ?? null,
    generatedArtifact: generatedArtifact ?? null,
    operationSucceeded: !!operationSucceeded,
  });
  return createHash('sha256').update(canon).digest('hex');
}

// The benchmark passes iff LabVIEW reported the build succeeded and it emitted a packed library artifact.
export function decideBenchmark({ operationSucceeded, generatedArtifact }) {
  return operationSucceeded === true && typeof generatedArtifact === 'string' && generatedArtifact.length > 0;
}

// Digest over the verdict-bearing fields (NOT timing / size, which vary by machine).
function canonical(receipt) {
  const b = receipt.build || {};
  return JSON.stringify({
    schema: receipt.schema,
    project: receipt.source?.project ?? null,
    target: b.target ?? null,
    buildSpec: b.buildSpec ?? null,
    generatedArtifact: receipt.generatedArtifact ?? null,
    operationSucceeded: receipt.operationSucceeded ?? null,
    resultHash: receipt.resultHash ?? null,
    verdict: { benchmarkOk: receipt.verdict?.benchmarkOk },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build a ppl-build-benchmark@1 receipt from captured ExecuteBuildSpec evidence (deterministic + sealed).
export function buildPplReceipt(capture) {
  const operationSucceeded = !!capture.operationSucceeded;
  const generatedArtifact = capture.generatedArtifact ?? null;
  const build = { target: capture.target ?? 'My Computer', buildSpec: capture.buildSpec ?? null };
  const resultHash = computeResultHash({
    project: capture.source?.project, target: build.target, buildSpec: build.buildSpec,
    generatedArtifact, operationSucceeded,
  });
  const benchmarkOk = decideBenchmark({ operationSucceeded, generatedArtifact });
  const receipt = {
    schema: RECEIPT_SCHEMA,
    plane: capture.plane ?? null,
    container: capture.container ?? null,
    labview: capture.labview ?? null,
    source: capture.source ?? null,
    operation: 'LabVIEWCLI -OperationName ExecuteBuildSpec',
    build,
    generatedArtifact,
    operationSucceeded,
    timing: { buildSeconds: capture.buildSeconds ?? null },
    artifactSizeBytes: capture.artifactSizeBytes ?? null,
    resultHash,
    note: capture.note ?? null,
    verdict: {
      benchmarkOk,
      reason: benchmarkOk
        ? `ExecuteBuildSpec of "${build.buildSpec}" produced ${generatedArtifact}`
        : 'ExecuteBuildSpec did not succeed or produced no artifact',
    },
  };
  receipt.digest = digestReceipt(receipt);
  return receipt;
}

// Validate a committed receipt: schema, resultHash re-derivation, verdict rule, and digest integrity.
export function validatePplReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (typeof receipt?.generatedArtifact !== 'string' || !receipt.generatedArtifact) findings.push('generatedArtifact must be a non-empty string');
  const expectedHash = computeResultHash({
    project: receipt?.source?.project, target: receipt?.build?.target, buildSpec: receipt?.build?.buildSpec,
    generatedArtifact: receipt?.generatedArtifact, operationSucceeded: receipt?.operationSucceeded,
  });
  if (receipt?.resultHash !== expectedHash) findings.push('resultHash does not match the recorded build (stale/tampered)');
  const expectedVerdict = decideBenchmark({ operationSucceeded: receipt?.operationSucceeded, generatedArtifact: receipt?.generatedArtifact });
  if (receipt?.verdict?.benchmarkOk !== expectedVerdict) findings.push(`verdict.benchmarkOk=${receipt?.verdict?.benchmarkOk} contradicts the rule (${expectedVerdict})`);
  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, benchmarkOk: !!receipt?.verdict?.benchmarkOk && findings.length === 0, resultHash: receipt?.resultHash, findings };
}
