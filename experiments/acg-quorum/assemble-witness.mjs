#!/usr/bin/env node
// assemble-witness.mjs -- Actor Corroboration Grid witness-bundle assembler (ADR-0014 / ADR-0015, LBA-REQ-024).
//
// Composes the THREE receipts a single witness produces into the ONE canonical bundle the quorum
// (compare-witnesses.mjs) ingests, FAILING CLOSED when any release-gating anchor is absent so that a witness can
// never silently abstain (an incomplete witness must NOT be able to pad a majority):
//
//   gate-suite-receipt.json   (cleanroom-gate-suite-receipt-v1)   -> gate.verdict + gate.lbabus.{version,sourceCommit}
//   screenshot-receipt-*.json (mprr-viewer-screenshot-receipt@v1) -> screenshot.{seriesHash,pngSha256}
//   capability-receipt.json   (hardware-capability@v1)            -> capability (RECORDED, never gated) + os inference
//
// `os` is inferred from the capability platform ("linux-x64" -> "linux", "win32-*" -> "windows") unless overridden.
// The Ubuntu codename (a LINUX_ONLY anchor) is read from the witness's own /etc/os-release VERSION_CODENAME on
// Linux (CLI), or passed explicitly; a Linux witness missing it fails closed (it could not corroborate the
// LINUX_ONLY tier). Dependency-free (Node builtins only). Output schema: acg-witness-bundle-v1.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const REQUIRED_SCHEMAS = {
  gate: 'cleanroom-gate-suite-receipt-v1',
  screenshot: 'mprr-viewer-screenshot-receipt@v1',
  capability: 'hardware-capability@v1',
};

function req(value, label) {
  if (value == null || value === '') throw new Error(`witness bundle FAILS CLOSED: missing ${label}`);
  return value;
}

// "labview-benchmark-actor/foo@v1" -> "foo@v1" (compare only the receipt-kind tail, not the vendor prefix).
const schemaTail = (schema) => String(schema || '').split('/').pop();

// os inference from a hardware-capability platform token ("linux-x64", "win32-x64", "darwin-arm64").
export function osFromPlatform(platform) {
  const p = String(platform || '');
  if (p.startsWith('linux')) return 'linux';
  if (p.startsWith('win')) return 'windows';
  if (p.startsWith('darwin')) return 'macos';
  return null;
}

// Read VERSION_CODENAME from an /etc/os-release text blob (returns null if absent).
export function ubuntuCodename(osReleaseText) {
  const m = String(osReleaseText || '').match(/^VERSION_CODENAME=(.+)$/m);
  return m ? m[1].trim().replace(/^"|"$/g, '') : null;
}

export function assembleWitness({ plane, gate, screenshot, capability, os, ubuntu } = {}) {
  req(plane, 'plane');
  if (schemaTail(gate?.schema) !== REQUIRED_SCHEMAS.gate) {
    throw new Error(`witness bundle FAILS CLOSED: gate receipt schema is not ${REQUIRED_SCHEMAS.gate}`);
  }
  if (schemaTail(screenshot?.schema) !== REQUIRED_SCHEMAS.screenshot) {
    throw new Error(`witness bundle FAILS CLOSED: screenshot receipt schema is not ${REQUIRED_SCHEMAS.screenshot}`);
  }
  if (capability != null && schemaTail(capability?.schema) !== REQUIRED_SCHEMAS.capability) {
    throw new Error(`witness bundle FAILS CLOSED: capability receipt schema is not ${REQUIRED_SCHEMAS.capability}`);
  }

  const resolvedOs = os ?? osFromPlatform(capability?.platform);
  req(resolvedOs, 'os (pass os, or a capability receipt with a platform)');

  const bundle = {
    schema: 'labview-benchmark-actor/acg-witness-bundle-v1',
    plane,
    os: resolvedOs,
    gate: {
      verdict: req(gate?.verdict, 'gate.verdict'),
      lbabus: {
        version: req(gate?.lbabus?.version, 'gate.lbabus.version'),
        sourceCommit: req(gate?.lbabus?.sourceCommit, 'gate.lbabus.sourceCommit'),
      },
    },
    screenshot: {
      seriesHash: req(screenshot?.seriesHash, 'screenshot.seriesHash'),
      pngSha256: req(screenshot?.pngSha256, 'screenshot.pngSha256'),
    },
    ubuntu: resolvedOs === 'linux' ? (ubuntu ?? null) : null,
    // RECORDED, never gated (the ADR-0015 "witnesses" tier -- hardware capability travels with the bundle as provenance).
    capability: capability
      ? { platform: capability.platform ?? null, cpu: capability.cpu ?? null, memory: capability.memory ?? null, gpus: capability.gpus ?? null }
      : null,
    assembledAt: new Date().toISOString(),
  };
  // A Linux witness MUST carry the Ubuntu codename: without it the witness cannot corroborate the LINUX_ONLY tier
  // (and a null anchor would silently diverge from its Linux peers). Fail closed rather than pad the quorum.
  if (resolvedOs === 'linux') {
    req(bundle.ubuntu, 'ubuntu codename (Linux witness -- pass ubuntu, or run where /etc/os-release has VERSION_CODENAME)');
  }
  return bundle;
}

// CLI: assemble-witness.mjs --plane <P> --gate <f> --screenshot <f> [--capability <f>] [--os <o>] [--ubuntu <c>] [--out <f>]
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) opt[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  }
  if (!opt.plane || !opt.gate || !opt.screenshot) {
    console.error('usage: assemble-witness.mjs --plane <P> --gate <f> --screenshot <f> [--capability <f>] [--os <o>] [--ubuntu <c>] [--out <f>]');
    process.exit(2);
  }
  const gate = JSON.parse(readFileSync(opt.gate, 'utf8'));
  const screenshot = JSON.parse(readFileSync(opt.screenshot, 'utf8'));
  const capability = opt.capability ? JSON.parse(readFileSync(opt.capability, 'utf8')) : null;
  let ubuntu = typeof opt.ubuntu === 'string' ? opt.ubuntu : null;
  if (!ubuntu && existsSync('/etc/os-release')) ubuntu = ubuntuCodename(readFileSync('/etc/os-release', 'utf8'));
  const bundle = assembleWitness({
    plane: opt.plane,
    gate,
    screenshot,
    capability,
    os: typeof opt.os === 'string' ? opt.os : undefined,
    ubuntu,
  });
  const out = JSON.stringify(bundle, null, 2) + '\n';
  if (typeof opt.out === 'string') {
    writeFileSync(opt.out, out);
    console.error(`assemble-witness: wrote ${opt.out} (plane=${bundle.plane} os=${bundle.os})`);
  } else {
    process.stdout.write(out);
  }
}
