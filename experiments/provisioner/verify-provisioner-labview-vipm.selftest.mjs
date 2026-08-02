// Self-test for checkProvisioner.mjs -- the from-scratch Ubuntu golden-VM provisioner installs LabVIEW +
// VIPM (LBA-REQ-044, ADR-0023 Phase 1). Asserts the COMMITTED provision-guest.sh installs both, the
// committed NI keyring exists, the live VIPM-install receipt is valid, and the checker FAILS CLOSED when the
// LabVIEW or VIPM step is missing. rg-free. Run: node verify-provisioner-labview-vipm.selftest.mjs.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkProvisioner } from './checkProvisioner.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const SCRIPT = join(repoRoot, 'cleanroom/ubuntu-labview/provision-guest.sh');
const KEYRING = join(repoRoot, 'cleanroom/ubuntu-labview/ni-labview-2026-noble-community.asc');
const scriptText = readFileSync(SCRIPT, 'utf8');
const receipt = JSON.parse(readFileSync(join(here, 'fixtures', 'provisioner-vipm-receipt.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// 1. the committed provisioner installs BOTH LabVIEW and VIPM, and the live receipt is valid
{
  const r = checkProvisioner({ scriptText, receipt });
  assert.ok(r.ok, `expected the provisioner to install LabVIEW + VIPM; findings: ${r.findings.join('; ')}`);
  ok(`provision-guest.sh installs LabVIEW (ni-labview-2026-community) + VIPM (${receipt.vipm.version}), receipt valid`);
}

// 2. the committed NI keyring the provisioner relies on exists on disk
{
  assert.ok(existsSync(KEYRING), 'the committed NI keyring (ni-labview-2026-noble-community.asc) exists');
  ok('committed NI keyring present');
}

// 3. the live receipt proves VIPM was installed on the real VM from the JKI source
{
  assert.equal(receipt.vipm.installed, true, 'VIPM installed on the VM');
  assert.match(receipt.vipm.source, /packages\.jki\.net/, 'VIPM came from the JKI package server');
  assert.ok(receipt.vipm.version && /\d+\.\d+/.test(receipt.vipm.version), 'a concrete VIPM version is recorded');
  assert.equal(receipt.labview.activated, true, 'LabVIEW is activated on the VM');
  ok(`live evidence: VIPM ${receipt.vipm.version} installed on ${receipt.vm} from JKI`);
}

// 4. fail-closed: a provisioner missing the VIPM step (or the LabVIEW step) is rejected
{
  const noVipm = scriptText.replace(/packages\.jki\.net/g, 'example.invalid').replace(/dpkg -s vipm/g, 'true');
  assert.equal(checkProvisioner({ scriptText: noVipm, receipt }).ok, false, 'a provisioner without the VIPM step FAILS');

  const noLabview = scriptText.replace(/ni-labview-2026-community/g, 'nothing');
  const rNoLv = checkProvisioner({ scriptText: noLabview, receipt });
  assert.equal(rNoLv.ok, false, 'a provisioner without the LabVIEW package FAILS');
  assert.ok(rNoLv.findings.some((f) => /LabVIEW/.test(f)), 'names the missing LabVIEW install');

  const noReceipt = checkProvisioner({ scriptText, receipt: { ...receipt, vipm: { ...receipt.vipm, installed: false } } });
  assert.equal(noReceipt.ok, false, 'a receipt not confirming VIPM install FAILS');
  ok('fail-closed: missing VIPM / missing LabVIEW / unconfirmed receipt all rejected');
}

console.log(`\nverify-provisioner-labview-vipm.selftest: ${passed}/${passed} checks passed`);
