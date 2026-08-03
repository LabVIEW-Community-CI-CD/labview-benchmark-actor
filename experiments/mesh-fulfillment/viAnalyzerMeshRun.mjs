#!/usr/bin/env node
// viAnalyzerMeshRun.mjs -- the mesh carries a SECOND benchmark family (LBA-REQ-083, realizes ADR-0064). The
// convergence of the two roadmap threads: the actor mesh (Phase 3, LBA-REQ-072..080) and the cross-plane benchmark
// suite (Phase 2, LBA-REQ-081..082). It proves the mesh fulfillment engine (LBA-REQ-073) is BENCHMARK-GENERIC --
// not launch-specific -- by fulfilling the VI Analyzer benchmark through the SAME engine, grounded in the real
// committed VI Analyzer captures.
//
// It REUSES, with no new fulfillment logic: `meshFulfillment.buildReceipt` / `validateReceipt` (LBA-REQ-073) for
// the cross-plane fulfillment, and `trendFromEvidence` (LBA-REQ-081) to turn each committed
// vi-analyzer-trend-live-evidence@1 capture into the workload-trend@1 an actor returns. A
// `mesh-benchmark-family-run@1` wraps the fulfillment with the proof that this is a DISTINCT benchmark family
// (identity != the launch identity) carried by the mesh. Pure + rg-free + offline: the committed run re-derives
// byte-stably from the two evidence captures. Fails closed if the fulfillment is not proven, the actor receipts do
// not descend from the real evidence, the identity is not the VI Analyzer benchmark, it is not distinct from the
// launch benchmark, or the digest is tampered.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { buildReceipt as buildFulfillment, validateReceipt as validateFulfillment, benchmarkIdentity } from './meshFulfillment.mjs';
import { trendFromEvidence, VI_ANALYZER_METRIC, VI_ANALYZER_WORKLOAD } from '../vi-analyzer/viAnalyzerParity.mjs';

export const RUN_SCHEMA = 'labview-benchmark-actor/mesh-benchmark-family-run@1';
export const REQUIREMENT = 'LBA-REQ-083';
export const ADR = 'ADR-0064';

// The flagship launch benchmark identity (LBA-REQ-072) -- the VI Analyzer run must be a DIFFERENT benchmark.
export const LAUNCH_BENCHMARK = { metric: 'launchMs', workload: 'labview-ide-launch', n: 5 };

function canonical(run) {
  return JSON.stringify({
    schema: run.schema, requirement: run.requirement, adr: run.adr,
    family: run.family, benchmark: run.benchmark ?? null, identity: run.identity ?? null,
    fulfillmentDigest: run.fulfillment?.digest ?? null,
    distinctFromLaunch: run.distinctFromLaunch ?? null,
    verdict: { carried: run.verdict?.carried },
  });
}

export function digestRun(run) {
  return createHash('sha256').update(canonical(run)).digest('hex');
}

// Build the VI Analyzer mesh-run family record from a LINUX + a WIN vi-analyzer-trend-live-evidence@1 capture:
// two golden-VM actors return their VI Analyzer trend, and the LBA-REQ-073 engine decides fulfillment.
export function buildFamilyRun({ linuxEvidence, winEvidence } = {}) {
  const benchmark = { metric: VI_ANALYZER_METRIC, workload: VI_ANALYZER_WORKLOAD, n: (linuxEvidence?.runs ?? []).length };
  const actors = [
    { actorId: 'golden-linux', role: 'golden', plane: 'LINUX', hypervisor: linuxEvidence?.cleanroom?.hypervisor ?? null, receipt: trendFromEvidence(linuxEvidence) },
    { actorId: 'golden-win', role: 'golden', plane: 'WIN', hypervisor: winEvidence?.cleanroom?.hypervisor ?? null, receipt: trendFromEvidence(winEvidence) },
  ];
  const dispatch = {
    benchmarkId: VI_ANALYZER_WORKLOAD,
    benchmark,
    minActors: 2,
    requestedPlanes: ['LINUX', 'WIN'],
    requester: 'operator@labview-benchmark-actor',
    dispatchedAt: '2026-08-03',
    coordination: 'GitHub-native (repository_dispatch / Actions queue) -- the mesh carries the VI Analyzer benchmark (LBA-REQ-081 identity), not only launch (LBA-REQ-072).',
  };
  const fulfillment = buildFulfillment({ dispatch, actors });
  const identity = benchmarkIdentity(benchmark);
  const distinctFromLaunch = identity !== benchmarkIdentity(LAUNCH_BENCHMARK);
  const run = {
    schema: RUN_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    family: 'vi-analyzer',
    benchmark,
    identity,
    distinctFromLaunch,
    fulfillment,
    verdict: {
      carried: fulfillment.verdict.fulfilled === true && distinctFromLaunch,
      reason: fulfillment.verdict.fulfilled === true && distinctFromLaunch
        ? `the mesh fulfilled the VI Analyzer benchmark ${String(identity).slice(0, 12)} (a distinct family from launch) via the same LBA-REQ-073 engine: ${fulfillment.fulfillment.distinctActors} actors across [${fulfillment.fulfillment.planes.join(', ')}]`
        : 'the mesh did not carry the VI Analyzer benchmark (not fulfilled, or not a distinct family)',
    },
  };
  run.digest = digestRun(run);
  return run;
}

