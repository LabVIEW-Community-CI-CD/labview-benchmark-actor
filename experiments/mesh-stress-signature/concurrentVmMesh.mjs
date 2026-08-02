// concurrentVmMesh.mjs -- SIMULTANEOUS multi-VM discrimination on REAL data. Two real Win11 VMs (actor-reviewer
// -golden and actor-mesh-b, a VBoxManage linked clone of it) were stressed AT THE SAME WALL-CLOCK TIME at
// DIFFERENT rungs, each PDH-sampled on its own exact-12-FPS series (winMeshActorCapture.ps1 via guestcontrol);
// the golden-VM calibration (winVmLadderRun / win-vm-mesh-ladder) then inverse-reads each concurrent signature.
//
// The robust claim proven here is ORDERING: in every concurrent pairing the calibration correctly identifies
// WHICH VM is more stressed (the higher-commanded VM inverse-reads to a higher level). Exact rung recovery is
// also reported honestly -- perfect on the extreme (saturate vs idle) pairing; the adjacent-mid pairing shifts
// by one rung, reflecting the concurrent regime's host-contention shift away from the solo calibration.
// Deterministic (pure computation over the committed real captures) so it re-runs OFFLINE in CI with no VM.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildSignature } from './signatureExtractor.mjs';
import { fitCalibrationCurve, inverseRead } from './calibrationCurveFitter.mjs';
import { MESH_STRESS_LEVELS } from './stressOrchestrator.mjs';

export const WIN_VM_CONCURRENT_SCHEMA = 'labview-benchmark-actor/win-vm-concurrent-mesh@1';
const here = dirname(fileURLToPath(import.meta.url));
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
function splitRuns(samples, repeats) {
  const per = Math.floor(samples.length / repeats);
  const runs = [];
  for (let r = 0; r < repeats; r += 1) runs.push({ samples: samples.slice(r * per, (r + 1) * per) });
  return runs;
}

// the two concurrent pairings captured on this host (each: VM A and VM B stressed simultaneously at DIFFERENT
// rungs). Crossed on purpose (pairing 1 A-high/B-low, pairing 2 A-low/B-high) so discrimination tracks the
// commanded rung, not the VM identity.
const PAIRINGS = [
  { pairing: 1, a: { commanded: 'saturate', file: 'win-vm-concurrent-cc1-A.json' }, b: { commanded: 'idle', file: 'win-vm-concurrent-cc1-B.json' } },
  { pairing: 2, a: { commanded: 'light', file: 'win-vm-concurrent-cc2-A.json' }, b: { commanded: 'heavy', file: 'win-vm-concurrent-cc2-B.json' } },
];

/** Build the golden-VM calibration model from the committed solo ladder captures (win-vm-mesh-ladder). */
function buildCalibration(dir, repeats, frameRateHz) {
  const rungs = MESH_STRESS_LEVELS.map((rung, i) => ({
    rung,
    level: i,
    signature: buildSignature(splitRuns(readJson(join(dir, `win-vm-ladder-b${i}.json`)).samples, repeats), { frameRateHz }),
  }));
  return fitCalibrationCurve(rungs);
}

/**
 * Discriminate the concurrent VM pairings against the golden-VM calibration.
 * @param {{repeats?:number, frameRateHz?:number, fixturesDir?:string}} [opts]
 */
export function runConcurrentVmMesh(opts = {}) {
  const repeats = opts.repeats ?? 3;
  const frameRateHz = opts.frameRateHz ?? 12;
  const dir = opts.fixturesDir ?? join(here, 'fixtures');
  const model = buildCalibration(dir, repeats, frameRateHz);
  const levelOf = (rung) => MESH_STRESS_LEVELS.indexOf(rung);

  const analyze = (entry, vm) => {
    const cap = readJson(join(dir, entry.file));
    const sig = buildSignature(splitRuns(cap.samples, repeats), { frameRateHz });
    const ir = inverseRead(model, sig);
    const cpu = cap.samples.map((s) => s.counters.cpuTotalPct).filter((x) => typeof x === 'number');
    const epochs = cap.samples.map((s) => s.epochMs);
    return {
      vm,
      commandedRung: entry.commanded,
      commandedLevel: levelOf(entry.commanded),
      inferredRung: ir.inferredRung,
      inferredLevel: ir.inferredLevel,
      confidence: round2(ir.confidence),
      cpuTotalPctMean: round1(cpu.reduce((a, x) => a + x, 0) / cpu.length),
      windowStartMs: Math.min(...epochs),
      windowEndMs: Math.max(...epochs),
      exact: ir.inferredRung === entry.commanded,
    };
  };

  const pairings = PAIRINGS.map((p) => {
    const a = analyze(p.a, 'actor-reviewer-golden');
    const b = analyze(p.b, 'actor-mesh-b');
    const overlapMs = Math.min(a.windowEndMs, b.windowEndMs) - Math.max(a.windowStartMs, b.windowStartMs);
    const commandedOrder = Math.sign(a.commandedLevel - b.commandedLevel);
    const inferredOrder = Math.sign(a.inferredLevel - b.inferredLevel);
    return {
      pairing: p.pairing,
      a,
      b,
      concurrentOverlapMs: overlapMs,
      simultaneous: overlapMs > 0,
      rankingCorrect: commandedOrder === inferredOrder && commandedOrder !== 0,
    };
  });

  const readings = pairings.flatMap((p) => [p.a, p.b]);
  return {
    schema: WIN_VM_CONCURRENT_SCHEMA,
    capturedAtIso: new Date().toISOString(),
    vms: { a: { name: 'actor-reviewer-golden', role: 'golden VM' }, b: { name: 'actor-mesh-b', role: 'linked clone of the golden VM' } },
    calibration: { from: 'win-vm-mesh-ladder (golden VM solo ladder)', frameRateHz, salientDimensions: model.salientDimensions.length },
    pairings,
    allPairingsSimultaneous: pairings.every((p) => p.simultaneous),
    allPairingsRankedCorrectly: pairings.every((p) => p.simultaneous && p.rankingCorrect),
    exactRungMatches: readings.filter((x) => x.exact).length,
    totalReadings: readings.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = runConcurrentVmMesh();
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  const lines = r.pairings.map((p) => `  P${p.pairing} (overlap ${p.concurrentOverlapMs}ms): A ${p.a.commandedRung}->${p.a.inferredRung} (${p.a.cpuTotalPctMean}%) | B ${p.b.commandedRung}->${p.b.inferredRung} (${p.b.cpuTotalPctMean}%) | ranked=${p.rankingCorrect}`);
  process.stderr.write(`[concurrent-vm-mesh] 2 real Win11 VMs (golden + linked clone), stressed simultaneously:\n${lines.join('\n')}\nallSimultaneous=${r.allPairingsSimultaneous} allRankedCorrectly=${r.allPairingsRankedCorrectly} exactRungMatches=${r.exactRungMatches}/${r.totalReadings}\n`);
  process.exit(r.allPairingsRankedCorrectly ? 0 : 1);
}
