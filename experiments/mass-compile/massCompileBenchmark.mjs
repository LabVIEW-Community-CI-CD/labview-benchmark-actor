#!/usr/bin/env node
// mass-compile-benchmark@1 builder + validator (LBA-REQ-048, realizes ADR-0023 Phase 1 -- golden-VM
// benchmark). Runs LabVIEWCLI MassCompile over a directory of the public ni/labview-icon-editor and records
// the benchmark: how many VIs/CTLs the directory holds, how many LabVIEW flagged bad, whether the operation
// succeeded, and the compile time. The RESULT (directory + vi count + bad count + success) is a
// machine-independent resultHash (mirrors LBA-REQ-015's VI Analyzer resultHash) so the SAME mass-compile can
// be compared across planes; the compile TIME is the performance measurement -- recorded, but NOT in the
// resultHash or the digest, since it varies by machine.
//
// Pure + rg-free + offline: a committed receipt re-derives its resultHash + verdict + digest byte-stably in
// CI (which has no LabVIEW). The gate fails closed on a stale/tampered resultHash, a forged verdict, an
// inconsistent bad-VI list, or a tampered digest.

import { createHash } from 'node:crypto';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/mass-compile-benchmark@1';

// Machine-independent benchmark result identity: the directory + what was compiled + LabVIEW's verdict.
// Excludes timing so the SAME mass-compile yields the SAME resultHash on any plane (cross-plane comparison).
export function computeResultHash({ directory, visInDirectory, badViCount, badVis, operationSucceeded }) {
  const canon = JSON.stringify({
    directory: directory ?? null,
    visInDirectory: visInDirectory ?? null,
    badViCount: badViCount ?? null,
    badVis: (badVis || []).slice().sort(),
    operationSucceeded: !!operationSucceeded,
  });
  return createHash('sha256').update(canon).digest('hex');
}

// The benchmark passes iff LabVIEW reported the mass-compile succeeded over a non-empty directory.
export function decideBenchmark({ operationSucceeded, visInDirectory }) {
  return operationSucceeded === true && Number.isInteger(visInDirectory) && visInDirectory > 0;
}

// Digest over the verdict-bearing fields (NOT the timing, which varies by machine).
function canonical(receipt) {
  return JSON.stringify({
    schema: receipt.schema,
    directory: receipt.source?.directory ?? null,
    visInDirectory: receipt.visInDirectory ?? null,
    badViCount: receipt.badViCount ?? null,
    operationSucceeded: receipt.operationSucceeded ?? null,
    resultHash: receipt.resultHash ?? null,
    verdict: { benchmarkOk: receipt.verdict?.benchmarkOk },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build a mass-compile-benchmark@1 receipt from captured MassCompile evidence (deterministic + sealed).
export function buildMassCompileReceipt(capture) {
  const badVis = Array.isArray(capture.badVis) ? capture.badVis : [];
  const badViCount = Number.isInteger(capture.badViCount) ? capture.badViCount : badVis.length;
  const visInDirectory = capture.visInDirectory ?? 0;
  const operationSucceeded = !!capture.operationSucceeded;
  const resultHash = computeResultHash({ directory: capture.source?.directory, visInDirectory, badViCount, badVis, operationSucceeded });
  const benchmarkOk = decideBenchmark({ operationSucceeded, visInDirectory });
  const receipt = {
    schema: RECEIPT_SCHEMA,
    vm: capture.vm ?? null,
    labview: capture.labview ?? null,
    source: capture.source ?? null,
    operation: 'LabVIEWCLI -OperationName MassCompile',
    visInDirectory,
    badViCount,
    badVis,
    operationSucceeded,
    timing: { compileSeconds: capture.compileSeconds ?? null, cliElapsedMs: capture.cliElapsedMs ?? null },
    resultHash,
    note: capture.note ?? null,
    verdict: {
      benchmarkOk,
      reason: benchmarkOk
        ? `MassCompile of ${capture.source?.directory} (${visInDirectory} VIs/CTLs, ${badViCount} bad) succeeded`
        : 'MassCompile did not succeed over a non-empty directory',
    },
  };
  receipt.digest = digestReceipt(receipt);
  return receipt;
}

// Validate a committed receipt: schema, counts, bad-VI consistency, resultHash re-derivation, verdict rule,
// and digest integrity. Pure + offline (no LabVIEW / ripgrep).
export function validateMassCompileReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (!Number.isInteger(receipt?.visInDirectory) || receipt.visInDirectory <= 0) findings.push('visInDirectory must be a positive integer');
  if (!Number.isInteger(receipt?.badViCount) || receipt.badViCount < 0) findings.push('badViCount must be a non-negative integer');
  if ((receipt?.badVis || []).length !== receipt?.badViCount) findings.push('badVis list length != badViCount');
  const expectedHash = computeResultHash({
    directory: receipt?.source?.directory, visInDirectory: receipt?.visInDirectory,
    badViCount: receipt?.badViCount, badVis: receipt?.badVis, operationSucceeded: receipt?.operationSucceeded,
  });
  if (receipt?.resultHash !== expectedHash) findings.push('resultHash does not match the recorded result (stale/tampered)');
  const expectedVerdict = decideBenchmark({ operationSucceeded: receipt?.operationSucceeded, visInDirectory: receipt?.visInDirectory });
  if (receipt?.verdict?.benchmarkOk !== expectedVerdict) findings.push(`verdict.benchmarkOk=${receipt?.verdict?.benchmarkOk} contradicts the rule (${expectedVerdict})`);
  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, benchmarkOk: !!receipt?.verdict?.benchmarkOk && findings.length === 0, resultHash: receipt?.resultHash, findings };
}
