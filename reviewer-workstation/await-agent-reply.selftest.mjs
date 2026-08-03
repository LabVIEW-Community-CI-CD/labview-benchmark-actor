#!/usr/bin/env node
// await-agent-reply.selftest.mjs -- pure, dependency-free self-test for the host-side read-back parser
// (LBA-REQ-059, ADR-0039). No network, no lbabus, no VM: it exercises parseLine on rendered `lbabus net listen`
// lines and asserts the DONE/NOTE correlation the host<->VM-agent closed loop depends on. Run:
//   node reviewer-workstation/await-agent-reply.selftest.mjs
import assert from 'node:assert';
import { parseLine } from './await-agent-reply.mjs';

let passed = 0;
const total = 7;
function ok(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); process.exitCode = 1; }
}

// The exact BusWire.Render shape a `net listen` prints: `TCP <remote>  [ts] SENDER #seq TYPE task:<t> — <payload>`.
// These lines are the real ones observed in the live drives (senderId WIN, the em dash U+2014 before the payload).
const DONE = 'TCP 127.0.0.1:57842  [2026-08-03T10:35:52.816Z] WIN #1785753352 DONE task:live-1 \u2014 lbabus ready on VM';
const NOTE = 'TCP 10.0.2.2:34614  [2026-08-03T10:46:05.117Z] WIN #1785753965 NOTE task:ext-release-0.5.0 \u2014 RESOLVED: PASS for ext 0.5.0 by reviewer@vi-tech.nl (signed)';
const ACK = 'TCP 127.0.0.1:5000  [2026-08-03T10:00:00.000Z] HOST #7 ACK task:live-1 ackOf:42 \u2014 received DONE from WIN';
const UDP = 'UDP 10.0.2.2  [2026-08-03T10:00:00.000Z] WIN #3 HELLO task:mesh';

ok('parses a DONE reply with task + payload + sender', () => {
  const f = parseLine(DONE);
  assert(f && f.transport === 'TCP' && f.type === 'DONE' && f.task === 'live-1'
    && f.payload === 'lbabus ready on VM' && f.senderId === 'WIN', JSON.stringify(f));
});
ok('parses a NOTE verdict announcement (semantic status in payload)', () => {
  const f = parseLine(NOTE);
  assert(f.type === 'NOTE' && f.task === 'ext-release-0.5.0' && f.payload.startsWith('RESOLVED: PASS'), JSON.stringify(f));
});
ok('parses an ACK carrying ackOf', () => {
  const f = parseLine(ACK);
  assert(f.type === 'ACK' && f.ackOf === '42' && f.task === 'live-1', JSON.stringify(f));
});
ok('parses a UDP line with no payload (null)', () => {
  const f = parseLine(UDP);
  assert(f.transport === 'UDP' && f.type === 'HELLO' && f.task === 'mesh' && f.payload === null, JSON.stringify(f));
});
ok('a non-frame line is ignored (null)', () => {
  assert(parseLine('[net] listener stopped; received 1 message(s)') === null);
  assert(parseLine('') === null);
});
ok('correlation matches only the expected type AND task (fail-closed)', () => {
  const f = parseLine(DONE); // DONE task:live-1
  const matches = (fr, type, task) => fr.type === type && fr.task === task;
  assert(matches(f, 'DONE', 'live-1'), 'exact match');
  assert(!matches(f, 'NOTE', 'live-1'), 'wrong type must be rejected');
  assert(!matches(f, 'DONE', 'live-2'), 'wrong task must be rejected');
});
ok('a payload containing the em dash keeps the full tail', () => {
  const f = parseLine('TCP 127.0.0.1:1  [t] WIN #1 NOTE task:t \u2014 a \u2014 b');
  assert(f.payload === 'a \u2014 b', `payload was: ${f.payload}`);
});

console.log(`\nawait-agent-reply selftest: ${passed}/${total} checks passed`);
if (passed !== total) process.exit(1);
