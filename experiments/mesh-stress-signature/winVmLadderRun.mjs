// winVmLadderRun.mjs -- calibrate a REAL golden-box Win11 VM as a mesh actor. Consumes the committed per-rung
// PDH captures (winMeshActorCapture.ps1 drove the running golden VM through busy=0..4 via VBoxManage
// guestcontrol, each an exact-12-FPS winPdhSampler run), builds the per-rung signature with the shared engine,
// fits the calibration curve + invariants, and inverse-reads every rung back from its own signature. This is
// the VM-fidelity counterpart to liveLadderRun.mjs: the ladder rungs are a REAL Win11 VM's own PDH signature.
// Deterministic (pure computation over the committed real captures) so it re-runs OFFLINE in CI with no VM.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildSignature } from './signatureExtractor.mjs';
import { fitCalibrationCurve, inverseRead } from './calibrationCurveFitter.mjs';
import { MESH_STRESS_LEVELS } from './stressOrchestrator.mjs';

export const WIN_VM_LADDER_SCHEMA = 'labview-benchmark-actor/win-vm-mesh-ladder@1';
const here = dirname(fileURLToPath(import.meta.url));
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

/** Read + parse a JSON file, tolerating a UTF-8 BOM (PowerShell's Out-File writes one; require() strips it, JSON.parse does not). */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

/** Split one rung's PDH capture into `repeats` equal, contiguous runs (for the across-repeat stability). */
function splitRuns(samples, repeats) {
  const per = Math.floor(samples.length / repeats);
  const runs = [];
  for (let r = 0; r < repeats; r += 1) runs.push({ samples: samples.slice(r * per, (r + 1) * per) });
  return runs;
}

/**
 * Calibrate the golden VM from its committed per-rung PDH captures.
 * @param {{repeats?:number, frameRateHz?:number, vmName?:string, fixturesDir?:string}} [opts]
 */
export function runWinVmLadder(opts = {}) {
  const repeats = opts.repeats ?? 3;
  const frameRateHz = opts.frameRateHz ?? 12;
  const vmName = opts.vmName ?? 'actor-reviewer-golden';
  const dir = opts.fixturesDir ?? join(here, 'fixtures');
  const levels = MESH_STRESS_LEVELS;
  const captures = levels.map((_, i) => readJson(join(dir, `win-vm-ladder-b${i}.json`)));

  const rungs = captures.map((cap, i) => ({
    rung: levels[i],
    level: i,
    signature: buildSignature(splitRuns(cap.samples, repeats), { frameRateHz }),
  }));
  const model = fitCalibrationCurve(rungs);

  const cpuCurve = (model.perFeature['cpuTotalPct.mean'] ? model.perFeature['cpuTotalPct.mean'].curve : [])
    .map((c) => ({ rung: c.rung, expected: round1(c.expected), tolerance: round2(c.tolerance || 0) }));

  const perRungInverseRead = rungs.map((r) => {
    const ir = inverseRead(model, r.signature);
    return { rung: r.rung, inferredRung: ir.inferredRung, confidence: round2(ir.confidence), correct: ir.inferredRung === r.rung };
  });
  const allRungsRecovered = perRungInverseRead.every((x) => x.correct);

  return {
    schema: WIN_VM_LADDER_SCHEMA,
    capturedAtIso: new Date().toISOString(),
    vm: { name: vmName, plane: 'WIN', busyByRung: levels.map((rung, i) => ({ rung, busyCores: i })) },
    ladder: { levels, repeats, samplesPerRepeat: Math.floor(captures[0].samples.length / repeats), frameRateHz },
    measuredFpsByRung: captures.map((cap, i) => ({ rung: levels[i], effectiveFps: cap.measured.effectiveFps, exactly12fps: cap.measured.exactly12fps })),
    counterKeys: model.counterKeys,
    salientDimensions: model.salientDimensions,
    cpuTotalPctMeanCurve: cpuCurve,
    invariants: model.invariants,
    separability: model.separability.map((s) => ({ from: s.from, to: s.to, separableDims: s.separableDims })),
    perRungInverseRead,
    allRungsRecovered,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = runWinVmLadder();
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  const ir = r.perRungInverseRead.map((x) => `${x.rung}->${x.inferredRung}${x.correct ? '' : '!'}`).join(', ');
  process.stderr.write(`[win-vm-ladder] ${r.vm.name} (WIN, real golden Win11 VM): cpuTotalPct curve [${r.cpuTotalPctMeanCurve.map((c) => c.expected).join(', ')}]%; monotone=${Math.round(r.invariants.monotone * 100)}% separable=${r.invariants.separable} repeatable=${r.invariants.repeatable}; inverse-read ${ir}; allRecovered=${r.allRungsRecovered}\n`);
  process.exit(r.allRungsRecovered ? 0 : 1);
}
