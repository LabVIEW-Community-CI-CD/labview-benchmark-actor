#!/usr/bin/env node
// meshFanout.mjs -- the LIVE FAN-OUT contract (LBA-REQ-076, realizes ADR-0057). Governs the two contracts that
// sit BETWEEN a mesh-run dispatch (LBA-REQ-074) and its fulfillment (LBA-REQ-073): how the dispatch TASKS the
// volunteer actors, and how their returned plane-tagged receipts are COLLECTED back into the fulfillment input.
//
//   dispatch (074) --deriveTasking--> actor-tasking@1 --[actors run in their sandboxes]--> returned receipts
//     --buildCollection--> receipt-collection@1 --collectionToActors--> meshFulfillment (073) --> observatory (075)
//
// Both contracts are IDENTITY-BOUND to the dispatch (the LBA-REQ-072 launch identity), so a task provably belongs
// to a dispatch and a collected receipt provably ran the dispatched benchmark. Pure + rg-free + offline: committed
// tasking + collection re-derive their digests byte-stably in CI, and the collection provably reconstructs the
// committed fulfillment's actor set (grounding). The live execution stays out of CI; the committed receipts are
// the proof. Fails closed on an unbound task, an uncovered plane, a collected receipt with no matching task, a
// plane/identity mismatch, a duplicate actor, or a tampered digest.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { launchIdentity, trendOk } from '../launch-parity/launchParity.mjs';

export const TASKING_SCHEMA = 'labview-benchmark-actor/actor-tasking@1';
export const COLLECTION_SCHEMA = 'labview-benchmark-actor/receipt-collection@1';
export const REQUIREMENT = 'LBA-REQ-076';
export const ADR = 'ADR-0057';

const PLANES = new Set(['LINUX', 'WIN']);
const taskIdOf = (dispatchId, plane) => `${dispatchId}::${plane}`;

// ---- tasking: derive the per-plane actor tasks from a validated dispatch (074) -------------------------------
export function deriveTasking(dispatch) {
  const planes = Array.isArray(dispatch?.requestedPlanes) ? dispatch.requestedPlanes : [];
  const tasks = planes.map((plane) => ({
    taskId: taskIdOf(dispatch?.dispatchId, plane),
    dispatchId: dispatch?.dispatchId ?? null,
    benchmarkId: dispatch?.benchmarkId ?? null,
    benchmark: dispatch?.benchmark ?? null,
    plane,
    identity: dispatch?.identity ?? null,
  }));
  const tasking = {
    schema: TASKING_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    dispatchId: dispatch?.dispatchId ?? null,
    benchmarkId: dispatch?.benchmarkId ?? null,
    benchmark: dispatch?.benchmark ?? null,
    identity: dispatch?.identity ?? null,
    minActors: dispatch?.minActors ?? null,
    requestedPlanes: planes,
    tasks,
  };
  tasking.digest = digestTasking(tasking);
  return tasking;
}

function canonicalTasking(t) {
  return JSON.stringify({
    schema: t.schema, requirement: t.requirement, adr: t.adr,
    dispatchId: t.dispatchId, benchmarkId: t.benchmarkId, benchmark: t.benchmark ?? null,
    identity: t.identity, minActors: t.minActors, requestedPlanes: t.requestedPlanes ?? null,
    tasks: Array.isArray(t.tasks) ? t.tasks.map((k) => ({ taskId: k.taskId, dispatchId: k.dispatchId, benchmarkId: k.benchmarkId, plane: k.plane, identity: k.identity })) : null,
  });
}

export function digestTasking(t) {
  return createHash('sha256').update(canonicalTasking(t)).digest('hex');
}

