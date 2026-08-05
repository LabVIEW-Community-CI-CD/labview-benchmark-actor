#!/usr/bin/env node
// produce-witness.mjs -- produce a GENUINE Actor Corroboration Grid witness bundle from the CURRENT plane
// (the OS the extension runs in). Reused across planes (ubuntu-latest, windows-latest, a Codespace, a VM): the
// deterministic corroboration anchors -- the extension version, the source commit, the gate verdict, and the
// viewer seriesHash (projected from the committed mprr fixture by the SHIPPED viewer code) -- are computed here,
// so a WINDOWS plane and a LINUX plane produce witnesses that CROSS-PLANE corroborate (ADR-0068: independence is
// the OS-plane) over the SAME reproducible artifact (ADR-0067). The pixel render (pngSha256) is a Linux-only
// anchor and is OPTIONAL -- a witness that did not render simply does not claim it. Dependency-free beyond the
// committed mprr projection (the shipped viewer's own series code).

import { readFileSync } from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ingestShortPackets } from '../mprr-ring/mprrRing.mjs';
import { projectViewerSeries, seriesHash } from '../mprr-ring/mprrViewerSeries.mjs';
import { assembleWitness } from './assemble-witness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

// The OS-independent viewer seriesHash: the shipped viewer's projection of the committed mprr fixture. Data, not
// pixels -- deterministic + identical on every plane, so it is the cross-plane corroboration anchor.
export function deterministicSeriesHash() {
  const fx = JSON.parse(readFileSync(join(repo, 'experiments', 'mprr-ring', 'fixtures', 'short-packet-run.json'), 'utf8'));
  const ingest = ingestShortPackets(fx.packets, { blockDurationTicks: fx.blockDurationTicks, capacityBytes: fx.capacityBytes });
  return seriesHash(projectViewerSeries(ingest, { metric: 'cumulativeBytes' }));
}

export function currentCapability() {
  const cpus = os.cpus() || [];
  return {
    schema: 'labview-benchmark-actor/hardware-capability@v1',
    platform: `${process.platform}-${process.arch}`,
    cpu: { model: cpus[0]?.model ?? 'unknown', logicalCores: cpus.length, speedMHzMax: Math.max(0, ...cpus.map((c) => c.speed || 0)) },
    memory: { totalGiB: +(os.totalmem() / 2 ** 30).toFixed(1), freeGiB: +(os.freemem() / 2 ** 30).toFixed(1) },
    gpus: [],
  };
}

function ubuntuCodename() {
  try {
    const m = readFileSync('/etc/os-release', 'utf8').match(/^VERSION_CODENAME=(.+)$/m);
    return m ? m[1].trim().replace(/^"|"$/g, '') : null;
  } catch { return null; }
}

function gitCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim(); } catch { return null; }
}

// Build a genuine witness bundle for the current plane. verdict comes from the plane's own gate run (pass/fail);
// version + sourceCommit identify the artifact; seriesHash is computed; pngSha256 optional (Linux render only).
export function produceWitness({ plane, verdict = 'pass', version, sourceCommit, pngSha256 = null } = {}) {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const gate = {
    schema: 'labview-benchmark-actor/cleanroom-gate-suite-receipt-v1',
    verdict,
    lbabus: { version: version ?? pkg.version, sourceCommit: sourceCommit ?? process.env.GITHUB_SHA ?? gitCommit() },
  };
  const screenshot = {
    schema: 'labview-benchmark-actor/mprr-viewer-screenshot-receipt@v1',
    seriesHash: deterministicSeriesHash(),
    pngSha256: pngSha256 ?? null,
  };
  const capability = currentCapability();
  const ubuntu = process.platform === 'linux' ? ubuntuCodename() : null;
  return assembleWitness({ plane, gate, screenshot, capability, ubuntu });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const plane = flag('--plane', process.platform === 'win32' ? 'ACTIONS-WINDOWS' : 'ACTIONS-UBUNTU');
  const bundle = produceWitness({
    plane,
    verdict: flag('--verdict', 'pass'),
    version: flag('--version'),
    sourceCommit: flag('--commit'),
    pngSha256: flag('--png'),
  });
  process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
}
