// labview-benchmark-actor -- LIVE end-to-end capture -> correlate driver (LBA-REQ-011, cross-platform).
//
// Ties the two halves of the perf-counter pipeline together on REAL data, live:
//   1. captureFrameLockedSeries() records a REAL /proc series phase-locked to EXACTLY the 12 FPS frame clock
//      (one sample per 12 FPS long packet), while
//   2. at a chosen TRIGGER frame a bounded, REAL workload burst is fired -- CPU spinners + a disk writer, each a
//      CHILD PROCESS so the sampler's frame clock is never blocked (a busy loop in-process would starve the
//      drift-corrected timers and destroy the phase-lock), then
//   3. buildPerformanceCounterCorrelation() anchors the pre/post-trigger window PER counter key, and
//   4. the driver proves the trigger is DETECTABLE -- expected counters (cpu / disk / context-switches) rise
//      across the trigger by an interpretable margin -- and emits a receipt.
//
// No fakes: the burst is real OS load and the counters are read from /proc. The emitted receipt is committed as a
// fixture so the self-test + local gate can replay the exact-12-FPS + trigger-detection assertions deterministically.
// Dependency-free ESM (Node built-ins only). CLI: node captureAndCorrelate.mjs [samples] [triggerFrame] > receipt.json

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, cpus, platform, hostname } from 'node:os';
import { join } from 'node:path';
import { captureFrameLockedSeries } from './linuxProcSampler.mjs';
import { buildPerformanceCounterCorrelation } from './performanceCounterCorrelation.mjs';

export const LIVE_CORRELATION_SCHEMA = 'labview-benchmark-actor/perf-counter-live-correlation@1';

// Counters expected to RISE when the CPU+disk burst fires -- the correlation must surface at least one of these.
export const EXPECTED_RISERS = Object.freeze(['cpuTotalPct', 'diskWriteBytesPerSec', 'diskWritesPerSec', 'contextSwitchesPerSec']);

// Interpretable, real detection thresholds on the post-minus-pre deltaMean of an EXPECTED_RISER.
export const DETECTION_THRESHOLDS = Object.freeze({
  cpuTotalPct: 5,               // >= 5 percentage points more CPU busy after the trigger
  diskWriteBytesPerSec: 1e6,    // >= 1 MB/s more disk write throughput
  diskWritesPerSec: 10,         // >= 10 more write ops/sec
  contextSwitchesPerSec: 2000   // >= 2000 more context switches/sec
});

/** Per-counter normalization floor so a near-idle pre-window does not explode the mover score. */
function scoreFloor(key) {
  if (/Bytes/.test(key)) return 1e6;
  if (/Pct$/.test(key)) return 1;
  if (/PerSec$/.test(key)) return 5;
  return 1;
}

/** Fire a bounded, REAL workload burst as CHILD PROCESSES (never blocks the sampler's frame clock). */
export function startBurst(tmpDir, capMs = 30000) {
  const kids = [];
  const spin = `const e=Date.now()+${capMs};let x=0;while(Date.now()<e){for(let i=0;i<200000;i+=1){x+=Math.sqrt(x*1.0001+i);}}process.exit(0);`;
  for (let i = 0; i < 2; i += 1) kids.push(spawn(process.execPath, ['-e', spin], { stdio: 'ignore' }));
  const p = JSON.stringify(join(tmpDir, 'perf-burst.bin'));
  const disk = `const fs=require('node:fs');const p=${p};const b=Buffer.alloc(4*1024*1024,7);const e=Date.now()+${capMs};while(Date.now()<e){const fd=fs.openSync(p,'w');for(let i=0;i<8;i+=1)fs.writeSync(fd,b);fs.fsyncSync(fd);fs.closeSync(fd);}try{fs.unlinkSync(p);}catch{}process.exit(0);`;
  kids.push(spawn(process.execPath, ['-e', disk], { stdio: 'ignore' }));
  return kids;
}

/** Stop a burst started by startBurst(). */
export function stopBurst(kids) {
  for (const k of kids || []) { try { k.kill('SIGKILL'); } catch { /* already gone */ } }
}

/**
 * Rank the counters by how strongly they moved across the trigger (normalized post-minus-pre delta).
 * @param {object} model a performance-counter-correlation@v2 model.
 * @returns {Array<{key:string,preMean:number|null,postMean:number|null,deltaMean:number|null,score:number}>}
 */
export function rankMovers(model) {
  const movers = [];
  for (const key of model.counterKeys) {
    const c = model.perCounter[key];
    if (!c || c.deltaMean == null) continue;
    const denom = Math.max(Math.abs(c.pre.mean ?? 0), scoreFloor(key));
    movers.push({ key, preMean: c.pre.mean, postMean: c.post.mean, deltaMean: c.deltaMean, score: c.deltaMean / denom });
  }
  movers.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  return movers;
}

