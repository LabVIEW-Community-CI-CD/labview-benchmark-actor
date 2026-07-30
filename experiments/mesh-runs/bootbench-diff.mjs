// bootbench-diff.mjs — cross-plane diff of two sealed bootbench-4milestone@1 records, reusing the
// boot-benchmark-diff per-span tolerance + witness gate (#173). A bootbench record carries buildMs/meshFormMs
// as {min,mean,max} guest-clock stats (no visual frames); this projects each record's MEANS into the two
// comparable cross-plane spans (buildMs tight-gated, meshFormMs witness) so bootBenchmarkDiff scores them
// uniformly — the same machinery the VM boot-benchmark uses, applied to the hypervisor-free container path.
//
//   node experiments/mesh-runs/bootbench-diff.mjs [winRecord.json linuxRecord.json] [--out receipt.json]
//   (defaults to the committed fixtures/win-bootbench-4milestone.json + fixtures/linux-bootbench-4milestone.json)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootBenchmarkDiff } from '../mprr-boot-benchmark/boot-benchmark-diff.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTBENCH_SCHEMA = 'labview-benchmark-actor/bootbench-4milestone@1';

// buildMs is a deterministic offline build (tight); meshFormMs carries mesh-formation variance (peer
// readiness + retry cadence), so it is a wider-tolerance WITNESS span — matching the #173 per-span design.
export const BUILD_TOLERANCE_MS = 2000;
export const MESHFORM_TOLERANCE_MS = 5000;

/** Project a bootbench-4milestone@1 record's guest-clock MEANS into a timing-only boot-benchmark-v1 record. */
export function bootbenchToSpansRecord(rec) {
  if (!rec || rec.schema !== BOOTBENCH_SCHEMA) {
    throw new Error(`bootbench-diff: not a ${BOOTBENCH_SCHEMA} record (got ${rec?.schema ?? 'null'})`);
  }
  if (!Number.isFinite(rec.buildMs?.mean) || !Number.isFinite(rec.meshFormMs?.mean)) {
    throw new Error('bootbench-diff: record is missing buildMs.mean / meshFormMs.mean');
  }
  const plane = rec.plane ?? 'UNKNOWN';
  return {
    schema: 'labview-benchmark-actor/boot-benchmark-v1',
    iteration: `${String(plane).toLowerCase()}-bootbench-${rec.commit ?? 'dev'}`,
    plane,
    // Distinct per-plane docker "hypervisor" so crossPlane reflects reality (WIN Docker/WSL2 vs LINUX
    // Docker/native). Both spans are guest-clock scope 'cross-plane', so they compare regardless.
    hypervisor: plane === 'LINUX' ? 'docker-native' : 'docker-wsl2',
    substrate: rec.substrate ?? 'docker-container',
    // Timing-only projection: no frames. fingerprintAlgo satisfies boot-benchmark-diff's visual algo guard so
    // the (empty) witness layer is a clean WITNESS_MATCH and only the TIMING gate decides the verdict.
    fingerprintAlgo: 'dhash-64',
    frames: [],
    spans: [
      { id: 'buildMs', ms: rec.buildMs.mean, clock: 'guest', scope: 'cross-plane' },
      { id: 'meshFormMs', ms: rec.meshFormMs.mean, clock: 'guest', scope: 'cross-plane' },
    ],
    source: { runId: rec.runId, buildMs: rec.buildMs, meshFormMs: rec.meshFormMs, okCount: rec.okCount, actors: rec.actors },
  };
}

/**
 * Cross-plane bootbench diff (baseline = LINUX committed fixture, candidate = WIN): buildMs tight-gated,
 * meshFormMs witness. Returns the bootBenchmarkDiff report over the projected records.
 */
export function bootbenchDiff(winRec, linuxRec) {
  const candidate = bootbenchToSpansRecord(winRec);
  const baseline = bootbenchToSpansRecord(linuxRec);
  return bootBenchmarkDiff(baseline, candidate, {
    timingToleranceMs: { default: BUILD_TOLERANCE_MS, buildMs: BUILD_TOLERANCE_MS, meshFormMs: MESHFORM_TOLERANCE_MS },
    witnessSpans: ['meshFormMs'],
  });
}

/** Build the committable cross-plane receipt from the two records + the diff. */
export function bootbenchReceipt(winRec, linuxRec) {
  const diff = bootbenchDiff(winRec, linuxRec);
  const span = (id) => diff.timing.spans.find((s) => s.id === id) ?? null;
  const one = (r) => ({ plane: r.plane, runId: r.runId, commit: r.commit, buildMs: r.buildMs, meshFormMs: r.meshFormMs });
  return {
    schema: 'labview-benchmark-actor/bootbench-cross-plane-diff-receipt@1',
    verdict: diff.verdict,
    substrate: 'docker-container (hypervisor-free)',
    win: one(winRec),
    linux: one(linuxRec),
    toleranceMs: { buildMs: BUILD_TOLERANCE_MS, meshFormMs: `${MESHFORM_TOLERANCE_MS} (witness)` },
    timing: { verdict: diff.timing.verdict, buildMs: span('buildMs'), meshFormMs: span('meshFormMs') },
    rerun: 'node experiments/mesh-runs/bootbench-diff.mjs',
  };
}

if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/').split('/').pop() ?? '')) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
  const positional = args.filter((a, i) => !a.startsWith('--') && i !== outIdx + 1);
  const fx = join(HERE, 'fixtures');
  const winPath = positional[0] ?? join(fx, 'win-bootbench-4milestone.json');
  const linuxPath = positional[1] ?? join(fx, 'linux-bootbench-4milestone.json');
  const winRec = JSON.parse(readFileSync(winPath, 'utf8'));
  const linuxRec = JSON.parse(readFileSync(linuxPath, 'utf8'));
  const receipt = bootbenchReceipt(winRec, linuxRec);
  const b = receipt.timing.buildMs; const m = receipt.timing.meshFormMs;
  console.log(`bootbench cross-plane diff: ${receipt.verdict} (${receipt.timing.verdict})`);
  console.log(`  buildMs    LINUX ${b.msA} -> WIN ${b.msB}  Δ${b.deltaMs}ms  tol ${b.toleranceMs}  ${b.status}`);
  console.log(`  meshFormMs LINUX ${m.msA} -> WIN ${m.msB}  Δ${m.deltaMs}ms  tol ${m.toleranceMs}  ${m.status}`);
  if (outPath) { writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`); console.log(`receipt -> ${outPath}`); }
  process.exitCode = receipt.verdict === 'PASS' ? 0 : 1;
}
