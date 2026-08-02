#!/usr/bin/env node
// Cross-plane VI Analyzer comparison (LBA-REQ-043, ADR-0031): the North Star. Running the SAME VI Analyzer
// config on >= 2 independent LabVIEW planes (this host + a LabVIEW VM) must produce the SAME deterministic
// resultHash (viAnalyzerResult.mjs canonicalizes counts + findings so it is machine-independent). Matching
// resultHashes across planes = a real, reproducible cross-plane benchmark equivalence -- liveness (ADR-0030)
// turned into COMPARISON.
//
// This is the PURE, deterministic core (build + validate). The live VI Analyzer dispatch lives in
// runCrossPlaneViAnalyzer.mjs. The gate replays the committed receipt offline.

export const COMPARISON_SCHEMA = 'labview-benchmark-actor/cross-plane-comparison@1';

// planes: [{ instance, hostname, os, summary }] where `summary` is a summarizeViAnalyzerReport() result.
export function buildComparisonReceipt({ benchmark, planes }) {
  const built = planes.map((p) => ({
    instance: p.instance, hostname: p.hostname, os: p.os || 'linux',
    resultHash: p.summary.resultHash, totalTests: p.summary.totalTests,
    passedTests: p.summary.passedTests, totalFindings: p.summary.totalFindings, pass: p.summary.pass,
  })).sort((a, b) => a.instance.localeCompare(b.instance));
  const hashes = new Set(built.map((p) => p.resultHash));
  const resultHashesMatch = built.length >= 2 && hashes.size === 1;
  return {
    schema: COMPARISON_SCHEMA, benchmark,
    planeCount: built.length, planes: built,
    resultHashesMatch, consensusHash: resultHashesMatch ? built[0].resultHash : null,
  };
}

// Validate a committed comparison receipt: >= 2 distinct planes, each carries a resultHash, ALL resultHashes
// are identical (cross-plane determinism), and the consensus is recorded. Fail-closed on any divergence.
export function validateComparison(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== COMPARISON_SCHEMA) return { ok: false, findings: [`schema must be ${COMPARISON_SCHEMA}`] };
  const planes = receipt.planes || [];
  if (planes.length < 2) findings.push('cross-plane comparison needs >= 2 planes');
  if (receipt.planeCount !== planes.length) findings.push(`planeCount ${receipt.planeCount} != planes ${planes.length}`);
  for (const p of planes) {
    if (!p.resultHash || typeof p.resultHash !== 'string' || p.resultHash.length < 16) findings.push(`plane ${p.instance} has no valid resultHash`);
  }
  const hashes = new Set(planes.map((p) => p.resultHash));
  if (hashes.size !== 1) findings.push(`resultHashes DIFFER across planes (${[...hashes].map((h) => String(h).slice(0, 10)).join(' vs ')}) -- not cross-plane deterministic`);
  if (receipt.resultHashesMatch !== true) findings.push('resultHashesMatch is not true');
  if (receipt.consensusHash && [...hashes][0] !== receipt.consensusHash) findings.push('consensusHash does not match the plane hashes');
  if (new Set(planes.map((p) => p.hostname)).size < planes.length) findings.push('planes are not distinct (hostnames not unique)');
  return { ok: findings.length === 0, findings, consensusHash: receipt.consensusHash };
}
