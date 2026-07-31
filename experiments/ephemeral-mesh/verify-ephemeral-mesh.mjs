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

const passed = checks.filter((c) => c.pass).length;
const ok = passed === checks.length;
if (asJson) {
  console.log(JSON.stringify({ tool: 'verify-ephemeral-mesh', passed, total: checks.length, pass: ok, checks }, null, 2));
} else {
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : ' -- ' + c.error}`);
  console.log(`\n${passed}/${checks.length} checks passed`);
}
process.exit(ok ? 0 : 1);