// Validate a tasking set: schema/requirement, a 64-hex identity, every task dispatch-bound + identity-bound +
// on a valid distinct plane with a canonical taskId whose benchmark spec hashes to the tasking identity, the
// tasks cover the requested planes, and (if the dispatch is given) the tasking binds to it. Fail-closed.
export function validateTasking(tasking, dispatch) {
  const findings = [];
  if (!tasking || tasking.schema !== TASKING_SCHEMA) findings.push(`schema must be ${TASKING_SCHEMA}`);
  if (tasking?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (tasking?.adr !== ADR) findings.push(`adr must be ${ADR}`);
  if (!(typeof tasking?.identity === 'string' && /^[0-9a-f]{64}$/.test(tasking.identity))) findings.push('tasking identity must be a 64-hex benchmark identity');
  const tasks = Array.isArray(tasking?.tasks) ? tasking.tasks : [];
  if (tasks.length === 0) findings.push('tasking has no tasks');

  const planes = [];
  tasks.forEach((k, i) => {
    if (k.dispatchId !== tasking.dispatchId) findings.push(`task[${i}] is not bound to the tasking dispatchId`);
    if (k.identity !== tasking.identity) findings.push(`task[${i}] is not bound to the tasking identity`);
    if (!PLANES.has(k.plane)) findings.push(`task[${i}] has an invalid plane (${k.plane})`);
    if (k.taskId !== taskIdOf(tasking.dispatchId, k.plane)) findings.push(`task[${i}] taskId is not canonical`);
    if (k.benchmark && launchIdentity(k.benchmark) !== tasking.identity) findings.push(`task[${i}] benchmark spec does not hash to the tasking identity`);
    planes.push(k.plane);
  });
  if (new Set(planes).size !== planes.length) findings.push('tasking has duplicate-plane tasks');

  const req = Array.isArray(tasking?.requestedPlanes) ? tasking.requestedPlanes : [];
  if (!(req.length > 0 && req.every((p) => planes.includes(p)))) findings.push('tasks do not cover the requested planes');

  if (dispatch) {
    if (dispatch.dispatchId !== tasking.dispatchId) findings.push('tasking dispatchId does not match the dispatch');
    if (dispatch.identity !== tasking.identity) findings.push('tasking identity does not match the dispatch');
    if (JSON.stringify(dispatch.requestedPlanes) !== JSON.stringify(tasking.requestedPlanes)) findings.push('tasking planes do not match the dispatch');
  }
  if (tasking?.digest !== digestTasking(tasking)) findings.push('tasking digest does not match (tampered)');
  return { ok: findings.length === 0, findings };
}

// ---- collection: gather the actors' returned receipts back into the fulfillment input ------------------------
export function buildCollection({ tasking, returned } = {}) {
  const collected = (returned ?? []).map((r) => ({ taskId: r.taskId, actorId: r.actorId, plane: r.plane, receipt: r.receipt }));
  const actors = collected.map((c) => ({ actorId: c.actorId, plane: c.plane, receipt: c.receipt }));
  const collection = {
    schema: COLLECTION_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    dispatchId: tasking?.dispatchId ?? null,
    identity: tasking?.identity ?? null,
    collected,
    actors,
  };
  collection.digest = digestCollection(collection);
  return collection;
}

function canonicalCollection(c) {
  return JSON.stringify({
    schema: c.schema, requirement: c.requirement, adr: c.adr,
    dispatchId: c.dispatchId, identity: c.identity,
    collected: Array.isArray(c.collected)
      ? c.collected.map((k) => ({ taskId: k.taskId, actorId: k.actorId, plane: k.plane, receiptIdentity: trendOk(k.receipt) ? launchIdentity(k.receipt) : null, meanMs: k.receipt?.stats?.mean ?? null }))
      : null,
  });
}

export function digestCollection(c) {
  return createHash('sha256').update(canonicalCollection(c)).digest('hex');
}

// The actor set (shape { actorId, plane, receipt }) that meshFulfillment (073) consumes.
export function collectionToActors(collection) {
  return (collection?.actors ?? []).map((a) => ({ actorId: a.actorId, plane: a.plane, receipt: a.receipt }));
}

// Validate a collection: schema/requirement, non-empty, every collected receipt maps to a task (if tasking is
// given), the plane + receipt-plane agree, the receipt is a valid trend whose identity equals the dispatched
// identity, actors are distinct, the tasked planes are covered, and the digest re-derives. Fail-closed.
export function validateCollection(collection, tasking) {
  const findings = [];
  if (!collection || collection.schema !== COLLECTION_SCHEMA) findings.push(`schema must be ${COLLECTION_SCHEMA}`);
  if (collection?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (collection?.adr !== ADR) findings.push(`adr must be ${ADR}`);
  const collected = Array.isArray(collection?.collected) ? collection.collected : [];
  if (collected.length === 0) findings.push('collection is empty');

  const taskMap = new Map((tasking?.tasks ?? []).map((k) => [k.taskId, k]));
  const seenActors = new Set();
  const planes = [];
  collected.forEach((c, i) => {
    const task = taskMap.get(c.taskId);
    if (tasking && !task) findings.push(`collected[${i}] taskId (${c.taskId}) has no matching task`);
    if (task && c.plane !== task.plane) findings.push(`collected[${i}] plane (${c.plane}) != its task plane (${task.plane})`);
    if (!trendOk(c.receipt)) findings.push(`collected[${i}] receipt is not a valid plane-tagged trend`);
    else if (c.receipt.plane !== c.plane) findings.push(`collected[${i}] receipt plane != the collected plane`);
    else if (launchIdentity(c.receipt) !== collection.identity) findings.push(`collected[${i}] receipt identity != the dispatched identity`);
    if (seenActors.has(c.actorId)) findings.push(`collected[${i}] duplicate actor (${c.actorId})`);
    seenActors.add(c.actorId);
    planes.push(c.plane);
  });

  if (tasking) {
    const req = Array.isArray(tasking.requestedPlanes) ? tasking.requestedPlanes : [];
    if (!(req.length > 0 && req.every((p) => planes.includes(p)))) findings.push('collection does not cover the tasked planes');
    if (collection.dispatchId !== tasking.dispatchId) findings.push('collection dispatchId does not match the tasking');
    if (collection.identity !== tasking.identity) findings.push('collection identity does not match the tasking');
  }
  if (collection?.digest !== digestCollection(collection)) findings.push('collection digest does not match (tampered)');
  return { ok: findings.length === 0, findings };
}

// CLI: validate the committed tasking + collection against the committed dispatch, offline + deterministic.
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const dispatch = JSON.parse(readFileSync(join(here, 'mesh-run-dispatch-request.json'), 'utf8'));
  const tasking = JSON.parse(readFileSync(join(here, 'mesh-run-tasking.json'), 'utf8'));
  const collection = JSON.parse(readFileSync(join(here, 'mesh-run-collection.json'), 'utf8'));
  const vt = validateTasking(tasking, dispatch);
  const vc = validateCollection(collection, tasking);
  const findings = [...vt.findings.map((f) => `tasking: ${f}`), ...vc.findings.map((f) => `collection: ${f}`)];
  if (findings.length > 0) {
    console.error('[mesh-live-fanout] FAIL');
    for (const f of findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`[mesh-live-fanout] OK ${REQUIREMENT}: ${tasking.tasks.length} task(s) -> ${collection.collected.length} collected receipt(s) across [${tasking.requestedPlanes.join(', ')}], identity-bound to dispatch ${dispatch.dispatchId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
