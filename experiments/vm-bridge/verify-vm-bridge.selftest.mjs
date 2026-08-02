// Self-test for checkVmBridge.mjs -- the human-assisted VM bridge (LBA-REQ-045, ADR-0032). Asserts the
// COMMITTED tools/vm-bridge/vm-bridge.sh implements the agent-drive + human hand-off surface, is SECRET-SAFE
// (no way to ingest a credential), the committed live receipt proves the agent drove the VM and a real
// secret prompt was detected + handed off (not answered), and the checker FAILS CLOSED on secret-unsafe
// mutations. rg-free. Run: node verify-vm-bridge.selftest.mjs.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkVmBridge } from './checkVmBridge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const SCRIPT = join(repoRoot, 'tools/vm-bridge/vm-bridge.sh');
const scriptText = readFileSync(SCRIPT, 'utf8');
const receipt = JSON.parse(readFileSync(join(here, 'fixtures', 'vm-bridge-receipt.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// 1. the committed bridge implements the drive + hand-off surface and is secret-safe, receipt valid
{
  const r = checkVmBridge({ scriptText, receipt });
  assert.ok(r.ok, `expected the committed bridge to pass; findings: ${r.findings.join('; ')}`);
  ok('vm-bridge.sh drives the VM shell (tmux send-keys/capture-pane over ssh), offers human attach + secret? , receipt valid');
}

// 2. the bridge script exists and is executable-shaped (has a shebang)
{
  assert.ok(existsSync(SCRIPT), 'vm-bridge.sh exists');
  assert.match(scriptText.split('\n')[0], /^#!.*(bash|sh)/, 'vm-bridge.sh has a shell shebang');
  ok('committed bridge script present with a shell shebang');
}

// 3. the live receipt proves the agent drove the VM and a real secret prompt was detected + handed off
{
  assert.equal(receipt.agentDroveShell.exit, 0, 'agent drove a command on the VM successfully');
  assert.equal(receipt.secretHandoff.detectedByAgent, true, 'agent detected the credential prompt');
  assert.equal(receipt.secretHandoff.answeredByAgent, false, 'agent did NOT answer the credential prompt');
  assert.match(receipt.secretHandoff.humanAttachCommand, /tmux attach/, 'a human attach hand-off is recorded');
  ok(`live evidence: agent drove ${receipt.vm}; secret prompt detected + handed off (agent exit ${receipt.secretHandoff.agentExitCode}), never answered`);
}

// 4. fail-closed: a secret-UNSAFE bridge, or a receipt showing the agent typed a secret, is rejected
{
  const sshpass = scriptText + '\nsshpass -p "$1" ssh host\n';
  assert.equal(checkVmBridge({ scriptText: sshpass, receipt }).ok, false, 'a bridge using sshpass FAILS');

  const readSecret = scriptText.replace('_ssh() {', 'read -s PW\n_ssh() {');
  assert.equal(checkVmBridge({ scriptText: readSecret, receipt }).ok, false, 'a bridge that reads a secret (read -s) FAILS');

  const agentAnswered = { ...receipt, secretHandoff: { ...receipt.secretHandoff, answeredByAgent: true } };
  const rAns = checkVmBridge({ scriptText, receipt: agentAnswered });
  assert.equal(rAns.ok, false, 'a receipt where the agent answered a credential prompt FAILS');
  assert.ok(rAns.findings.some((f) => /SECRET-UNSAFE/.test(f)), 'names the secret-unsafe violation');

  const noDetect = { ...receipt, secretHandoff: { ...receipt.secretHandoff, detectedByAgent: false } };
  assert.equal(checkVmBridge({ scriptText, receipt: noDetect }).ok, false, 'a receipt with no secret detection FAILS');
  ok('fail-closed: sshpass / read -s / agent-answered-secret / no-detection all rejected');
}

console.log(`\nverify-vm-bridge.selftest: ${passed}/${passed} checks passed`);
