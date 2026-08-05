#!/usr/bin/env node
// meshIngest.mjs -- LBA-REQ-091 / ADR-0074. The RUN-BOUND INGESTION SEAM of the North Star mesh loop.
//
// Turns a LIVE mesh-run dispatch (LBA-REQ-074, the repository_dispatch client_payload) + the actors' RETURNED
// plane-tagged receipts (handed off by the agent driver that ran the two real golden-VM actors) into the run-bound
// actor-tasking@1 + receipt-collection@1 (LBA-REQ-076) -- so the mesh-run pipeline GATES the ACTUAL returned
// receipts of THIS dispatch, not a committed fixture. REUSES meshDispatch (request identity) + meshFanout
// (deriveTasking / buildCollection / validateTasking / validateCollection / collectionToActors) -- no gating logic
// is reimplemented here; this only binds the live inputs to those proven validators.
//
//   dispatch (074, validated)  --deriveTasking-->  tasking (076)
//   returned receipts (agent handoff, one returned-receipt@1 per actor)  --buildCollection-->  collection (076)
//   both IDENTITY-BOUND to the dispatchId  -->  collectionToActors  -->  meshFulfillment (073)
//
// Pure + offline: the agent driver runs the two real actors OUTSIDE CI and drops their returned-receipt@1 files in
// a folder; this ingests + validates them into the fulfillment input. The selftest proves the ingestion + every
// fail-closed guard deterministically. Fails closed on a malformed dispatch, a returned receipt not bound to a
// task, a plane/identity mismatch, a duplicate actor, an uncovered requested plane, or a tampered digest.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { requestOk, dispatchIdentity } from './meshDispatch.mjs';
import { deriveTasking, buildCollection, validateTasking, validateCollection, collectionToActors } from './meshFanout.mjs';

export const RETURNED_SCHEMA = 'labview-benchmark-actor/returned-receipt@1';
export const REQUIREMENT = 'LBA-REQ-091';
export const ADR = 'ADR-0074';

// A returned receipt is what the agent driver drops per actor after running the real benchmark in that actor's
// sandbox: the task it answers, the actor identity + plane, and the plane-tagged workload-trend@1 it produced.
export function returnedOk(r) {
  return !!r && r.schema === RETURNED_SCHEMA
    && typeof r.taskId === 'string' && r.taskId.length > 0
    && typeof r.actorId === 'string' && r.actorId.length > 0
    && typeof r.plane === 'string' && r.plane.length > 0
    && r.receipt && typeof r.receipt === 'object';
}

// Read the agent-handed-off returned-receipt@1 files from a folder (sorted -> deterministic ingestion order).
export function readReturned(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .filter((r) => r?.schema === RETURNED_SCHEMA);
}

// Ingest a validated live dispatch + the returned receipts into a run-bound { tasking, collection }, validated
// fail-closed + identity-bound to the dispatchId. `returned` = [{ schema, taskId, actorId, plane, receipt }].
export function ingestRun({ dispatch, returned } = {}) {
  const findings = [];
  if (!requestOk(dispatch)) findings.push('dispatch: malformed mesh-run-dispatch@1 request');
  else if (dispatch.identity !== dispatchIdentity(dispatch.benchmark)) findings.push('dispatch: identity does not match the benchmark spec');
  const list = Array.isArray(returned) ? returned : [];
  list.forEach((r, i) => { if (!returnedOk(r)) findings.push(`returned[${i}]: malformed returned-receipt@1`); });

  const tasking = deriveTasking(dispatch ?? {});
  const collection = buildCollection({ tasking, returned: list.filter(returnedOk) });
  for (const f of validateTasking(tasking, dispatch).findings) findings.push(`tasking: ${f}`);
  for (const f of validateCollection(collection, tasking).findings) findings.push(`collection: ${f}`);

  return { ok: findings.length === 0, findings, tasking, collection, actors: collectionToActors(collection) };
}

// CLI: meshIngest.mjs --dispatch <request.json> --returned <dir> [--out-tasking <p>] [--out-collection <p>]
function main() {
  const argv = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  }
  if (typeof opt.dispatch !== 'string' || typeof opt.returned !== 'string') {
    console.error('usage: meshIngest.mjs --dispatch <request.json> --returned <dir> [--out-tasking <p>] [--out-collection <p>]');
    process.exit(2);
  }
  const dispatch = JSON.parse(readFileSync(opt.dispatch, 'utf8'));
  const returned = readReturned(opt.returned);
  const r = ingestRun({ dispatch, returned });
  if (typeof opt['out-tasking'] === 'string') writeFileSync(opt['out-tasking'], JSON.stringify(r.tasking, null, 2) + '\n');
  if (typeof opt['out-collection'] === 'string') writeFileSync(opt['out-collection'], JSON.stringify(r.collection, null, 2) + '\n');
  if (!r.ok) {
    console.error(`[mesh-ingest] FAIL (dispatch ${dispatch?.dispatchId})`);
    for (const f of r.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`[mesh-ingest] OK ${REQUIREMENT}: ingested ${returned.length} returned receipt(s) -> run-bound collection across [${r.tasking.requestedPlanes.join(', ')}], identity-bound to dispatch ${dispatch.dispatchId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
