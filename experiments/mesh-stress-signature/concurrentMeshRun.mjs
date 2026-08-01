// concurrentMeshRun.mjs -- the SIMULTANEOUS mesh: N actors, each pinned to a DISJOINT core pool (taskset -c)
// and commanded to a DIFFERENT stress rung AT THE SAME WALL-CLOCK TIME, are each sampled on their own exact-12
// -FPS /proc CPU series; the SAME calibration engine then fits the rung ladder from the concurrent signatures
// and INVERSE-READS every actor's rung back from its own signature. Where the live ladder (liveLadderRun.mjs)
// proved rungs are resolvable SEQUENTIALLY over time on one actor, this proves them resolvable SPATIALLY --
// which actor is stressed, and how much, all at once -- the mesh's namesake claim. Real data, no fakes.
//   usage: node concurrentMeshRun.mjs [repeats=3] [poolSize=4]

import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { captureActors, CLK_TCK } from './perActorProcSampler.mjs';
import { buildSignature } from './signatureExtractor.mjs';
import { fitCalibrationCurve, inverseRead } from './calibrationCurveFitter.mjs';
import { MESH_STRESS_LEVELS } from './stressOrchestrator.mjs';

export const MESH_CONCURRENT_SCHEMA = 'labview-benchmark-actor/mesh-concurrent-actors@1';
const here = dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

/** Split one actor's frame series into `repeats` equal, contiguous runs (for the across-repeat stability). */
function splitRuns(samples, repeats) {
  const per = Math.floor(samples.length / repeats);
  const runs = [];
  for (let r = 0; r < repeats; r += 1) runs.push({ samples: samples.slice(r * per, (r + 1) * per) });
  return runs;
}

/**
 * Drive the concurrent mesh end to end and return a committed-shaped receipt.
 * @param {{poolSize?:number, repeats?:number, samplesPerRepeat?:number, frameRateHz?:number, rampMs?:number}} [opts]
 */
export async function runConcurrentMesh(opts = {}) {
  const poolSize = opts.poolSize ?? 4;
  const repeats = opts.repeats ?? 3;
  const samplesPerRepeat = opts.samplesPerRepeat ?? 16;
  const frameRateHz = opts.frameRateHz ?? 12;
  const rampMs = opts.rampMs ?? 600;
  const levels = MESH_STRESS_LEVELS;
  const totalSamples = repeats * samplesPerRepeat;
  const captureMs = (totalSamples / frameRateHz) * 1000;
  const durationMs = Math.ceil(rampMs + captureMs + 900);
  const cpus = os.cpus().length;

  // each actor gets a disjoint pool of `poolSize` cores + a busyCount = its rung index (idle 0 .. saturate poolSize)
  const actors = levels.map((rung, i) => ({
    actor: `actor-${i}`,
    rung,
    level: i,
    cores: Array.from({ length: poolSize }, (_, k) => i * poolSize + k),
    busyCount: Math.min(i, poolSize),
  }));

  const actorLoad = join(here, 'actorLoad.mjs');
  const procs = actors.map((a) => {
    const child = spawn('taskset', ['-c', a.cores.join(','), process.execPath, actorLoad, String(a.busyCount), String(durationMs)], { stdio: 'ignore' });
    a.pid = child.pid;
    return child;
  });

  try {
    await sleep(rampMs); // let each actor's workers ramp to steady state before the frame-locked capture
    const capture = await captureActors({
      actors: actors.map((a) => ({ actor: a.actor, pid: a.pid, poolSize })),
      frameRateHz,
      samples: totalSamples,
      clkTck: CLK_TCK,
    });

    const byActor = new Map(capture.actors.map((c) => [c.actor, c.samples]));
    // the ladder of per-rung signatures -- but every rung was captured SIMULTANEOUSLY, one per concurrent actor
    const rungs = actors.map((a) => ({
      rung: a.rung,
      level: a.level,
      signature: buildSignature(splitRuns(byActor.get(a.actor), repeats), { frameRateHz }),
    }));
    const model = fitCalibrationCurve(rungs);

    const perActorInverseRead = actors.map((a) => {
      const sig = rungs.find((r) => r.level === a.level).signature;
      const ir = inverseRead(model, sig);
      return { actor: a.actor, commandedRung: a.rung, inferredRung: ir.inferredRung, confidence: round2(ir.confidence), correct: ir.inferredRung === a.rung };
    });
    const allActorsRecovered = perActorInverseRead.every((x) => x.correct);

    const actorSummary = actors.map((a) => {
      const s = byActor.get(a.actor);
      const mean = s.reduce((acc, x) => acc + (x.counters.cpuPoolPct || 0), 0) / s.length;
      return { actor: a.actor, rung: a.rung, busyCount: a.busyCount, cores: a.cores.join(','), cpuPoolPctMean: round1(mean) };
    });

    return {
      schema: MESH_CONCURRENT_SCHEMA,
      capturedAtIso: new Date().toISOString(),
      host: { platform: os.platform(), cpus, hostname: os.hostname(), poolSize, actors: actors.length },
      config: { poolSize, repeats, samplesPerRepeat, frameRateHz, coresUsed: actors.length * poolSize },
      frameRateHz,
      measured: capture.measured,
      actors: actorSummary,
      counterKeys: model.counterKeys,
      salientDimensions: model.salientDimensions,
      invariants: model.invariants,
      separability: model.separability.map((s) => ({ from: s.from, to: s.to, separableDims: s.separableDims })),
      perActorInverseRead,
      allActorsRecovered,
      concurrency: {
        simultaneousFrames: totalSamples,
        actorsPerFrame: actors.length,
        allActorsSampledEveryFrame: capture.actors.every((c) => c.samples.length === totalSamples),
      },
    };
  } finally {
    for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repeats = Number.parseInt(process.argv[2] || '3', 10);
  const poolSize = Number.parseInt(process.argv[3] || '4', 10);
  runConcurrentMesh({ repeats, poolSize })
    .then((r) => {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      const ir = r.perActorInverseRead.map((x) => `${x.commandedRung}->${x.inferredRung}${x.correct ? '' : '!'}`).join(', ');
      process.stderr.write(`[concurrent-mesh] ${r.actors.length} actors on ${r.host.cpus} cores (pool ${r.config.poolSize}); cpuPoolPct means [${r.actors.map((a) => a.cpuPoolPctMean).join(', ')}]; ${r.measured.effectiveFps} FPS; monotone=${Math.round(r.invariants.monotone * 100)}% separable=${r.invariants.separable} repeatable=${r.invariants.repeatable}; inverse-read ${ir}; allRecovered=${r.allActorsRecovered}\n`);
      process.exit(r.allActorsRecovered && r.measured.exactly12fps ? 0 : 1);
    })
    .catch((e) => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exit(1); });
}
