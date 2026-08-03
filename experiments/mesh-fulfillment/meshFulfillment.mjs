#!/usr/bin/env node
// meshFulfillment.mjs -- mesh-run cross-plane FULFILLMENT builder + validator (LBA-REQ-073, realizes ADR-0054).
//
// The North Star loop (roadmap Phase 3): a requester DISPATCHES a cross-plane benchmark run, and >= N independent
// volunteer golden-VM actors from DISTINCT planes each run it in their sandbox and RETURN a plane-tagged receipt.
// This engine governs the FULFILLMENT proof -- there is no central results database; the returned receipts ARE
// the result, and this fail-closed verifier proves the dispatched run was actually fulfilled by enough distinct
// cross-plane actors who all ran the SAME benchmark.
//
// It COMPOSES existing pieces rather than duplicating them: the actor identity model (mesh-actors.csv, LBA-REQ-039),
// the CLAIM/ACK/DONE dispatch primitives (provider-delegation, LBA-REQ-018), and -- crucially -- the cross-plane
// benchmark IDENTITY of LBA-REQ-072 (`launchParity.launchIdentity`, the machine-independent spec digest). A run is
// fulfilled iff the requested planes are covered by >= minActors DISTINCT enrolled actors, each returning a valid
// plane-tagged benchmark receipt whose identity AGREES with the dispatched benchmark. Pure + rg-free + offline: a
// committed receipt re-derives its fulfillment + digest byte-stably in CI. Fails closed on too few actors, a
// duplicate actor, an uncovered plane, an invalid/wrong-benchmark receipt, an identity disagreement, or a tampered
// digest.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { launchIdentity, trendOk } from '../launch-parity/launchParity.mjs';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/mesh-run-fulfillment-receipt@1';
export const REQUIREMENT = 'LBA-REQ-073';
export const ADR = 'ADR-0054';

// The benchmark identity a dispatched run + every actor's returned receipt must share (reuses LBA-REQ-072).
export function benchmarkIdentity(spec) {
  return launchIdentity(spec);
}

// An actor's returned run is STRUCTURALLY valid iff it carries an enrolled actor identity (actorId + plane) and
// a valid plane-tagged benchmark receipt (workload-trend@1) whose plane matches the actor's declared plane. That
// it ran the DISPATCHED benchmark is the separate `identityAgreement` invariant below.
export function actorRunOk(a) {
  const r = a?.receipt;
  return !!a
    && typeof a.actorId === 'string' && a.actorId.length > 0
    && (a.plane === 'LINUX' || a.plane === 'WIN')
    && trendOk(r) && r.plane === a.plane;
}

// Decide fulfillment over a receipt-shaped object: every actor valid, actors distinct, requested planes covered
// by >= minActors distinct actors, and all actor receipt identities AGREE with the dispatched benchmark identity.
export function decideFulfillment(receipt) {
  const reasons = [];
  const dispatch = receipt?.dispatch ?? {};
  const actors = Array.isArray(receipt?.actors) ? receipt.actors : [];
  const minActors = Number.isFinite(dispatch.minActors) ? dispatch.minActors : 2;
  const requestedPlanes = Array.isArray(dispatch.requestedPlanes) ? dispatch.requestedPlanes : [];
  const identity = benchmarkIdentity(dispatch.benchmark);

  const allValid = actors.length > 0 && actors.every((a) => actorRunOk(a));
  if (!allValid) reasons.push('an actor returned an invalid plane-tagged receipt (or no actors responded)');

  const actorIds = actors.map((a) => a?.actorId);
  const distinctActors = [...new Set(actorIds)];
  if (distinctActors.length !== actorIds.length) reasons.push('actors are not distinct (a duplicate actorId responded)');

  const planes = [...new Set(actors.filter((a) => a?.plane).map((a) => a.plane))];
  const planesCovered = requestedPlanes.length > 0 && requestedPlanes.every((p) => planes.includes(p));
  if (!planesCovered) reasons.push(`the responding actors do not cover the requested planes [${requestedPlanes.join(', ')}] (got [${planes.join(', ')}])`);

  const identityAgreement = allValid && actors.every((a) => launchIdentity(a.receipt) === identity);
  if (allValid && !identityAgreement) reasons.push('the actors did not all run the same benchmark identity (cross-plane identity disagreement)');

  const minActorsMet = distinctActors.length >= minActors;
  if (!minActorsMet) reasons.push(`fewer than ${minActors} distinct actors responded (got ${distinctActors.length})`);

  const fulfilled = allValid && distinctActors.length === actorIds.length && planesCovered && identityAgreement && minActorsMet;
  return { respondingActors: actors.length, distinctActors: distinctActors.length, planes, planesCovered, identityAgreement, minActorsMet, identity, fulfilled, reasons };
}

