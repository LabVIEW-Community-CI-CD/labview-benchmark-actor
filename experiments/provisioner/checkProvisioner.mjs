#!/usr/bin/env node
// Provisioner completeness checker (LBA-REQ-044, ADR-0023 Phase 1): the from-scratch Ubuntu golden-VM
// provisioner (cleanroom/ubuntu-labview/provision-guest.sh) must install BOTH LabVIEW 2026 Community (from
// the NI apt repo, signed by the committed keyring) AND VIPM (the JKI .deb) -- the operator's golden VM is
// "Ubuntu + LabVIEW + VIPM". Pure + rg-free so the gate replays offline. `checkProvisioner` also validates
// the committed live-install receipt (VIPM proven installed on the real scratch VM).

export function checkProvisioner({ scriptText, receipt }) {
  const s = String(scriptText || '');
  const findings = [];

  // --- LabVIEW install (NI apt repo + committed keyring) ---
  if (!/ni-labview-2026-community/.test(s)) findings.push('provisioner does not install ni-labview-2026-community (LabVIEW)');
  if (!/download\.ni\.com/.test(s)) findings.push('provisioner does not add the NI apt repo (download.ni.com)');
  if (!/ni-labview-2026-noble-community\.asc/.test(s)) findings.push('provisioner does not use the committed NI keyring');

  // --- VIPM install (JKI .deb, idempotent, deps resolved) ---
  if (!/packages\.jki\.net/.test(s)) findings.push('provisioner does not download VIPM from JKI (packages.jki.net)');
  if (!/dpkg -i .*vipm|dpkg -i .*\.deb/.test(s)) findings.push('provisioner does not dpkg-install the VIPM .deb');
  if (!/dpkg -s vipm/.test(s)) findings.push('VIPM step is not idempotent (no `dpkg -s vipm` guard)');
  if (!/apt-get install -f/.test(s)) findings.push('VIPM step does not resolve dependencies (apt-get install -f)');

  // --- live-install receipt (VIPM proven installed on the real VM) ---
  if (receipt) {
    if (receipt.schema !== 'labview-benchmark-actor/provisioner-install@1') findings.push('receipt schema mismatch');
    if (receipt.labview?.package !== 'ni-labview-2026-community') findings.push('receipt LabVIEW package mismatch');
    if (receipt.vipm?.installed !== true) findings.push('receipt does not confirm VIPM installed');
    if (!receipt.vipm?.version) findings.push('receipt has no VIPM version');
    if (!/packages\.jki\.net/.test(receipt.vipm?.source || '')) findings.push('receipt VIPM source is not the JKI url');
  }

  return { ok: findings.length === 0, findings };
}
