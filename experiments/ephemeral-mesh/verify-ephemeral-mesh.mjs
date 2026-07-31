#!/usr/bin/env node
// verify-ephemeral-mesh.mjs -- OFFLINE self-test for the ephemeral-mesh receipt + its validator.
//
// Dependency-free ESM (Node >= 18). Runs on ANY runner with NO VM: it re-validates the committed receipt
// (the live cattle-cycle evidence) and proves the validator FAILS CLOSED against tampered receipts, so a
// regressed or forged attestation cannot slip through the gate.
//
// Usage: node experiments/ephemeral-mesh/verify-ephemeral-mesh.mjs [--json]
// Exit 0 when every check passes, 1 otherwise.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EPHEMERAL_MESH_SCHEMA, EPHEMERAL_MESH_CONCEPT, validateEphemeralMeshReceipt } from './ephemeralMesh.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.includes('--json');
const checks = [];
function check(name, fn) {
  try { checks.push({ name, pass: true, detail: fn() ?? null }); }
  catch (error) { checks.push({ name, pass: false, error: String(error?.message ?? error) }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function throws(fn, why) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, `expected validation to reject: ${why}`);
}

// A minimal, PASSING receipt used as the base for the fail-closed teeth (independent of receipt.json).
function goodReceipt() {
  return {
    schema: EPHEMERAL_MESH_SCHEMA,
    concept: EPHEMERAL_MESH_CONCEPT,
    test: 'T-EPHEMERAL-MESH-P1',
    ranAt: '2026-07-31T00:00:00.000Z',
    plane: 'LINUX',
    hypervisor: 'virtualbox',
    transport: 'lbabus net -- loopback 127.0.0.1 TCP+UDP',
    lifecycle: {
      goldenVm: 'golden', goldenSnapshot: 'snap', cloneVm: 'clone', cloneType: 'linked',
      bootSeconds: 13, survivesReboot: false, destroyed: true,
    },
    node: { hostname: 'actor', user: 'actor', lbabusVersion: '0.11.0' },
    loopbackMesh: { tcpFramesReceived: 1, udpDistinctSenders: 1, meshOk: true },
    asserts: {
      sshKeyAuthNoPassword: true, lbabusPresent: true, tcpLoopback: true, udpLoopback: true,
      meshOk: true, cloneCreated: true, cloneDestroyed: true, commsOnly: true, noRebootSurvivalNeeded: true,
    },
    pass: true,
  };
}

// 1. The committed receipt is a green, faithful cattle-cycle attestation.
check('committed-receipt-valid', () => {
  const receipt = JSON.parse(readFileSync(join(here, 'receipt.json'), 'utf8'));
  const summary = validateEphemeralMeshReceipt(receipt);
  assert(summary.meshOk === true, 'summary.meshOk must be true');
  assert(summary.destroyed === true, 'summary.destroyed must be true');
  assert(summary.bootSeconds > 0, 'summary.bootSeconds must be > 0');
  return summary;
});

// 2. The base fixture validates (so the teeth below isolate exactly the tampered field).
check('base-fixture-valid', () => {
  validateEphemeralMeshReceipt(goodReceipt());
  return { ok: true };
});

// 3. Fail-closed teeth: each tampered receipt MUST be rejected.
check('fails-closed-on-tampering', () => {
  throws(() => validateEphemeralMeshReceipt({ ...goodReceipt(), schema: 'wrong' }), 'wrong schema');
  throws(() => validateEphemeralMeshReceipt({ ...goodReceipt(), concept: 'nope' }), 'wrong concept');
  throws(() => validateEphemeralMeshReceipt({ ...goodReceipt(), plane: 'MARS' }), 'unknown plane');
  throws(() => validateEphemeralMeshReceipt({ ...goodReceipt(), pass: false }), 'pass=false');
  const notDestroyed = goodReceipt(); notDestroyed.lifecycle = { ...notDestroyed.lifecycle, destroyed: false };
  throws(() => validateEphemeralMeshReceipt(notDestroyed), 'clone not destroyed');
  const survives = goodReceipt(); survives.lifecycle = { ...survives.lifecycle, survivesReboot: true };
  throws(() => validateEphemeralMeshReceipt(survives), 'claims reboot-survival');
  const notLinked = goodReceipt(); notLinked.lifecycle = { ...notLinked.lifecycle, cloneType: 'full' };
  throws(() => validateEphemeralMeshReceipt(notLinked), 'clone not linked');
  const noBoot = goodReceipt(); noBoot.lifecycle = { ...noBoot.lifecycle, bootSeconds: 0 };
  throws(() => validateEphemeralMeshReceipt(noBoot), 'bootSeconds not positive');
  const noTcp = goodReceipt(); noTcp.loopbackMesh = { ...noTcp.loopbackMesh, tcpFramesReceived: 0 };
  throws(() => validateEphemeralMeshReceipt(noTcp), 'no TCP frame');
  const noUdp = goodReceipt(); noUdp.loopbackMesh = { ...noUdp.loopbackMesh, udpDistinctSenders: 0 };
  throws(() => validateEphemeralMeshReceipt(noUdp), 'no UDP sender');
  const meshBad = goodReceipt(); meshBad.loopbackMesh = { ...meshBad.loopbackMesh, meshOk: false };
  throws(() => validateEphemeralMeshReceipt(meshBad), 'meshOk false');
  const commsBad = goodReceipt(); commsBad.asserts = { ...commsBad.asserts, commsOnly: false };
  throws(() => validateEphemeralMeshReceipt(commsBad), 'commsOnly false');
  return { tamperCasesRejected: 12 };
});

// A minimal PASSING typed (source->sink) receipt for the typed teeth (independent of receipt-typed.json).
function goodTypedReceipt() {
  return {
    schema: EPHEMERAL_MESH_SCHEMA,
    concept: EPHEMERAL_MESH_CONCEPT,
    meshMode: 'typed',
    serializationMode: 'serialized',
    test: 'T-EPHEMERAL-MESH-P2-TYPED',
    ranAt: '2026-07-31T00:00:00.000Z',
    plane: 'LINUX',
    hypervisor: 'virtualbox',
    transport: 'lbabus net -- typed source->sink (private intnet)',
    lifecycle: {
      goldenVm: 'golden', goldenSnapshot: 'snap', cloneVms: ['c-src', 'c-snk'], cloneType: 'linked',
      bootSeconds: 15, survivesReboot: false, destroyed: true,
    },
    nodes: [
      { id: 'src', nodeType: 'source', activity: { listened: false, emittedCoordination: true } },
      {
        id: 'snk', nodeType: 'sink', activity: { listened: true, emittedCoordination: false },
        orderedReceipt: {
          ingestSeqDense: true, totalFrames: 3, strictSerialization: true, orderKey: '(sessionId,senderId,seq)',
          frameLog: [
            { sessionId: 'S', senderId: 'SRC', seq: 1, ingestSeq: 1, frameType: 'PAYLOAD' },
            { sessionId: 'S', senderId: 'SRC', seq: 2, ingestSeq: 2, frameType: 'PAYLOAD' },
            { sessionId: 'S', senderId: 'SRC', seq: 2, ingestSeq: 3, frameType: 'DONE' },
          ],
          perStream: [
            { sessionId: 'S', senderId: 'SRC', firstSeq: 1, lastSeq: 2, count: 2, contiguous: true, inIngestOrder: true, terminalDone: true },
          ],
        },
      },
    ],
    asserts: {
      sshKeyAuthNoPassword: true, lbabusPresent: true, nodeTypesHonored: true, strictSerialization: true,
      meshOk: true, cloneCreated: true, cloneDestroyed: true, commsOnly: true, noRebootSurvivalNeeded: true,
    },
    pass: true,
  };
}

// 4. The committed typed receipt (the live P2 source->sink proof) is a green, faithful attestation.
check('committed-typed-receipt-valid', () => {
  const receipt = JSON.parse(readFileSync(join(here, 'receipt-typed.json'), 'utf8'));
  const summary = validateEphemeralMeshReceipt(receipt);
  assert(summary.meshMode === 'typed', 'summary.meshMode must be typed');
  assert(summary.sinks >= 1, 'must have >= 1 sink');
  assert(summary.destroyed === true, 'summary.destroyed must be true');
  return summary;
});

// 5. The typed base fixture validates (isolates the teeth below).
check('typed-base-fixture-valid', () => { validateEphemeralMeshReceipt(goodTypedReceipt()); return { ok: true }; });

// 6. Typed fail-closed teeth: each tampered typed receipt MUST be rejected.
check('typed-fails-closed-on-tampering', () => {
  const mutSink = (fn) => { const c = goodTypedReceipt(); fn(c.nodes.find((n) => n.nodeType === 'sink')); return c; };
  throws(() => validateEphemeralMeshReceipt({ ...goodTypedReceipt(), serializationMode: 'unordered' }), 'bad serializationMode');
  const unknownType = goodTypedReceipt(); unknownType.nodes[0].nodeType = 'relay';
  throws(() => validateEphemeralMeshReceipt(unknownType), 'unknown nodeType');
  const srcListened = goodTypedReceipt(); srcListened.nodes[0].activity = { listened: true, emittedCoordination: true };
  throws(() => validateEphemeralMeshReceipt(srcListened), 'source that listened (type not honored)');
  throws(() => validateEphemeralMeshReceipt(mutSink((s) => { delete s.orderedReceipt; })), 'sink missing orderedReceipt');
  throws(() => validateEphemeralMeshReceipt(mutSink((s) => { s.orderedReceipt.frameLog = s.orderedReceipt.frameLog.filter((f) => f.frameType !== 'DONE'); s.orderedReceipt.totalFrames = 2; })), 'missing terminal DONE');
  throws(() => validateEphemeralMeshReceipt(mutSink((s) => { s.orderedReceipt.frameLog[1].ingestSeq = 5; })), 'ingestSeq hole (not dense)');
  throws(() => validateEphemeralMeshReceipt(mutSink((s) => { s.orderedReceipt.frameLog[1].ingestSeq = 1; })), 'ingestSeq duplicate');
  throws(() => validateEphemeralMeshReceipt(mutSink((s) => { const f = s.orderedReceipt.frameLog; const t = f[0].ingestSeq; f[0].ingestSeq = f[1].ingestSeq; f[1].ingestSeq = t; })), 'payloads out of ingest order');
  throws(() => validateEphemeralMeshReceipt(mutSink((s) => {
    s.orderedReceipt.frameLog = [
      { sessionId: 'S', senderId: 'SRC', seq: 2, ingestSeq: 1, frameType: 'PAYLOAD' },
      { sessionId: 'S', senderId: 'SRC', seq: 2, ingestSeq: 2, frameType: 'DONE' },
    ];
    s.orderedReceipt.totalFrames = 2;
  })), 'seq gap (payloads not contiguous from 1)');
  throws(() => validateEphemeralMeshReceipt(mutSink((s) => { s.orderedReceipt.strictSerialization = false; })), 'orderedReceipt.strictSerialization false');
  const strictBad = goodTypedReceipt(); strictBad.asserts.strictSerialization = false;
  throws(() => validateEphemeralMeshReceipt(strictBad), 'asserts.strictSerialization false');
  return { typedTamperCasesRejected: 11 };
}); 

const passed = checks.filter((c) => c.pass).length;
const ok = passed === checks.length;
if (asJson) {
  console.log(JSON.stringify({ tool: 'verify-ephemeral-mesh', passed, total: checks.length, pass: ok, checks }, null, 2));
} else {
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : ' -- ' + c.error}`);
  console.log(`\n${passed}/${checks.length} checks passed`);
}
process.exit(ok ? 0 : 1);
