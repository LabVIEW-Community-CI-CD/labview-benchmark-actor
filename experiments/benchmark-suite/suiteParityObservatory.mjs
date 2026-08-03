#!/usr/bin/env node
// suiteParityObservatory.mjs -- the BENCHMARK-SUITE PARITY OBSERVATORY (LBA-REQ-082, realizes ADR-0063). Folds the
// committed cross-plane PARITY receipts of the benchmark suite -- launch (LBA-REQ-072,
// cross-plane-launch-parity-receipt@1) and VI Analyzer (LBA-REQ-081, cross-plane-vi-analyzer-parity-receipt@1) --
// into ONE uniform coverage matrix: which benchmark families have proven cross-plane parity, and their LINUX vs
// WIN timing per family. The operator-facing SUITE view (roadmap Phase 2 capstone) + the bridge to Phase 4
// (cross-plane comparison at scale). Mirrors the mesh coverage observatory (LBA-REQ-075), but over the benchmark
// suite rather than the mesh.
//
// Pure + rg-free + offline: a committed observatory re-derives its coverage + verdict + digest byte-stably in CI
// from the committed parity receipts. Fails closed on a family that claims parity without cross-plane + identity
// match, a miscounted coverage statistic, a verdict that contradicts the folded rows, or a tampered digest. It
// EXTENDS with no new machinery as mass-compile / unit-test parity families land.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/benchmark-suite-parity-observatory@1';
export const REQUIREMENT = 'LBA-REQ-082';
export const ADR = 'ADR-0063';

// Derive the benchmark family name from a cross-plane parity receipt schema
// (`cross-plane-<family>-parity-receipt@1`).
function familyOf(schema) {
  const m = /cross-plane-(.+?)-parity-receipt@\d+$/.exec(String(schema ?? ''));
  return m ? m[1] : null;
}

// Fold one cross-plane parity receipt (either family's schema) into a uniform coverage row. `parityProven` is the
// receipt's own verdict; `crossPlane` / `identityMatch` are the shared parity flags; `resultHashMatch` is present
// only for families with a deterministic result (VI Analyzer).
export function foldParity(receipt) {
  return {
    family: familyOf(receipt?.schema),
    schema: receipt?.schema ?? null,
    requirement: receipt?.requirement ?? null,
    benchmark: receipt?.benchmark ?? null,
    identity: receipt?.launchIdentity ?? receipt?.benchmarkIdentity ?? null,
    crossPlane: receipt?.parity?.crossPlane === true,
    identityMatch: receipt?.parity?.identityMatch === true,
    resultHashMatch: typeof receipt?.parity?.resultHashMatch === 'boolean' ? receipt.parity.resultHashMatch : null,
    parityProven: receipt?.verdict?.parityProven === true,
    performance: {
      linuxMeanMs: receipt?.performance?.linuxMeanMs ?? null,
      winMeanMs: receipt?.performance?.winMeanMs ?? null,
      deltaMs: receipt?.performance?.deltaMs ?? null,
      pctOfLinux: receipt?.performance?.pctOfLinux ?? null,
      fasterPlane: receipt?.performance?.fasterPlane ?? null,
    },
  };
}

export function coverageOf(rows) {
  return {
    familyCount: rows.length,
    parityProvenCount: rows.filter((r) => r.parityProven).length,
    families: rows.map((r) => r.family),
    planes: ['LINUX', 'WIN'],
  };
}

function canonical(obs) {
  return JSON.stringify({
    schema: obs.schema, requirement: obs.requirement, adr: obs.adr,
    rows: Array.isArray(obs.rows) ? obs.rows : null,
    coverage: obs.coverage ?? null,
    verdict: { observatoryOk: obs.verdict?.observatoryOk },
  });
}

export function digestObservatory(obs) {
  return createHash('sha256').update(canonical(obs)).digest('hex');
}

// Build a benchmark-suite parity observatory by folding the suite's cross-plane parity receipts (sorted by family
// for a stable digest).
export function buildObservatory({ receipts } = {}) {
  const rows = (receipts ?? []).map(foldParity).sort((a, b) => String(a.family).localeCompare(String(b.family)));
  const coverage = coverageOf(rows);
  const allProven = rows.length > 0 && rows.every((r) => r.parityProven);
  const obs = {
    schema: RECEIPT_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    rows,
    coverage,
    verdict: {
      observatoryOk: allProven,
      reason: allProven
        ? `${rows.length} benchmark family/families proven cross-plane parity across [${coverage.planes.join(', ')}]: ${rows.map((r) => r.family).join(', ')}`
        : 'suite parity not complete: a benchmark family is not cross-plane parity-proven',
    },
  };
  obs.digest = digestObservatory(obs);
  return obs;
}

// Validate a committed observatory: schema/requirement/adr, the coverage re-derives from the rows, every row
// flagged parityProven is actually cross-plane + identity-matched, the verdict matches the rule, and the digest
// re-derives. Fail-closed.
export function validateObservatory(obs) {
  const findings = [];
  if (!obs || obs.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (obs?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (obs?.adr !== ADR) findings.push(`adr must be ${ADR}`);
  const rows = Array.isArray(obs?.rows) ? obs.rows : [];
  if (rows.length === 0) findings.push('the observatory folds no benchmark families');

  if (JSON.stringify(obs?.coverage) !== JSON.stringify(coverageOf(rows))) findings.push('coverage does not match the folded rows (miscounted)');

  rows.forEach((r, i) => {
    if (r.parityProven && !(r.crossPlane && r.identityMatch)) findings.push(`row[${i}] (${r.family}) claims parity without cross-plane + identity match`);
    if (!r.family) findings.push(`row[${i}] has no benchmark family`);
  });

  const allProven = rows.length > 0 && rows.every((r) => r.parityProven === true);
  if (obs?.verdict?.observatoryOk !== allProven) findings.push(`verdict.observatoryOk=${obs?.verdict?.observatoryOk} contradicts the rule (${allProven})`);

  if (obs?.digest !== digestObservatory(obs)) findings.push('digest does not match the observatory-bearing fields (tampered)');
  return { ok: findings.length === 0, proofOk: !!obs?.verdict?.observatoryOk && findings.length === 0, findings };
}

// Read the suite's committed cross-plane parity receipts (offline) into a fold context.
export function committedReceipts(here) {
  const read = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
  return [
    read(join('..', 'launch-parity', 'cross-plane-launch-parity-receipt.json')),
    read(join('..', 'vi-analyzer', 'cross-plane-vi-analyzer-parity-receipt.json')),
  ];
}

// CLI: validate the committed suite parity observatory next to this module (offline, deterministic).
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const obs = JSON.parse(readFileSync(join(here, 'benchmark-suite-parity-observatory-receipt.json'), 'utf8'));
  const result = validateObservatory(obs);
  if (!result.ok || !result.proofOk) {
    console.error(`[benchmark-suite-parity-observatory] FAIL`);
    for (const f of result.findings) console.error(`  - ${f}`);
    if (result.ok && !result.proofOk) console.error(`  - suite not fully parity-proven: ${obs.verdict?.reason}`);
    process.exit(1);
  }
  const c = obs.coverage;
  console.log(`[benchmark-suite-parity-observatory] OK ${REQUIREMENT}: ${c.parityProvenCount}/${c.familyCount} families cross-plane parity-proven [${c.families.join(', ')}] across [${c.planes.join(', ')}]`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
