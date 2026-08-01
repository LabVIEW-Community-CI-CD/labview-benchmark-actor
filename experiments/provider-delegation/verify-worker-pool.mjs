#!/usr/bin/env node
// Deterministic self-test for the persistent WORKER POOL (loopback, mock provider with a small delay so
// claims overlap -- no GPU / no network). Proves the pool BOUNDS concurrency: M concurrent claims against a
// pool of size N run at most N at a time (the rest queue FIFO), every claim is ACKed + returns a DONE, and
// the worker stays up to take a further claim afterwards (persistent). Exit 0 = proven.

import assert from 'node:assert';
import { startWorker } from './worker.mjs';
import { dispatchClaim } from './coordinator.mjs';
import { TASK_SCHEMA } from './delegateUplift.mjs';

const CONCURRENCY = 2;
const M = 5;

// A mock drive with an 80 ms delay + a live-count instrument, so we can observe the pool bounding the number
// of IN-FLIGHT provider calls to N (peakDrive). Deterministic: no network, no model.
let inflight = 0;
let peakDrive = 0;
const slowMock = async (_prompt, { sections = [] } = {}) => {
  inflight += 1;
  if (inflight > peakDrive) peakDrive = inflight;
  await new Promise((r) => setTimeout(r, 80));
  inflight -= 1;
  let text = '# Draft\n\nbody body body body body body body body\n';
  for (const s of sections) text += `\n## ${s}\n\nbody (${s})\n`;
  return { provider: 'mock', model: 'mock', text, ms: 80, ok: true, error: null };
};

const worker = await startWorker({ port: 0, host: '127.0.0.1', concurrency: CONCURRENCY, drive: slowMock, actorId: 'pool-worker' });
const wp = worker.address().port;
const mkTask = (i) => ({ schema: TASK_SCHEMA, domain: 'doc-draft', id: `T-POOL-${i}`, brief: 'x', requiredSections: ['Overview'], minChars: 20 });

let pass = 0;
const ok = (c, m) => { assert(c, m); pass += 1; };
const settle = async (pred, timeoutMs = 3000) => { const t = Date.now(); while (!pred() && Date.now() - t < timeoutMs) { await new Promise((r) => setImmediate(r)); } };

// Dispatch M claims CONCURRENTLY at the pool.
const t0 = Date.now();
const results = await Promise.all(
  Array.from({ length: M }, (_v, i) => dispatchClaim({ worker: `127.0.0.1:${wp}`, taskSpec: mkTask(i + 1), replyHost: '127.0.0.1', observePort: 0, timeoutMs: 20000 })),
);
const elapsed = Date.now() - t0;

ok(results.every((r) => r.ack && JSON.parse(r.ack.payload).claimed === true), `every one of ${M} concurrent claims was ACKed`);
ok(results.every((r) => r.done && r.done.verdict === 'pass'), `every one of ${M} concurrent claims returned DONE verdict=pass`);
ok(peakDrive === CONCURRENCY, `the pool bounded in-flight provider calls to ${CONCURRENCY} (observed peak = ${peakDrive})`);
ok(worker.poolStats().peak === CONCURRENCY, `pool peak concurrency = ${CONCURRENCY} (M=${M} > N=${CONCURRENCY} => the excess necessarily queued)`);
// the worker's running--/pump runs a microtask after the coordinator sees the DONE, so let the pool settle.
await settle(() => worker.poolStats().done === M && worker.poolStats().running === 0 && worker.poolStats().queued === 0);
ok(worker.poolStats().done === M && worker.poolStats().running === 0 && worker.poolStats().queued === 0, `pool drained: done=${M}, running=0, queued=0`);
// M=5 jobs @ 80 ms with N=2 => ceil(5/2)=3 batches => >= ~240 ms; NOT all-parallel (~80 ms). Proves serialization of the overflow.
ok(elapsed >= 3 * 80 * 0.8, `elapsed ${elapsed} ms is consistent with ${Math.ceil(M / CONCURRENCY)} pooled batches (not all-parallel)`);

// Persistence: the pool is still up and takes a further claim after draining.
const extra = await dispatchClaim({ worker: `127.0.0.1:${wp}`, taskSpec: mkTask(99), replyHost: '127.0.0.1', observePort: 0, timeoutMs: 20000 });
ok(extra.done && extra.done.verdict === 'pass' && worker.poolStats().done === M + 1, 'the pool is persistent: it accepts + completes a further claim after draining');

worker.close();
console.log(`verify-worker-pool: PASS (${pass} assertions) -- persistent pool bounded ${M} concurrent claims to ${CONCURRENCY}, drained, and stayed up`);
