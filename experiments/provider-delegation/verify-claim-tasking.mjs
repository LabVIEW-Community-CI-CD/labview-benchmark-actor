#!/usr/bin/env node
// Deterministic self-test for bus-side CLAIM tasking (loopback, MOCK provider -- no GPU / no network):
// a coordinator dispatches a CLAIM to a worker; the worker CLAIMS it (ACK), runs the delegation, and returns
// a DONE receipt. Proves the dispatch -> claim -> return loop end-to-end over the real bus-msg@1 / ADR-0003
// framing, plus the negative (an unmeetable task is claimed but returns verdict=fail). Exit 0 = proven.

import assert from 'node:assert';
import { startWorker } from './worker.mjs';
import { dispatchClaim } from './coordinator.mjs';
import { TASK_SCHEMA, RECEIPT_SCHEMA } from './delegateUplift.mjs';

let pass = 0;
const ok = (c, m) => { assert(c, m); pass += 1; };

const worker = await startWorker({ port: 0, host: '127.0.0.1', provider: 'mock', actorId: 'test-worker' });
const workerPort = worker.address().port;

// 1) happy path: coordinator dispatches a good doc-draft; worker claims (ACK) + returns verdict=pass
const goodTask = {
  schema: TASK_SCHEMA, domain: 'doc-draft', id: 'T-CLAIM-1',
  brief: 'Draft a short note.', requiredSections: ['Overview', 'Evidence'], minChars: 120,
};
const ev1 = await dispatchClaim({ worker: `127.0.0.1:${workerPort}`, taskSpec: goodTask, replyHost: '127.0.0.1', observePort: 0, timeoutMs: 15000 });
ok(ev1.ack && JSON.parse(ev1.ack.payload).claimed === true, 'the worker ACKs the CLAIM (claimed the task)');
ok(ev1.ack.ackOf === 0, 'the ACK references the CLAIM sequence (ackOf)');
ok(ev1.ack.type === 'ACK' && ev1.ack.task === 'uplift:doc-draft', 'the ACK is a bus-msg@1 ACK for the dispatched domain');
ok(ev1.done && ev1.done.schema === RECEIPT_SCHEMA, 'the worker returns a DONE receipt (lba-uplift-delegation-receipt@v1)');
ok(ev1.done.task.id === 'T-CLAIM-1' && ev1.done.task.domain === 'doc-draft', 'the DONE receipt is for the dispatched task');
ok(ev1.done.verdict === 'pass', 'a well-formed dispatched task returns verdict=pass');

// 2) negative: an unmeetable task is claimed but returns verdict=fail (the acceptance gate still gates over the bus)
const hardTask = { ...goodTask, id: 'T-CLAIM-2', minChars: 100000 };
const ev2 = await dispatchClaim({ worker: `127.0.0.1:${workerPort}`, taskSpec: hardTask, replyHost: '127.0.0.1', observePort: 0, timeoutMs: 15000 });
ok(ev2.ack && ev2.done && ev2.done.verdict === 'fail', 'an unmeetable dispatched task is claimed but returns verdict=fail');

worker.close();
console.log(`verify-claim-tasking: PASS (${pass} assertions) -- CLAIM dispatch + worker ACK + DONE return proven over bus-msg@1 (mock provider)`);
