// resource-cross-plane.mjs — the WIN cross-plane RESOURCE compare for a visual-ring workload (e.g. a LabVIEW IDE
// launch). Given two REAL resource-correlated-launch@1 records (WIN + LINUX) — each a launch benchmarked through
// the visual ring WHILE the guest CPU/RAM/disk were sampled and split pre(launching)/post(settled) on the shared
// epoch-ms axis — put their launch RESOURCE COST side by side: pre/post means + the pre->post delta per metric,
// per plane, and the cross-plane agreement (|WIN delta - LINUX delta|). This is to the resource-correlated
// launch what workloadCrossPlaneReceipt is to the single-run launchMs: the resource cost is a WITNESS — a cross-
// HYPERVISOR launch cost carries real substrate + measurement bias, so it is measured + reported, never gated.
// A metric AGREES when the two planes' pre->post deltas are within tolerance (a shared substrate-independent
// signal, e.g. both hypervisors load ~+115 MB resident for a LabVIEW launch); otherwise it DIVERGES (reported).
//
//   import { crossPlaneResourceCompare } from './resource-cross-plane.mjs'
//   node experiments/mprr-capture-ring/resource-cross-plane.mjs <winRc.json> <linuxRc.json> [--out receipt.json]

import { readFileSync, writeFileSync } from 'node:fs';

export const RESOURCE_CROSS_PLANE_SCHEMA = 'labview-benchmark-actor/resource-cross-plane-receipt@1';

const METRICS = ['cpu', 'ram', 'disk'];
// default agreement tolerance per metric (deltaMean units): cpu %, ram MB, disk %.
const DEFAULT_TOLERANCE = { cpu: 8, ram: 50, disk: 8 };
const round2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

/**
 * Build the cross-plane resource-compare receipt from two resource-correlated-launch@1 records.
 * @param {object} winRc   the WIN plane's resource-correlated launch (candidate)
 * @param {object} linuxRc the LINUX plane's resource-correlated launch (baseline)
 * @param {{tolerance?:Record<string,number>}} [opts]
 * @returns {object} a resource-cross-plane-receipt@1 record (all metrics witnessed, never gated).
 */
export function crossPlaneResourceCompare(winRc, linuxRc, opts = {}) {
  for (const [name, r] of [['winRc', winRc], ['linuxRc', linuxRc]]) {
    if (!r || r.schema !== 'labview-benchmark-actor/resource-correlated-launch@1' || !r.headline) {
      throw new Error(`crossPlaneResourceCompare: ${name} must be a resource-correlated-launch@1 record`);
    }
  }
  const tolerance = { ...DEFAULT_TOLERANCE, ...(opts.tolerance ?? {}) };
  const metrics = {};
  for (const m of METRICS) {
    const winDelta = winRc.headline[`${m}DeltaMean`] ?? null;
    const linuxDelta = linuxRc.headline[`${m}DeltaMean`] ?? null;
    const agreementDelta = (Number.isFinite(winDelta) && Number.isFinite(linuxDelta)) ? round2(Math.abs(winDelta - linuxDelta)) : null;
    metrics[m] = {
      win: { preMean: winRc.headline[`${m}PreMean`] ?? null, postMean: winRc.headline[`${m}PostMean`] ?? null, deltaMean: winDelta },
      linux: { preMean: linuxRc.headline[`${m}PreMean`] ?? null, postMean: linuxRc.headline[`${m}PostMean`] ?? null, deltaMean: linuxDelta },
      agreementDelta,
      toleranceDelta: tolerance[m],
      status: agreementDelta == null ? 'incomparable' : (agreementDelta <= tolerance[m] ? 'agree' : 'diverge'),
      witness: true, // cross-hypervisor resource cost is reported, never gated
    };
  }
  const one = (r) => ({ plane: r.plane ?? null, hypervisor: r.hypervisor ?? null, launchMs: r.launchMs ?? null, trigger: r.trigger ?? null });
  return {
    schema: RESOURCE_CROSS_PLANE_SCHEMA,
    workload: winRc.workload ?? linuxRc.workload ?? 'unknown',
    win: one(winRc),
    linux: one(linuxRc),
    launchDeltaMs: (Number.isFinite(winRc.launchMs) && Number.isFinite(linuxRc.launchMs)) ? winRc.launchMs - linuxRc.launchMs : null,
    metrics,
    verdict: 'PASS', // witness-only: the resource cost is reported cross-plane, the compare never fails the gate
    rerun: 'node experiments/mprr-capture-ring/resource-cross-plane.mjs',
  };
}

if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/').split('/').pop() ?? '')) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const [winPath, linuxPath] = args.filter((a, i) => !a.startsWith('--') && i !== outIdx + 1);
  if (!winPath || !linuxPath) { console.error('usage: resource-cross-plane.mjs <winRc.json> <linuxRc.json> [--out receipt.json]'); process.exit(2); }
  const receipt = crossPlaneResourceCompare(JSON.parse(readFileSync(winPath, 'utf8')), JSON.parse(readFileSync(linuxPath, 'utf8')));
  console.log(`resource cross-plane (${receipt.workload}): ${receipt.verdict}   launchΔ ${receipt.launchDeltaMs}ms (WIN-LINUX)`);
  for (const m of METRICS) {
    const x = receipt.metrics[m];
    console.log(`  ${m.toUpperCase().padEnd(4)} Δ  WIN ${x.win.deltaMean}  vs  LINUX ${x.linux.deltaMean}   |Δ| ${x.agreementDelta} (tol ${x.toleranceDelta}) -> ${x.status}`);
  }
  if (outPath) { writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`); console.log(`receipt -> ${outPath}`); }
}