// Validate a committed family run: the embedded fulfillment holds (LBA-REQ-073 engine), it is the VI Analyzer
// benchmark, its actor receipts descend from the real committed evidence (grounding), it is a distinct family from
// launch, and the digest re-derives. Fail-closed.
export function validateFamilyRun(run, { linuxEvidence, winEvidence } = {}) {
  const findings = [];
  if (!run || run.schema !== RUN_SCHEMA) findings.push(`schema must be ${RUN_SCHEMA}`);
  if (run?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (run?.adr !== ADR) findings.push(`adr must be ${ADR}`);

  // the embedded cross-plane fulfillment must hold (reuse the LBA-REQ-073 verifier).
  const fv = validateFulfillment(run?.fulfillment ?? {});
  if (!fv.ok || !fv.proofOk) findings.push(...fv.findings.map((f) => `fulfillment: ${f}`), ...(fv.ok && !fv.proofOk ? ['fulfillment: not fulfilled'] : []));

  // it must be the VI Analyzer benchmark, and the identity must re-derive.
  const benchmark = run?.benchmark;
  if (!(benchmark?.metric === VI_ANALYZER_METRIC && benchmark?.workload === VI_ANALYZER_WORKLOAD)) findings.push('the run is not the VI Analyzer benchmark');
  if (run?.identity !== benchmarkIdentity(benchmark)) findings.push('identity does not match the VI Analyzer benchmark spec');
  if (run?.fulfillment?.identity !== run?.identity) findings.push('the embedded fulfillment is for a different benchmark identity');

  // it must be a DISTINCT family from the launch benchmark (the mesh carries > 1 benchmark).
  const distinct = run?.identity !== benchmarkIdentity(LAUNCH_BENCHMARK);
  if (run?.distinctFromLaunch !== distinct) findings.push('distinctFromLaunch does not match the identities');
  if (!distinct) findings.push('the VI Analyzer run is not distinct from the launch benchmark');

  // grounding: the actor receipts must descend from the real committed VI Analyzer captures.
  if (linuxEvidence && winEvidence) {
    const wantLinux = JSON.stringify(trendFromEvidence(linuxEvidence));
    const wantWin = JSON.stringify(trendFromEvidence(winEvidence));
    const actors = Array.isArray(run?.fulfillment?.actors) ? run.fulfillment.actors : [];
    const gotLinux = actors.find((a) => a.plane === 'LINUX')?.receipt;
    const gotWin = actors.find((a) => a.plane === 'WIN')?.receipt;
    if (JSON.stringify(gotLinux) !== wantLinux) findings.push('the LINUX actor receipt does not descend from the committed VI Analyzer evidence');
    if (JSON.stringify(gotWin) !== wantWin) findings.push('the WIN actor receipt does not descend from the committed VI Analyzer evidence');
  }

  const carried = run?.fulfillment?.verdict?.fulfilled === true && distinct;
  if (run?.verdict?.carried !== carried) findings.push(`verdict.carried=${run?.verdict?.carried} contradicts the rule (${carried})`);
  if (run?.digest !== digestRun(run)) findings.push('digest does not match (tampered)');
  return { ok: findings.length === 0, proofOk: run?.verdict?.carried === true && findings.length === 0, findings };
}

// Read the two committed VI Analyzer captures (offline) into a decision context.
export function committedContext(here) {
  const read = (p) => JSON.parse(readFileSync(join(here, p), 'utf8'));
  return {
    linuxEvidence: read(join('..', 'vi-analyzer', 'vi-analyzer-trend-live-evidence.json')),
    winEvidence: read(join('..', 'vi-analyzer', 'vi-analyzer-trend-live-evidence-WIN.json')),
  };
}

// CLI: validate the committed VI Analyzer mesh-run family record against the committed evidence.
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const ctx = committedContext(here);
  const run = JSON.parse(readFileSync(join(here, 'mesh-run-vi-analyzer-family.json'), 'utf8'));
  const r = validateFamilyRun(run, ctx);
  if (!r.ok || !r.proofOk) {
    console.error('[mesh-benchmark-family-vi-analyzer] FAIL');
    for (const f of r.findings) console.error(`  - ${f}`);
    if (r.ok && !r.proofOk) console.error(`  - not carried: ${run.verdict?.reason}`);
    process.exit(1);
  }
  const f = run.fulfillment.fulfillment;
  console.log(`[mesh-benchmark-family-vi-analyzer] OK ${REQUIREMENT}: the mesh carries VI Analyzer ${String(run.identity).slice(0, 12)} (distinct from launch) -- ${f.distinctActors} actors across [${f.planes.join(', ')}]`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
