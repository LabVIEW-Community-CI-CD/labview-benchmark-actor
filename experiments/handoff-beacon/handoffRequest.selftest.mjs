#!/usr/bin/env node
// handoffRequest.selftest.mjs -- deterministic self-test for the Handoff Beacon agent<->human request payloads
// (LBA-REQ-056, ADR-0036). No VM: synthetic requests + answers.
// Run: node experiments/handoff-beacon/handoffRequest.selftest.mjs

import assert from 'node:assert/strict';
import {
  AGENT_REQUEST_SCHEMA,
  OP_DONE_SCHEMA,
  buildAgentRequest,
  buildOpDone,
  validateAgentRequest,
  validateOpDone,
  selectPendingRequest,
} from './handoffRequest.mjs';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };

ok('buildAgentRequest is an agent-request beacon with defaults', () => {
  const r = buildAgentRequest({ id: 'req-1', title: 'Run the streaming VI, then Stop the capture', createdAt: '2026-08-03T00:00:00Z' });
  assert.equal(r.schema, AGENT_REQUEST_SCHEMA);
  assert.equal(r.id, 'req-1');
  assert.equal(r.kind, 'step');            // default kind
  assert.equal(r.body, '');                // default body
  assert.equal(buildAgentRequest({ id: 'x', title: 't', kind: 'ack' }).kind, 'ack');
  assert.equal(buildAgentRequest({ id: 'x', title: 't', kind: 'bogus' }).kind, 'step'); // unknown kind -> step
});

ok('buildOpDone answers a request, note optional, id defaults to requestId', () => {
  const d = buildOpDone({ requestId: 'req-1', outcome: 'done', note: 'ran VI #3', doneAt: '2026-08-03T00:01:00Z' });
  assert.equal(d.schema, OP_DONE_SCHEMA);
  assert.equal(d.requestId, 'req-1');
  assert.equal(d.id, 'req-1');             // id defaults to requestId
  assert.equal(d.outcome, 'done');
  assert.equal(d.note, 'ran VI #3');
  assert.equal(buildOpDone({ requestId: 'r' }).outcome, 'done');       // default outcome
  assert.equal(buildOpDone({ requestId: 'r', outcome: 'skipped' }).outcome, 'skipped');
  assert.equal(buildOpDone({ requestId: 'r', outcome: 'nope' }).outcome, 'done'); // unknown outcome -> done
  assert.equal(buildOpDone({ requestId: 'r', note: '' }).note, null); // empty note -> null
});

ok('validateAgentRequest admits a good ask + fails closed', () => {
  assert.equal(validateAgentRequest(buildAgentRequest({ id: 'a', title: 't' })).ok, true);
  assert.equal(validateAgentRequest({ schema: 'nope', id: 'a', title: 't' }).ok, false);
  assert.equal(validateAgentRequest({ schema: AGENT_REQUEST_SCHEMA, id: '', title: 't' }).ok, false); // empty id
  assert.equal(validateAgentRequest({ schema: AGENT_REQUEST_SCHEMA, id: 'a', title: '' }).ok, false); // empty title
  assert.equal(validateAgentRequest({ schema: AGENT_REQUEST_SCHEMA, id: 'a', title: 't', kind: 'bad' }).ok, false);
  assert.equal(validateAgentRequest(null).ok, false);
});

ok('validateOpDone admits a good answer + fails closed', () => {
  assert.equal(validateOpDone(buildOpDone({ requestId: 'a', outcome: 'done' })).ok, true);
  assert.equal(validateOpDone(buildOpDone({ requestId: 'a', outcome: 'skipped' })).ok, true);
  assert.equal(validateOpDone({ schema: 'nope', requestId: 'a', outcome: 'done' }).ok, false);
  assert.equal(validateOpDone({ schema: OP_DONE_SCHEMA, requestId: '', outcome: 'done' }).ok, false);   // no requestId
  assert.equal(validateOpDone({ schema: OP_DONE_SCHEMA, requestId: 'a', outcome: 'bogus' }).ok, false); // bad outcome
  assert.equal(validateOpDone(null).ok, false);
});

ok('selectPendingRequest picks the newest unanswered request', () => {
  const reqs = [
    buildAgentRequest({ id: 'r1', title: 'older', createdAt: '2026-08-03T00:00:00Z' }),
    buildAgentRequest({ id: 'r2', title: 'newer', createdAt: '2026-08-03T00:05:00Z' }),
    buildAgentRequest({ id: 'r3', title: 'newest', createdAt: '2026-08-03T00:09:00Z' }),
    { schema: 'nope', id: 'bad', title: 'invalid' }, // must be ignored (fails validation)
  ];
  assert.equal(selectPendingRequest(reqs, []).id, 'r3');            // newest wins
  assert.equal(selectPendingRequest(reqs, ['r3']).id, 'r2');        // r3 answered -> r2
  assert.equal(selectPendingRequest(reqs, ['r2', 'r3']).id, 'r1');  // r2+r3 answered -> r1
  assert.equal(selectPendingRequest(reqs, ['r1', 'r2', 'r3']), null); // all answered -> none pending
  assert.equal(selectPendingRequest([], []), null);
  assert.equal(selectPendingRequest('nope', 'nope'), null);        // non-arrays tolerated
});

console.log(`handoff-request self-test: ${pass}/${pass} PASS`);
