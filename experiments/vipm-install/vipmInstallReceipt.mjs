#!/usr/bin/env node
// vipm-package-install@1 builder + validator (LBA-REQ-046, realizes ADR-0023 Phase 1). Proves VIPM
// FUNCTIONALLY installs a LabVIEW community package -- the package referenced by the public
// ni/labview-icon-editor developer VIPC (icon-editor-developer.vipc -> astemes_lib_lunit / "LUnit") -- into
// the LabVIEW package library (vi.lib) on the from-scratch golden VM. Distinct from LBA-REQ-044 (which
// proves the provisioner INSTALLS the VIPM tool); this proves VIPM then WORKS to install a package.
//
// The proof is EVIDENCE-BASED and machine-verifiable offline: for each package VIPM reported
// "installed / No Errors", the VIPM package database holds a files-installed manifest (>=1 real file) and
// the package's VIs land under vi.lib. An unactivated / broken VIPM cannot produce installed manifests +
// vi.lib files.
//
// Deterministic: the digest covers only the verdict-bearing install facts (schema, referenced package,
// per-package name/version/action/status/filesInstalled, vi.lib file count, verdict), NOT volatile capture
// facts, so a committed receipt replays offline byte-stably in CI (which has no VIPM / LabVIEW / ripgrep).

import { createHash } from 'node:crypto';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/vipm-package-install@1';

// A package is INSTALLED iff VIPM reported it installed with no errors AND it left a non-empty
// files-installed manifest (real files on disk), with a concrete name + version.
export function packageInstalled(pkg) {
  return !!pkg && pkg.action === 'installed' && pkg.status === 'No Errors' &&
    Number.isInteger(pkg.filesInstalled) && pkg.filesInstalled > 0 &&
    typeof pkg.name === 'string' && pkg.name.length > 0 &&
    typeof pkg.version === 'string' && /\d+\.\d+/.test(pkg.version);
}

// The verdict rule: the VIPM install is PROVEN iff at least one package was recorded, EVERY recorded
// package installed cleanly, and the package library (vi.lib) actually gained files.
export function decideInstalled({ packages, viLibFileCount }) {
  const pkgs = Array.isArray(packages) ? packages : [];
  return pkgs.length >= 1 && pkgs.every(packageInstalled) &&
    Number.isInteger(viLibFileCount) && viLibFileCount > 0;
}

// Canonical, deterministic verdict-bearing view (the digest input).
function canonical(receipt) {
  const pkgs = (receipt.packages || []).map((p) => ({
    name: p.name, version: p.version, action: p.action, status: p.status, filesInstalled: p.filesInstalled,
  }));
  return JSON.stringify({
    schema: receipt.schema,
    referencedPackage: receipt.source?.referencedPackage ?? null,
    packages: pkgs,
    viLibFileCount: receipt.viLib?.fileCount ?? null,
    verdict: { installed: receipt.verdict?.installed },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build a vipm-package-install@1 receipt from captured VM evidence (deterministic + digest-sealed).
export function buildVipmInstallReceipt(capture) {
  const packages = (capture.packages || []).map((p) => ({
    name: p.name,
    version: p.version,
    vip: p.vip || `${p.name}-${p.version}.vip`,
    action: p.action,
    status: p.status,
    filesInstalled: p.filesInstalled,
  }));
  const viLibFileCount = capture.viLib?.fileCount ?? 0;
  const installed = decideInstalled({ packages, viLibFileCount });
  const receipt = {
    schema: RECEIPT_SCHEMA,
    vm: capture.vm ?? null,
    os: capture.os ?? 'Ubuntu 24.04 (Noble)',
    labview: capture.labview ?? null,
    vipm: capture.vipm ?? null,
    source: capture.source ?? null,
    packages,
    viLib: capture.viLib ?? null,
    note: capture.note ?? null,
    verdict: {
      installed,
      reason: installed
        ? `VIPM ${capture.vipm?.version} installed ${packages.map((p) => `${p.name} ${p.version}`).join(' + ')} (No Errors) -> ${viLibFileCount} files under ${capture.viLib?.path}`
        : 'VIPM did not cleanly install every referenced package with files landing in vi.lib',
    },
  };
  receipt.digest = digestReceipt(receipt);
  return receipt;
}

// Validate a committed receipt: schema, per-package install evidence, vi.lib growth, referenced-package
// linkage, verdict rule, and digest integrity. Pure + offline (no VIPM / LabVIEW / ripgrep).
export function validateVipmInstallReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  const packages = Array.isArray(receipt?.packages) ? receipt.packages : [];
  if (packages.length < 1) findings.push('no packages recorded');
  for (const p of packages) {
    if (!packageInstalled(p)) findings.push(`package ${p?.name || '?'} not cleanly installed (action=${p?.action}, status=${p?.status}, files=${p?.filesInstalled})`);
    const expectVip = `${p?.name}-${p?.version}.vip`;
    if (p?.vip && p.vip !== expectVip) findings.push(`package ${p?.name} vip filename ${p.vip} != ${expectVip}`);
  }
  const viCount = receipt?.viLib?.fileCount;
  if (!Number.isInteger(viCount) || viCount <= 0) findings.push('vi.lib gained no files (fileCount<=0)');
  const ref = receipt?.source?.referencedPackage;
  if (ref && !packages.some((p) => ref === p.name || p.name?.startsWith(ref))) {
    findings.push(`referenced package ${ref} not among installed packages`);
  }
  const expected = decideInstalled({ packages, viLibFileCount: viCount });
  if (receipt?.verdict?.installed !== expected) findings.push(`verdict.installed=${receipt?.verdict?.installed} contradicts the rule (${expected})`);
  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, installed: !!receipt?.verdict?.installed && findings.length === 0, findings };
}
