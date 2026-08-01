#!/usr/bin/env node
// grid-tools.selftest.mjs -- dependency-free self-test for the ACG MCP orchestration surface (LBA-REQ-029).
// Proves the grid tools dispatch over the JSON-RPC 2.0 MCP contract (initialize / tools/list / tools/call),
// compose the engines, fail closed on bad args, AND that the stdio server answers a real spawned round-trip.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleAcgGridMcpMessage, dispatchGridTool } from './grid-tools.mjs';
import { signBundle, generateEnrolledKeypair } from '../acg-provenance/attest.mjs';
import { recordRelease } from '../acg-transparency/transparency-log.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };

const mkBundle = (plane, o = {}) => ({
  schema: 'labview-benchmark-actor/acg-witness-bundle-v1',
  plane,
  os: o.os ?? 'linux',
  gate: { verdict: 'pass', lbabus: { version: '0.13.0', sourceCommit: 'c0ffee1' } },
  screenshot: { seriesHash: 'ser', pngSha256: o.png ?? 'png-linux' },
  ubuntu: (o.os ?? 'linux') === 'linux' ? 'noble' : null,
});
const grid = [mkBundle('CODESPACE'), mkBundle('VBOX'), mkBundle('WIN', { os: 'windows', png: 'png-win' })];
const call = (name, args) => handleAcgGridMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

// Transparency-log fixtures (ADR-0022): real enrolled-key attestations recorded into one signed Merkle log.
const idOf = (b) => `acg-witness:${b.plane.toLowerCase()}`;
const witnessKp = Object.fromEntries(grid.map((b) => [b.plane, generateEnrolledKeypair()]));
const attestations = grid.map((b) => signBundle(b, { privateKeyPem: witnessKp[b.plane].privateKeyPem, identity: idOf(b) }));
const witnessAllowlist = Object.fromEntries(grid.map((b) => [idOf(b), witnessKp[b.plane].publicKeyPem]));
const logKp = generateEnrolledKeypair();
const txReceipt = recordRelease(attestations, { privateKeyPem: logKp.privateKeyPem, logIdentity: 'acg-log:test', timestamp: '2026-08-01T00:00:00.000Z' });
const provenance = {
  quorumMin: 2,
  logAllowlist: { 'acg-log:test': logKp.publicKeyPem },
  witnessAllowlist,
  signedTreeHead: txReceipt.signedTreeHead,
  witnesses: grid.map((b, i) => ({ witnessIdentity: idOf(b), bundle: b, attestation: attestations[i], inclusion: txReceipt.inclusions[i] })),
};

// 1. initialize
ok('initialize returns the protocol + serverInfo', () => {
  const r = handleAcgGridMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { serverVersion: '9.9.9' });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.equal(r.result.serverInfo.version, '9.9.9');
  assert.deepEqual(r.result.capabilities, { tools: {} });
});

// 2. tools/list publishes the ADR-0020 grid tools.
ok('tools/list publishes the ADR-0020 grid tools', () => {
  const r = handleAcgGridMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = r.result.tools.map((t) => t.name);
  for (const req of ['spin_up_witness', 'run_quorum', 'get_confidence', 'verify_attestation', 'verify_inclusion', 'verify_before_install', 'teardown']) assert.ok(names.includes(req), `missing ${req}`);
});

// 3. run_quorum composes the quorum.
ok('run_quorum corroborates a witness grid', () => {
  const out = JSON.parse(call('run_quorum', { bundles: grid }).result.content[0].text);
  assert.equal(out.verdict, 'pass');
  assert.equal(out.witnesses, 3);
});

// 4. get_confidence returns the graded confidence.
ok('get_confidence returns verdict + confidence', () => {
  const out = JSON.parse(call('get_confidence', { bundles: grid }).result.content[0].text);
  assert.equal(out.verdict, 'pass');
  assert.ok(out.confidence >= 0.5);
});

// 5. spin_up_witness / teardown return deterministic plans (no live execution).
ok('spin_up_witness + teardown return plans', () => {
  const up = JSON.parse(call('spin_up_witness', { plane: 'CODESPACE' }).result.content[0].text);
  assert.equal(up.executed, false);
  assert.match(up.command, /gh codespace create/);
  const down = JSON.parse(call('teardown', { plane: 'VBOX', id: 'clone-01' }).result.content[0].text);
  assert.equal(down.executed, false);
  assert.match(down.command, /VBoxManage unregistervm/);
});

