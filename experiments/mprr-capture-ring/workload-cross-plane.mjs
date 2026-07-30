// workload-cross-plane.mjs — the WIN cross-plane RECEIPT for a visual-ring WORKLOAD benchmark (e.g. a LabVIEW
// IDE launch). Given two SEALED workload-benchmark records (WIN + LINUX) — each a boot-benchmark-v1 record with
// a guest-clock launch span (LINUX shapes it that way: workloadMs/launchMs span + settle pins) — diff them with
// bootBenchmarkDiff (+ the #173 per-span/witness tolerance) and wrap the result in a committable receipt. This
// is to the LabVIEW-launch benchmark what the bootbench cross-plane receipt is to the container boot-benchmark:
// a re-runnable cross-plane comparison. The launch span is a WITNESS by default — a cross-HYPERVISOR launch time
// carries real substrate bias (VMware VM vs VBox VM), so it is measured + reported, not hard-gated.
//
//   import { workloadCrossPlaneReceipt } from './workload-cross-plane.mjs'
//   node experiments/mprr-capture-ring/workload-cross-plane.mjs <winRecord.json> <linuxRecord.json> [--out receipt.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { bootBenchmarkDiff } from '../mprr-boot-benchmark/boot-benchmark-diff.mjs';

const LAUNCH_SPAN_IDS = ['launchMs', 'workloadMs'];

/**
 * Build the cross-plane workload receipt from two sealed workload records (boot-benchmark-v1 shape).
 * @param {object} winRecord   the WIN plane's workload record (candidate)
 * @param {object} linuxRecord the LINUX plane's workload record (baseline)
 * @param {{toleranceMs?:number|Record<string,number>, witnessSpans?:string[], launchSpanId?:string}} [opts]
 */
export function workloadCrossPlaneReceipt(winRecord, linuxRecord, opts = {}) {
  const launchSpanId = opts.launchSpanId
    ?? LAUNCH_SPAN_IDS.find((id) => (linuxRecord.spans ?? []).some((s) => s.id === id) || (winRecord.spans ?? []).some((s) => s.id === id))
    ?? 'launchMs';
  // The launch span is a WITNESS (cross-hypervisor substrate bias); any other guest span keeps its tight default.
  const witnessSpans = opts.witnessSpans ?? [launchSpanId];
  const timingToleranceMs = opts.toleranceMs ?? { default: 2000, [launchSpanId]: 8000 };
  const diff = bootBenchmarkDiff(linuxRecord, winRecord, { timingToleranceMs, witnessSpans });
  const launch = diff.timing.spans.find((s) => s.id === launchSpanId) ?? null;
  const one = (r) => ({ plane: r.plane ?? null, hypervisor: r.hypervisor ?? null, iteration: r.iteration ?? null });
  return {
    schema: 'labview-benchmark-actor/workload-cross-plane-receipt@1',
    workload: winRecord.workload ?? linuxRecord.workload ?? 'unknown',
    launchSpanId,
    win: { ...one(winRecord), launchMs: launch?.msB ?? null },
    linux: { ...one(linuxRecord), launchMs: launch?.msA ?? null },
    launch, // { id, msA(LINUX), msB(WIN), deltaMs, toleranceMs, witness, status }
    verdict: diff.verdict, // PASS unless a GATED span regresses; the launch witness never fails the gate
    timing: { verdict: diff.timing.verdict, witnessDeltas: diff.timing.witnessDeltas, regressed: diff.timing.regressed },
    rerun: 'node experiments/mprr-capture-ring/workload-cross-plane.mjs',
  };
}

if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/').split('/').pop() ?? '')) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const [winPath, linuxPath] = args.filter((a, i) => !a.startsWith('--') && i !== outIdx + 1);
  if (!winPath || !linuxPath) { console.error('usage: workload-cross-plane.mjs <winRecord.json> <linuxRecord.json> [--out receipt.json]'); process.exit(2); }
  const receipt = workloadCrossPlaneReceipt(JSON.parse(readFileSync(winPath, 'utf8')), JSON.parse(readFileSync(linuxPath, 'utf8')));
  const l = receipt.launch;
  console.log(`workload cross-plane (${receipt.workload}): ${receipt.verdict}`);
  if (l) console.log(`  ${receipt.launchSpanId}: LINUX ${l.msA} -> WIN ${l.msB}  Δ${l.deltaMs}ms  tol ${l.toleranceMs}  ${l.status}`);
  if (outPath) { writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`); console.log(`receipt -> ${outPath}`); }
  process.exitCode = receipt.verdict === 'PASS' ? 0 : 1;
}
