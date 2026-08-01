#!/usr/bin/env node
// assemble-witness.selftest.mjs -- dependency-free self-test for the ACG witness-bundle assembler (LBA-REQ-024).
// Proves the assembler maps the three producer receipts into the canonical bundle, FAILS CLOSED on any missing
// release-gating anchor, and -- end to end -- that three assembled witnesses corroborate through the quorum.

import assert from 'node:assert/strict';
import { assembleWitness, osFromPlatform, ubuntuCodename } from './assemble-witness.mjs';
import { compareWitnesses } from './compare-witnesses.mjs';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };
const throws = (name, fn, rx) => ok(name, () => assert.throws(fn, rx));

// Receipt fixtures shaped exactly like the real producers emit.
const gateReceipt = (verdict = 'pass', version = '0.13.0', sourceCommit = 'c0ffee1') => ({
  schema: 'labview-benchmark-actor/cleanroom-gate-suite-receipt-v1',
  verdict,
  lbabus: { path: '/x/lbabus', version, sourceCommit, sourceRole: 'codespace' },
  gatesFailed: verdict === 'pass' ? 0 : 1,
});
const shotReceipt = (seriesHash = 'ser-7ad1c75d', pngSha256 = 'png-26efa11e') => ({
  schema: 'labview-benchmark-actor/mprr-viewer-screenshot-receipt@v1',
  seriesHash,
  pngSha256,
});
const capReceipt = (platform = 'linux-x64') => ({
  schema: 'labview-benchmark-actor/hardware-capability@v1',
  platform,
  cpu: { model: 'Test CPU', logicalCores: 8 },
  memory: { totalGiB: 16 },
  gpus: [],
});

// 1. Full valid Linux (codespace) witness -> every anchor mapped, os=linux, ubuntu carried, capability recorded.
ok('full linux witness maps every anchor', () => {
  const b = assembleWitness({ plane: 'CODESPACE', gate: gateReceipt(), screenshot: shotReceipt(), capability: capReceipt('linux-x64'), ubuntu: 'noble' });
  assert.equal(b.schema, 'labview-benchmark-actor/acg-witness-bundle-v1');
  assert.equal(b.os, 'linux');
  assert.equal(b.ubuntu, 'noble');
  assert.equal(b.gate.verdict, 'pass');
  assert.equal(b.gate.lbabus.version, '0.13.0');
  assert.equal(b.gate.lbabus.sourceCommit, 'c0ffee1');
  assert.equal(b.screenshot.seriesHash, 'ser-7ad1c75d');
  assert.equal(b.screenshot.pngSha256, 'png-26efa11e');
  assert.equal(b.capability.platform, 'linux-x64');
});

// 2. Windows witness -> os=windows, no ubuntu anchor (LINUX_ONLY does not apply downstream).
ok('windows witness has os=windows and null ubuntu', () => {
  const b = assembleWitness({ plane: 'WIN', gate: gateReceipt(), screenshot: shotReceipt('ser-7ad1c75d', 'png-win'), capability: capReceipt('win32-x64') });
  assert.equal(b.os, 'windows');
  assert.equal(b.ubuntu, null);
  assert.equal(b.screenshot.pngSha256, 'png-win');
});

// 3. os is inferred from the capability platform when not overridden.
ok('os inferred from capability platform', () => {
  const b = assembleWitness({ plane: 'VBOX', gate: gateReceipt(), screenshot: shotReceipt(), capability: capReceipt('linux-x64'), ubuntu: 'noble' });
  assert.equal(b.os, 'linux');
  assert.equal(osFromPlatform('win32-x64'), 'windows');
  assert.equal(osFromPlatform('darwin-arm64'), 'macos');
  assert.equal(osFromPlatform('bogus'), null);
});

// 4. A missing gate verdict FAILS CLOSED (a witness cannot abstain on its own gate outcome).
throws('missing gate.verdict fails closed', () => {
  const g = gateReceipt(); delete g.verdict;
  assembleWitness({ plane: 'X', gate: g, screenshot: shotReceipt(), capability: capReceipt(), ubuntu: 'noble' });
}, /FAILS CLOSED: missing gate\.verdict/);

// 5. A missing render anchor FAILS CLOSED.
throws('missing screenshot.seriesHash fails closed', () => {
  const s = shotReceipt(); delete s.seriesHash;
  assembleWitness({ plane: 'X', gate: gateReceipt(), screenshot: s, capability: capReceipt(), ubuntu: 'noble' });
}, /FAILS CLOSED: missing screenshot\.seriesHash/);

// 6. A wrong receipt schema FAILS CLOSED (no assembling from an unexpected producer).
throws('wrong gate schema fails closed', () => {
  assembleWitness({ plane: 'X', gate: { schema: 'something/else@v1', verdict: 'pass', lbabus: { version: '1', sourceCommit: 'c' } }, screenshot: shotReceipt(), capability: capReceipt(), ubuntu: 'noble' });
}, /gate receipt schema is not cleanroom-gate-suite-receipt-v1/);

// 7. A Linux witness missing its Ubuntu codename FAILS CLOSED (it could not corroborate the LINUX_ONLY tier).
throws('linux witness missing ubuntu fails closed', () => {
  assembleWitness({ plane: 'CODESPACE', gate: gateReceipt(), screenshot: shotReceipt(), capability: capReceipt('linux-x64') });
}, /FAILS CLOSED: missing ubuntu codename/);

// os-release codename parsing (the CLI's Linux path).
ok('ubuntuCodename parses /etc/os-release', () => {
  assert.equal(ubuntuCodename('NAME="Ubuntu"\nVERSION_CODENAME=noble\nID=ubuntu\n'), 'noble');
  assert.equal(ubuntuCodename('VERSION_CODENAME="jammy"'), 'jammy');
  assert.equal(ubuntuCodename('NAME="Fedora"\n'), null);
});

// 8. END TO END: assemble three heterogeneous witnesses -> the quorum corroborates the release (pass, confidence 1).
ok('three assembled witnesses corroborate through the quorum', () => {
  const S = 'ser-shared', C = 'commit-shared', V = '0.13.0', P = 'png-linux';
  const codespace = assembleWitness({ plane: 'CODESPACE', gate: gateReceipt('pass', V, C), screenshot: shotReceipt(S, P), capability: capReceipt('linux-x64'), ubuntu: 'noble' });
  const vbox = assembleWitness({ plane: 'VBOX', gate: gateReceipt('pass', V, C), screenshot: shotReceipt(S, P), capability: capReceipt('linux-x64'), ubuntu: 'noble' });
  const win = assembleWitness({ plane: 'WIN', gate: gateReceipt('pass', V, C), screenshot: shotReceipt(S, 'png-windows'), capability: capReceipt('win32-x64') });
  const verdict = compareWitnesses([codespace, vbox, win]);
  assert.equal(verdict.verdict, 'pass');
  assert.equal(verdict.distinctEnvironments, true);
  assert.equal(verdict.majority, true);
  assert.equal(verdict.confidence, 1);
  assert.deepEqual(verdict.divergences, []);
});

console.log(`assemble-witness self-test: ${pass}/${pass} PASS`);