// A compact, digest-bearing summary of one actor (identity + the plane-specific timing witness), so the receipt
// is tamper-evident over what each actor claimed without the full nested receipt driving the digest.
function actorSummary(a) {
  return {
    actorId: a?.actorId ?? null,
    role: a?.role ?? null,
    plane: a?.plane ?? null,
    receiptIdentity: a?.receipt ? launchIdentity(a.receipt) : null,
    meanMs: a?.receipt?.stats?.mean ?? null,
    verdict: a?.receipt?.verdict ?? null,
  };
}

// Digest over the verdict-bearing fields (the dispatch, the benchmark identity, each actor's identity summary,
// the fulfillment flags, and the aggregate verdict) -- NOT the descriptive prose or the full nested receipts.
function canonical(receipt) {
  return JSON.stringify({
    schema: receipt.schema,
    requirement: receipt.requirement,
    adr: receipt.adr,
    dispatch: {
      benchmarkId: receipt.dispatch?.benchmarkId ?? null,
      benchmark: receipt.dispatch?.benchmark ?? null,
      minActors: receipt.dispatch?.minActors ?? null,
      requestedPlanes: Array.isArray(receipt.dispatch?.requestedPlanes) ? receipt.dispatch.requestedPlanes : null,
    },
    identity: receipt.identity ?? null,
    actors: Array.isArray(receipt.actors) ? receipt.actors.map(actorSummary) : null,
    fulfillment: receipt.fulfillment ?? null,
    verdict: { fulfilled: receipt.verdict?.fulfilled },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build a mesh-run fulfillment receipt from a dispatch + the actors' returned runs.
export function buildReceipt({ dispatch, actors } = {}) {
  const draft = {
    schema: RECEIPT_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    dispatch: dispatch ?? null,
    identity: benchmarkIdentity(dispatch?.benchmark),
    actors: Array.isArray(actors) ? actors : [],
  };
  const d = decideFulfillment(draft);
  draft.fulfillment = {
    respondingActors: d.respondingActors,
    distinctActors: d.distinctActors,
    planes: d.planes,
    planesCovered: d.planesCovered,
    identityAgreement: d.identityAgreement,
    minActorsMet: d.minActorsMet,
  };
  draft.verdict = {
    fulfilled: d.fulfilled,
    reason: d.fulfilled
      ? `dispatched run ${dispatch.benchmarkId} fulfilled by ${d.distinctActors} distinct actors covering planes [${d.planes.join(', ')}]; all ran the same benchmark identity`
      : ('run not fulfilled: ' + d.reasons.join('; ')),
  };
  draft.digest = digestReceipt(draft);
  return draft;
}

// Validate a committed receipt: schema/requirement/adr, the benchmark identity re-derives, the fulfillment
// decision holds (enough distinct cross-plane actors, all valid, identities agree), the verdict matches the
// rule, and the digest re-derives. Fail-closed.
export function validateReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (receipt?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (receipt?.adr !== ADR) findings.push(`adr must be ${ADR}`);
  const expectedIdentity = benchmarkIdentity(receipt?.dispatch?.benchmark);
  if (receipt?.identity !== expectedIdentity) findings.push('identity does not match the dispatched benchmark spec');
  const d = decideFulfillment(receipt ?? {});
  for (const r of d.reasons) findings.push(r);
  if (receipt?.verdict?.fulfilled !== d.fulfilled) findings.push(`verdict.fulfilled=${receipt?.verdict?.fulfilled} contradicts the rule (${d.fulfilled})`);
  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, proofOk: !!receipt?.verdict?.fulfilled && findings.length === 0, findings };
}

// CLI: validate the committed receipt next to this module (offline, deterministic). Exit 1 on any finding.
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const receiptPath = join(here, 'mesh-run-fulfillment-receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const result = validateReceipt(receipt);
  if (!result.ok) {
    console.error(`[mesh-run-fulfillment] FAIL ${receiptPath}`);
    for (const f of result.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  const f = receipt.fulfillment;
  console.log(`[mesh-run-fulfillment] OK ${REQUIREMENT}: dispatched ${receipt.dispatch.benchmarkId} fulfilled by ${f.distinctActors} distinct actors covering [${f.planes.join(', ')}]; verdict fulfilled=${result.proofOk}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