/** Decide whether the correlation surfaced the trigger: an EXPECTED_RISER cleared its detection threshold. */
export function decideDetection(model) {
  const detectedBy = [];
  for (const key of EXPECTED_RISERS) {
    const c = model.perCounter[key];
    const thr = DETECTION_THRESHOLDS[key];
    if (c && c.deltaMean != null && thr != null && c.deltaMean >= thr) {
      detectedBy.push({ key, deltaMean: c.deltaMean, threshold: thr });
    }
  }
  return { triggerDetected: detectedBy.length > 0, detectedBy };
}

/**
 * Run the live capture -> correlate pipeline once and return a receipt (REAL data, no fakes).
 * @param {object} [opts]
 * @param {number} [opts.frameRateHz=12]
 * @param {number} [opts.samples=96] one sample per 12 FPS frame (~8 s at 12 FPS).
 * @param {number} [opts.triggerFrame] frame index the burst fires at (default ~1/3 into the capture).
 * @param {boolean} [opts.burst=true] set false to capture an idle baseline (no workload fired).
 */
export async function captureAndCorrelate(opts = {}) {
  const frameRateHz = opts.frameRateHz ?? 12;
  const samples = opts.samples ?? 96;
  const frameIntervalMs = 1000 / frameRateHz;
  const triggerFrame = Number.isFinite(opts.triggerFrame) ? opts.triggerFrame : Math.floor(samples / 3);
  const fireBurst = opts.burst !== false;

  const epoch0 = Date.now() + 250; // start a hair in the future so capture + burst share the frame clock
  const triggerEpochMs = epoch0 + triggerFrame * frameIntervalMs;
  const tmpDir = mkdtempSync(join(tmpdir(), 'lba-perf-burst-'));

  const capturePromise = captureFrameLockedSeries({ frameRateHz, samples, epochMsAtFrameZero: epoch0 });
  let kids = [];
  const burstTimer = fireBurst
    ? setTimeout(() => { kids = startBurst(tmpDir); }, Math.max(0, triggerEpochMs - Date.now()))
    : null;

  let series;
  try {
    series = await capturePromise;
  } finally {
    if (burstTimer) clearTimeout(burstTimer);
    stopBurst(kids);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const model = buildPerformanceCounterCorrelation({
    frameRateHz, epochMsAtFrameZero: series.epochMsAtFrameZero, triggerEpochMs, samples: series.samples
  });
  const detection = decideDetection(model);
  const topMovers = rankMovers(model).slice(0, 6);

  return {
    schema: LIVE_CORRELATION_SCHEMA,
    capturedAtIso: new Date().toISOString(),
    host: { platform: platform(), cpus: cpus().length, hostname: hostname() },
    workload: fireBurst ? 'cpu(2 spinners) + disk(fsync writer) burst, child processes' : 'idle baseline (no burst)',
    capture: {
      frameRateHz: series.frameRateHz,
      frameIntervalMs: series.frameIntervalMs,
      sampleCount: series.sampleCount,
      measured: series.measured
    },
    trigger: { triggerEpochMs, triggerFrameIndex: model.triggerFrameIndex, triggerFrame },
    correlation: {
      counterKeys: model.counterKeys,
      preSampleCount: model.preSampleCount,
      postSampleCount: model.postSampleCount,
      perCounter: model.perCounter
    },
    detection: {
      ...detection,
      expectedRisers: EXPECTED_RISERS,
      thresholds: DETECTION_THRESHOLDS,
      topMovers
    }
  };
}

// CLI: node captureAndCorrelate.mjs [samples] [triggerFrame] > receipt.json
if (process.argv[1] && process.argv[1].endsWith('captureAndCorrelate.mjs')) {
  const samples = Number(process.argv[2]) || 96;
  const triggerFrame = process.argv[3] != null ? Number(process.argv[3]) : undefined;
  captureAndCorrelate({ samples, triggerFrame }).then((receipt) => {
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    const m = receipt.capture.measured;
    const d = receipt.detection;
    process.stderr.write(
      `[live] ${receipt.capture.sampleCount} samples @ ${receipt.capture.frameIntervalMs.toFixed(3)} ms -> ` +
      `${m.effectiveFps.toFixed(3)} FPS (exactly12fps=${m.exactly12fps}, maxPhaseErr ${m.maxPhaseErrorMs} ms); ` +
      `trigger@frame ${receipt.trigger.triggerFrameIndex}; detected=${d.triggerDetected} ` +
      `via ${d.detectedBy.map((x) => `${x.key}+${Math.round(x.deltaMean)}`).join(', ') || '(none)'}\n`
    );
    process.exit(d.triggerDetected ? 0 : 2);
  });
}
