#!/usr/bin/env node
// Deterministic self-test for VIPM-capability routing (loopback, synthetic caps -- no real vipm, no network).
// Spins FOUR workers advertising different VIPM capabilities over the bus HELLO->READY handshake:
//   - worker-none: no vipm CLI;
//   - worker-free: vipm present, Edition=Free (package install only, cannot build);
//   - worker-comm: vipm present, Edition=Community (builds ONLY in a public repo);
//   - worker-pro:  vipm present, Edition=Professional (builds in any repo).
// Proves the router honors the operator's rule at the ROUTING layer: a VIPM task never goes to a worker without
// vipm; a Community-Edition build goes to a Community-or-Pro worker in a PUBLIC repo, but ONLY to a Pro worker in
// a PRIVATE repo; requireEdition pins exactly; and a VIPM task with no capable worker is unroutable. Exit 0 = proven.

import assert from 'node:assert';
import { startWorker } from './worker.mjs';
import { discover, route, capable, requiredCapabilities } from './registry.mjs';
import { TASK_SCHEMA } from './delegateUplift.mjs';

const mk = (actorId, vipm) => startWorker({ port: 0, host: '127.0.0.1', provider: 'mock', actorId, caps: { tools: {}, vipm } });
const wNone = await mk('worker-none', { present: false });
const wFree = await mk('worker-free', { present: true, edition: 'Free' });
const wComm = await mk('worker-comm', { present: true, edition: 'Community' });
const wPro = await mk('worker-pro', { present: true, edition: 'Professional' });
const addr = (w) => `127.0.0.1:${w.address().port}`;

let pass = 0;
const ok = (c, m) => { assert(c, m); pass += 1; };

// The VIPM capability crosses the bus in the READY handshake.
const reg = await discover([addr(wNone), addr(wFree), addr(wComm), addr(wPro)], { timeoutMs: 2500 });
ok(reg.length === 4, `discover finds all 4 workers (found ${reg.length})`);
ok(reg.every((w) => w.caps && w.caps.vipm), 'every worker advertised a vipm capability over the bus');
const byAgent = (a) => reg.find((w) => w.caps.agent === a);
ok(byAgent('worker-pro').caps.vipm.edition === 'Professional', 'the Professional edition is advertised over the bus');

// requiredCapabilities: a vipm task requires vipm; a build task also carries the repo-visibility requirement.
ok(requiredCapabilities({ domain: 'vipm' }).vipm === true, 'a vipm task requires the vipm capability');
ok(requiredCapabilities({ requireVipm: true, mode: 'community', publicRepo: false }).vipmBuild.publicRepo === false, 'a community build task carries the repo-visibility requirement');

// 1) a plain VIPM task (status/install) -> capable on any worker WITH vipm, not the one without.
const vipmTask = { schema: TASK_SCHEMA, domain: 'vipm', id: 'V-1', mode: 'status' };
ok(capable(wCapsNone(reg), vipmTask) === false, 'a VIPM task is NOT capable on a worker without vipm');
ok(capable(byAgent('worker-free'), vipmTask) && capable(byAgent('worker-comm'), vipmTask) && capable(byAgent('worker-pro'), vipmTask), 'a VIPM task is capable on every vipm-present worker');

// 2) a Community-Edition BUILD in a PUBLIC repo -> Community or Professional (not Free, not none).
const buildPublic = { schema: TASK_SCHEMA, domain: 'vipm', id: 'V-PUB', mode: 'community', publicRepo: true };
ok(capable(byAgent('worker-comm'), buildPublic) === true && capable(byAgent('worker-pro'), buildPublic) === true, 'a public-repo VIPM build is capable on Community AND Professional workers');
ok(capable(byAgent('worker-free'), buildPublic) === false, 'a VIPM build is NOT capable on a Free-edition worker');
ok(['worker-comm', 'worker-pro'].includes(route(reg, buildPublic, { i: 0 }).caps.agent), 'a public-repo VIPM build routes to a Community-or-Professional worker');

// 3) a Community-Edition BUILD in a PRIVATE repo -> ONLY Professional (Community is blocked in a private repo).
const buildPrivate = { schema: TASK_SCHEMA, domain: 'vipm', id: 'V-PRIV', mode: 'community', publicRepo: false };
ok(capable(byAgent('worker-comm'), buildPrivate) === false, 'a PRIVATE-repo VIPM build is NOT capable on a Community worker (needs a public repo)');
ok(capable(byAgent('worker-pro'), buildPrivate) === true, 'a PRIVATE-repo VIPM build IS capable on a Professional worker');
ok(route(reg, buildPrivate).caps.agent === 'worker-pro', 'a PRIVATE-repo VIPM build routes ONLY to the Professional worker');

// 4) requireEdition pins exactly.
const proOnly = { schema: TASK_SCHEMA, domain: 'vipm', id: 'V-PROONLY', requireEdition: 'Professional' };
ok(route(reg, proOnly).caps.agent === 'worker-pro', 'requireEdition=Professional routes only to the Professional worker');

// 5) unroutable: a PRIVATE-repo build across a registry with NO Professional worker.
const noPro = await discover([addr(wNone), addr(wFree), addr(wComm)], { timeoutMs: 2500 });
ok(route(noPro, buildPrivate) === null, 'a PRIVATE-repo VIPM build with no Professional worker is unroutable (null)');

wNone.close(); wFree.close(); wComm.close(); wPro.close();
console.log(`verify-vipm-routing: PASS (${pass} assertions) -- VIPM-capability routing (edition-aware, Community-only-in-public-repo)`);

// Helper: the worker in the registry that advertised no vipm.
function wCapsNone(registry) { return registry.find((w) => w.caps.vipm && w.caps.vipm.present === false); }
