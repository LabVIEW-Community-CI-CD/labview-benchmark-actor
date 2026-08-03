#!/usr/bin/env node
// meshDispatch.mjs -- the GitHub-native mesh-run DISPATCH request contract (LBA-REQ-074, realizes ADR-0055).
//
// This is the DISPATCH half of the North Star loop (the FULFILLMENT half is LBA-REQ-073). A requester emits a
// `mesh-run-dispatch@1` request -- the benchmark to run, how many independent actors are required, and which
// planes must be covered -- through a GitHub-native `repository_dispatch` event (`.github/workflows/mesh-run.yml`,
// event type `mesh-run`). Volunteer golden-VM actors run it in their sandboxes and return plane-tagged receipts,
// which `meshFulfillment.mjs` then gates. There is no central queue server: the repo IS the queue (auditable).
//
// The dispatch request carries the SAME machine-independent benchmark identity as the fulfillment
// (`launchIdentity` from LBA-REQ-072), so a dispatched run and its fulfillment are provably the SAME run.
//
// Pure + rg-free + offline: a committed request re-derives its identity + digest byte-stably in CI. Fails closed
// on a missing benchmarkId, an out-of-range minActors, an empty/invalid requested-planes set, an identity that
// does not match the benchmark spec, or a tampered digest.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { launchIdentity } from '../launch-parity/launchParity.mjs';

export const REQUEST_SCHEMA = 'labview-benchmark-actor/mesh-run-dispatch@1';
export const REQUIREMENT = 'LBA-REQ-074';
export const ADR = 'ADR-0055';
export const PLANES = ['LINUX', 'WIN'];

// The dispatched benchmark identity (reuses LBA-REQ-072): the SAME digest the fulfillment requires all actors to
// agree on, so a dispatch and its fulfillment are provably the same run.
export function dispatchIdentity(spec) {
  return launchIdentity(spec);
}

// A dispatch request is well-formed iff it names a benchmark (benchmarkId + a {metric,workload,n} spec), requires
// at least one actor, requests a non-empty set of valid distinct planes, and carries a dispatchId.
export function requestOk(req) {
  const b = req?.benchmark ?? {};
  const planes = req?.requestedPlanes;
  const planesOk = Array.isArray(planes) && planes.length > 0
    && planes.every((p) => PLANES.includes(p))
    && new Set(planes).size === planes.length;
  return !!req
    && typeof req.benchmarkId === 'string' && req.benchmarkId.length > 0
    && typeof b.metric === 'string' && b.metric.length > 0
    && typeof b.workload === 'string' && b.workload.length > 0
    && Number.isFinite(b.n) && b.n > 0
    && Number.isInteger(req.minActors) && req.minActors >= 1
    && planesOk
    && typeof req.dispatchId === 'string' && req.dispatchId.length > 0;
}

// Digest over the request-bearing fields (schema/id, the benchmark spec + identity, minActors, requested planes)
// -- NOT the descriptive prose (requester / coordination / note / dispatchedAt).
function canonical(req) {
  return JSON.stringify({
    schema: req.schema,
    requirement: req.requirement,
    adr: req.adr,
    dispatchId: req.dispatchId ?? null,
    benchmarkId: req.benchmarkId ?? null,
    benchmark: req.benchmark ?? null,
    identity: req.identity ?? null,
    minActors: req.minActors ?? null,
    requestedPlanes: Array.isArray(req.requestedPlanes) ? req.requestedPlanes : null,
  });
}

export function digestRequest(req) {
  return createHash('sha256').update(canonical(req)).digest('hex');
}

// Build a mesh-run dispatch request from a spec.
export function buildRequest(spec = {}) {
  const req = {
    schema: REQUEST_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    dispatchId: spec.dispatchId ?? null,
    benchmarkId: spec.benchmarkId ?? null,
    benchmark: spec.benchmark ?? null,
    identity: dispatchIdentity(spec.benchmark),
    minActors: Number.isInteger(spec.minActors) ? spec.minActors : 2,
    requestedPlanes: Array.isArray(spec.requestedPlanes) ? spec.requestedPlanes : [],
    requester: spec.requester ?? null,
    coordination: spec.coordination
      ?? 'GitHub-native repository_dispatch (event type mesh-run) -- the repo IS the queue; volunteer actors return plane-tagged receipts, no central server.',
    dispatchedAt: spec.dispatchedAt ?? null,
  };
  req.digest = digestRequest(req);
  return req;
}

// Validate a committed dispatch request: schema/requirement/adr, well-formed, the identity re-derives from the
// benchmark spec, and the digest re-derives. Fail-closed.
export function validateRequest(req) {
  const findings = [];
  if (!req || req.schema !== REQUEST_SCHEMA) findings.push(`schema must be ${REQUEST_SCHEMA}`);
  if (req?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (req?.adr !== ADR) findings.push(`adr must be ${ADR}`);
  if (!requestOk(req)) findings.push('the dispatch request is not well-formed (benchmarkId + benchmark spec + minActors>=1 + a non-empty valid requestedPlanes set + dispatchId)');
  if (req?.identity !== dispatchIdentity(req?.benchmark)) findings.push('identity does not match the benchmark spec (metric + workload + n)');
  if (req?.digest !== digestRequest(req)) findings.push('digest does not match the request-bearing fields (tampered)');
  return { ok: findings.length === 0, findings };
}

// CLI: validate a dispatch request. With no arg, validates the committed request next to this module; with a
// path arg, validates that file (used by the mesh-run workflow on the repository_dispatch payload). Exit 1 on any
// finding.
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const argPath = process.argv[2];
  const reqPath = argPath || join(here, 'mesh-run-dispatch-request.json');
  const req = JSON.parse(readFileSync(reqPath, 'utf8'));
  const result = validateRequest(req);
  if (!result.ok) {
    console.error(`[mesh-run-dispatch] FAIL ${reqPath}`);
    for (const f of result.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`[mesh-run-dispatch] OK ${REQUIREMENT}: dispatch ${req.dispatchId} -- ${req.benchmarkId} (>= ${req.minActors} actors, planes [${req.requestedPlanes.join(', ')}])`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
