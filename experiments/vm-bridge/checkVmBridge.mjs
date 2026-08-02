#!/usr/bin/env node
// VM-bridge capability + secret-safety checker (LBA-REQ-045, ADR-0032). The human-assisted bridge
// (tools/vm-bridge/vm-bridge.sh) lets an automation agent drive the golden VM's interactive shell through a
// shared tmux session while a HUMAN types any password/token directly on the VM -- so credentials never
// transit the agent or the model. This checker asserts the committed bridge (a) implements the shared-tmux
// drive + human hand-off surface, (b) is SECRET-SAFE (has no way to ingest a credential), and (c) has a live
// receipt proving the agent drove the VM and a real secret prompt was detected + handed off, not answered.
// Pure + rg-free so the gate replays offline (CI has no tmux/ssh/VM).

export function checkVmBridge({ scriptText, receipt }) {
  const s = String(scriptText || '');
  const findings = [];

  // --- (a) agent-drive + human hand-off surface ---
  if (!/tmux (new-session|has-session)/.test(s)) findings.push('bridge does not create a tmux session');
  if (!/tmux send-keys/.test(s)) findings.push('bridge cannot type into the VM shell (no tmux send-keys)');
  if (!/tmux capture-pane/.test(s)) findings.push('bridge cannot read the VM shell (no tmux capture-pane)');
  if (!/\bssh\b/.test(s)) findings.push('bridge does not reach the VM over ssh');
  if (!/\battach\b/.test(s)) findings.push('bridge offers no human attach (hand-off) path');
  if (!/secret\?/.test(s)) findings.push('bridge cannot detect a credential prompt (no secret? command)');

  // --- (b) SECRET-SAFE: the bridge must have NO way to ingest a credential ---
  // A password/token must only ever be typed by the human in the attached pane -- never passed to this
  // script, an env var, or a flag. Reject any secret-ingestion affordance.
  if (/read\s+-[a-z]*s/.test(s)) findings.push('SECRET-UNSAFE: script uses `read -s` (silent secret input)');
  if (/--(password|token|passphrase|secret)\b/.test(s)) findings.push('SECRET-UNSAFE: script accepts a --password/--token style flag');
  if (/\b(PASSWORD|TOKEN|PASSPHRASE|VIPM_TOKEN)=/.test(s)) findings.push('SECRET-UNSAFE: script assigns a credential variable');
  if (/sshpass/.test(s)) findings.push('SECRET-UNSAFE: script uses sshpass (feeds a password non-interactively)');

  // --- (c) live receipt ---
  if (receipt) {
    if (receipt.schema !== 'labview-benchmark-actor/vm-bridge-session@1') findings.push('receipt schema mismatch');
    if (receipt.tmuxLocation !== 'vm') findings.push('receipt: bridge is not hosted on the VM');
    if (receipt.agentDroveShell?.exit !== 0) findings.push('receipt: agent did not successfully drive the VM shell');
    if (!receipt.agentDroveShell?.observedOutput) findings.push('receipt: no observed VM output recorded');
    const h = receipt.secretHandoff || {};
    if (h.detectedByAgent !== true) findings.push('receipt: agent did not detect the credential prompt');
    if (h.answeredByAgent !== false) findings.push('SECRET-UNSAFE: receipt shows the agent answered a credential prompt');
    if (h.cancelledWithoutSecret !== true) findings.push('receipt: prompt was not cleared without a secret');
    if (!/tmux attach/.test(h.humanAttachCommand || '')) findings.push('receipt: no human attach command recorded');
    if (receipt.secretSafe !== true) findings.push('receipt does not attest secret-safety');
  }

  return { ok: findings.length === 0, findings };
}
