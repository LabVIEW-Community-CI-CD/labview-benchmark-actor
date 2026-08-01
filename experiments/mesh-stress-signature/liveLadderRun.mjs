// labview-benchmark-actor -- LIVE mesh-stress ladder run (mesh-stress-signature@v1, LBA-REQ-032).
//
// Drives the FULL stress ladder (idle -> saturate) on THIS host with REAL load and REAL /proc counters, then
// calibrates end to end: for each rung the orchestrator's commanded workload is applied as REAL CPU spinners
// scaled to the host core count, linuxProcSampler captures a REAL exact-12-FPS series per repeat, the signature
// extractor builds the per-rung signature across repeats, and the calibration-curve fitter fits the ladder +
// scores the monotone/separable/repeatable invariants + inverse-reads a held-out signature back to its rung.
// No fakes: the load is real OS pressure and every counter is read from /proc. Emits a committed receipt so the
// self-test + gate replay the calibration deterministically. (The multi-VM horizontal slice -- each actor a
// golden-box VM pinned to a DIFFERENT rung simultaneously -- is the scale-up; this proves the calibration live.)
// Dependency-free ESM. CLI: node liveLadderRun.mjs [repeats] [samples] > receipt.json

import { spawn } from 'node:child_process';
import { cpus, platform, hostname, totalmem, loadavg } from 'node:os';
import { captureFrameLockedSeries } from '../resource-usage-correlation/linuxProcSampler.mjs';
import { buildSignature } from './signatureExtractor.mjs';
import { fitCalibrationCurve, inverseRead } from './calibrationCurveFitter.mjs';
import { MESH_STRESS_LEVELS, levelCommand } from './stressOrchestrator.mjs';

export const LIVE_LADDER_SCHEMA = 'labview-benchmark-actor/mesh-stress-live-ladder@1';
const NPROC = cpus().length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start REAL CPU load scaled to the rung's commanded workload (idle -> 0 spinners, saturate -> all cores). */
function startLoad(level) {
  const spinners = Math.round((levelCommand(level).workloadWorkers / 8) * NPROC);
  const spin = 'const e=Date.now()+600000;let x=0;while(Date.now()<e){for(let i=0;i<200000;i+=1){x+=Math.sqrt(x*1.0001+i);}}';
  const kids = [];
  for (let i = 0; i < spinners; i += 1) kids.push(spawn(process.execPath, ['-e', spin], { stdio: 'ignore' }));
  return { kids, spinners };
}
function stopLoad(kids) { for (const k of kids || []) { try { k.kill('SIGKILL'); } catch { /* gone */ } } }

/** Run the full live ladder + calibrate. */
export async function runLiveLadder(opts = {}) {
  const repeats = opts.repeats ?? 3;
  const samples = opts.samples ?? 24;
  const rungs = [];
  const commanded = [];
  for (let li = 0; li < MESH_STRESS_LEVELS.length; li += 1) {
    const level = MESH_STRESS_LEVELS[li];
    const runs = [];
    let spinners = 0;
    for (let r = 0; r < repeats; r += 1) {
      const load = startLoad(level);
      spinners = load.spinners;
      await sleep(400); // let the load ramp onto the cores
      const series = await captureFrameLockedSeries({ samples });
      stopLoad(load.kids);
      await sleep(250); // settle before the next repeat
      runs.push(series.samples);
    }
    commanded.push({ rung: level, level: li, spinners, workloadWorkers: levelCommand(level).workloadWorkers });
    rungs.push({ rung: level, level: li, signature: buildSignature(runs, { stabilityThreshold: opts.stabilityThreshold ?? 0.4 }) });
  }

  const model = fitCalibrationCurve(rungs, { bandK: opts.bandK ?? 2, separableMinDims: 1 });
  // inverse-read a held-out rung's signature (the medium rung) back through the calibrated curve.
  const heldOut = rungs[Math.floor(rungs.length / 2)];
  const inverse = inverseRead(model, heldOut.signature);

  // the calibration curve for the primary CPU dimension (the load-tracking counter), compactly.
  const cpuMeanCurve = (model.perFeature['cpuTotalPct.mean'] || {}).curve || null;

  return {
    schema: LIVE_LADDER_SCHEMA,
    capturedAtIso: new Date().toISOString(),
    host: { platform: platform(), cpus: NPROC, totalMemGb: Math.round(totalmem() / 1e9), hostname: hostname(), loadAvg1: loadavg()[0] },
    ladder: { levels: MESH_STRESS_LEVELS, repeats, samplesPerRepeat: samples, commanded },
    frameRateHz: 12,
    counterKeys: model.counterKeys,
    salientDimensions: model.salientDimensions,
    cpuTotalPctMeanCurve: cpuMeanCurve ? cpuMeanCurve.map((c) => ({ rung: c.rung, expected: c.expected == null ? null : Math.round(c.expected * 10) / 10, tolerance: c.tolerance == null ? null : Math.round(c.tolerance * 10) / 10 })) : null,
    invariants: model.invariants,
    separability: model.separability,
    inverseRead: { heldOutRung: heldOut.rung, inferredRung: inverse.inferredRung, confidence: Math.round(inverse.confidence * 1000) / 1000 },
  };
}

// CLI: node liveLadderRun.mjs [repeats] [samples] > receipt.json
if (process.argv[1] && process.argv[1].endsWith('liveLadderRun.mjs')) {
  runLiveLadder({ repeats: Number(process.argv[2]) || 3, samples: Number(process.argv[3]) || 24 }).then((receipt) => {
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    const iv = receipt.invariants;
    process.stderr.write(
      `[live-ladder] ${receipt.ladder.levels.length} rungs x ${receipt.ladder.repeats} repeats on ${receipt.host.cpus} cores; ` +
      `salient=${receipt.salientDimensions.length}; monotone=${(iv.monotone * 100).toFixed(0)}% separable=${iv.separable} repeatable=${iv.repeatable}; ` +
      `inverse-read ${receipt.inverseRead.heldOutRung}->${receipt.inverseRead.inferredRung} (conf ${receipt.inverseRead.confidence}); ` +
      `cpuTotalPct.mean curve [${(receipt.cpuTotalPctMeanCurve || []).map((c) => c.expected).join(', ')}]\n`
    );
    process.exit(iv.separable && receipt.inverseRead.heldOutRung === receipt.inverseRead.inferredRung ? 0 : 2);
  });
}
