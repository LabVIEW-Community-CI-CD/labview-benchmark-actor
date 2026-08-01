#!/usr/bin/env node
// Deterministic self-test for the claim registry / router (loopback, mock providers -- no GPU / no network).
// Spins THREE workers with different capabilities + a dead address, then proves: liveness discovery excludes
// the dead worker; a risky-test(ffmpeg) routes ONLY to the ffmpeg-capable worker; a capability-free task
// round-robins across all workers; a batch is dispatched + run across the pool; a task with no capable worker
// is unroutable. Exit 0 = proven.

import assert from 'node:assert';
import { startWorker } from './worker.mjs';
import { discover, route, capable, requiredCapabilities, dispatchAcrossPool } from './registry.mjs';
import { TASK_SCHEMA } from './delegateUplift.mjs';

// worker-A + worker-B: general (no ffmpeg); worker-C: has ffmpeg. Synthetic caps via the `caps` override.
const wA = await startWorker({ port: 0, host: '127.0.0.1', provider: 'mock', actorId: 'worker-A', caps: { tools: { ffmpeg: false } } });
const wB = await startWorker({ port: 0, host: '127.0.0.1', provider: 'mock', actorId: 'worker-B', caps: { tools: { ffmpeg: false } } });
const wC = await startWorker({ port: 0, host: '127.0.0.1', provider: 'mock', actorId: 'worker-C', caps: { tools: { ffmpeg: true } } });
const addr = (w) => `127.0.0.1:${w.address().port}`;
const DEAD = '127.0.0.1:9'; // nothing listening

let pass = 0;
const ok = (c, m) => { assert(c, m); pass += 1; };

// 1) discovery + liveness: 3 alive, the dead address excluded
const reg = await discover([addr(wA), addr(wB), addr(wC), DEAD], { timeoutMs: 2500 });
ok(reg.length === 3, `discover finds the 3 live workers, excludes the dead address (found ${reg.length})`);
ok(reg.every((w) => w.caps && w.caps.agent && w.caps.tools), 'each live worker reported its capabilities (agent + tools)');
const byAgent = (a) => reg.find((w) => w.caps.agent === a);

// 2) capability routing: an ffmpeg risky-test is only capable on worker-C
const rt = { schema: TASK_SCHEMA, domain: 'risky-test', id: 'T-R', tool: 'ffmpeg', brief: 'x' };
ok(requiredCapabilities(rt).tool === 'ffmpeg', 'a risky-test task requires its tool');
ok(capable(byAgent('worker-C'), rt) === true && capable(byAgent('worker-A'), rt) === false, 'only the ffmpeg-capable worker is eligible');
ok(route(reg, rt, { i: 0 }).caps.agent === 'worker-C', 'the ffmpeg risky-test routes to the ONLY ffmpeg-capable worker');

// 3) load-balance: a capability-free task round-robins across all 3 workers
const cursor = { i: 0 };
const anyTask = { schema: TASK_SCHEMA, domain: 'doc-draft', id: 'T-D', brief: 'x', requiredSections: [], minChars: 1 };
const picks = [route(reg, anyTask, cursor).caps.agent, route(reg, anyTask, cursor).caps.agent, route(reg, anyTask, cursor).caps.agent];
ok(new Set(picks).size === 3, `a capability-free task round-robins across all 3 workers (${picks.join(',')})`);

// 4) end-to-end: dispatchAcrossPool discovers, routes + runs a batch; each returns a verdict
const batch = [
  { schema: TASK_SCHEMA, domain: 'doc-draft', id: 'B-1', brief: 'note', requiredSections: [], minChars: 1 },
  { schema: TASK_SCHEMA, domain: 'doc-draft', id: 'B-2', brief: 'note', requiredSections: [], minChars: 1 },
  { schema: TASK_SCHEMA, domain: 'doc-draft', id: 'B-3', brief: 'note', requiredSections: [], minChars: 1 },
];
const out = await dispatchAcrossPool([addr(wA), addr(wB), addr(wC)], batch, { replyHost: '127.0.0.1', timeoutMs: 15000 });
ok(out.results.length === 3 && out.results.every((r) => r.verdict === 'pass'), 'dispatchAcrossPool routes + runs each task to a live worker -> pass');
ok(new Set(out.results.map((r) => r.routedTo)).size === 3, 'the batch was distributed across all 3 registered workers');

// 5) unroutable: an ffmpeg risky-test with NO ffmpeg-capable worker in the registry
const noFf = await discover([addr(wA), addr(wB)], { timeoutMs: 2500 });
ok(route(noFf, rt) === null, 'a task with no capable live worker is unroutable (null)');

wA.close(); wB.close(); wC.close();
console.log(`verify-registry: PASS (${pass} assertions) -- capability + liveness routing + load-balance across a multi-worker cleanroom pool`);