// 5b. verify_inclusion confirms a real attestation is logged; a mismatched proof fails closed.
ok('verify_inclusion confirms a logged attestation + fails closed on a mismatch', () => {
  const good = JSON.parse(call('verify_inclusion', { attestation: attestations[0], inclusion: txReceipt.inclusions[0], signedTreeHead: txReceipt.signedTreeHead, logPublicKeyPem: logKp.publicKeyPem }).result.content[0].text);
  assert.equal(good.included, true);
  const bad = JSON.parse(call('verify_inclusion', { attestation: attestations[1], inclusion: txReceipt.inclusions[0], signedTreeHead: txReceipt.signedTreeHead, logPublicKeyPem: logKp.publicKeyPem }).result.content[0].text);
  assert.equal(bad.included, false);
});

// 5c. verify_before_install admits a fully attested + logged release and blocks a sub-quorum one.
ok('verify_before_install admits a logged release + blocks a sub-quorum one', () => {
  const admit = JSON.parse(call('verify_before_install', { provenance }).result.content[0].text);
  assert.equal(admit.admit, true);
  assert.ok(admit.verified >= 2);
  const tampered = { ...provenance, witnesses: provenance.witnesses.map((w, i) => (i < 2 ? { ...w, inclusion: { ...w.inclusion, leaf: '0'.repeat(64) } } : w)) };
  const block = JSON.parse(call('verify_before_install', { provenance: tampered }).result.content[0].text);
  assert.equal(block.admit, false);
});

// 5d. the transparency tools fail closed on a bad argument shape (-32602).
ok('the transparency tools fail closed on bad arg shapes', () => {
  assert.equal(handleAcgGridMcpMessage({ jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'verify_before_install', arguments: { provenance: 'nope' } } }).error.code, -32602);
  assert.equal(handleAcgGridMcpMessage({ jsonrpc: '2.0', id: 52, method: 'tools/call', params: { name: 'verify_inclusion', arguments: {} } }).error.code, -32602);
});

// 6. an unknown tool fails with -32602.
ok('tools/call an unknown tool fails closed', () => {
  const r = handleAcgGridMcpMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(r.error.code, -32602);
});

// 7. a genuine tool-execution failure rides in the result envelope (isError), not a transport error.
ok('a fail-closed tool rides isError in the envelope', () => {
  const r = call('assemble_witness', { plane: 'X', gate: { schema: 'labview-benchmark-actor/cleanroom-gate-suite-receipt-v1' }, screenshot: { schema: 'labview-benchmark-actor/mprr-viewer-screenshot-receipt@v1' } });
  assert.equal(r.result.isError, true);
});

// 8. notifications get no reply; unknown methods fail.
ok('notifications get no reply; unknown method fails', () => {
  assert.equal(handleAcgGridMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(handleAcgGridMcpMessage({ jsonrpc: '2.0', id: 8, method: 'bogus' }).error.code, -32601);
});

// 9. dispatchGridTool fails closed on an unknown tool.
ok('dispatchGridTool fails closed on an unknown tool', () => {
  assert.throws(() => dispatchGridTool('nope', {}), /unknown tool/);
});

// 10. SPAWN the stdio server + a real JSON-RPC round-trip over stdin/stdout.
function roundTrip(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    const got = [];
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) got.push(JSON.parse(line));
        if (got.length === requests.length) { child.stdin.end(); resolve(got); }
      }
    });
    child.on('error', reject);
    setTimeout(() => { child.kill(); reject(new Error('stdio server timeout')); }, 10000);
    for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
  });
}

const responses = await roundTrip([
  { jsonrpc: '2.0', id: 1, method: 'initialize' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_quorum', arguments: { bundles: grid } } },
]);
const byId = Object.fromEntries(responses.map((r) => [r.id, r]));
assert.equal(byId[1].result.serverInfo.name, 'labview-benchmark-actor/acg-grid');
assert.ok(byId[2].result.tools.length >= 5);
assert.equal(JSON.parse(byId[3].result.content[0].text).verdict, 'pass');
pass += 1;
console.log('  ok  the stdio server answers a real spawned JSON-RPC round-trip');

console.log(`grid-tools self-test: ${pass}/${pass} PASS`);
