// labview-benchmark-actor -- LIVE v2 capture integration proof (LBA-REQ-011, cross-platform pipeline).
//
// Proves the ONE link the piecewise proofs leave open: a REAL Linux performance-counter sampler feeding the
// SHIPPED capture assembler and the SHIPPED correlator webview, end to end, on real host data --
//   linuxProcSampler (exact-12-FPS /proc counters{}) -> buildLaunchCapture (launch-capture@1 record carrying
//   per-frame counters + a counterKeys union) -> buildFrameCorrelatorHtml (the v2 correlator plots the counter
//   curves). No VM, no fakes: this runs the real drift-corrected /proc sampler on THIS host. The emitted receipt
//   is committed so the self-test + local gate replay the assertions deterministically. Dependency-free ESM.
// CLI: node liveV2Capture.mjs [samples] > receipt.json

import { platform, cpus, hostname } from 'node:os';
import { captureFrameLockedSeries } from '../resource-usage-correlation/linuxProcSampler.mjs';
import { buildLaunchCapture } from './launch-capture.mjs';
import { buildFrameCorrelatorHtml } from './frame-correlator.mjs';

export const LIVE_V2_CAPTURE_SCHEMA = 'labview-benchmark-actor/live-v2-capture@1';

function islandOf(html) {
  const m = html.match(/<script id="fc-model"[^>]*>([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1].replace(/\\u003c/g, '<')) : null;
}

/**
 * Run the real Linux sampler -> buildLaunchCapture -> v2 correlator chain once and return a receipt.
 * @param {object} [opts]
 * @param {number} [opts.samples=36] one sample per 12 FPS frame (~3 s at 12 FPS).
 * @param {number} [opts.frameRateHz=12]
 */
export async function runLiveV2Capture(opts = {}) {
  const frameRateHz = opts.frameRateHz ?? 12;
  const series = await captureFrameLockedSeries({ frameRateHz, samples: opts.samples ?? 36 });

  // real sampler -> capture assembler inputs (each frame + its resource sample share the exact epoch-ms).
  const resourceSamples = series.samples.map((s) => ({ ms: s.epochMs, counters: s.counters }));
  const frames = series.samples.map((s, i) => ({ imageFile: `frame-${String(i).padStart(5, '0')}.png`, imageBytes: 1000 + i, ms: s.epochMs }));
  const record = buildLaunchCapture({
    frames, resourceSamples, startMs: series.epochMsAtFrameZero, fps: frameRateHz,
    meta: { workload: 'live-v2-proof', plane: 'LINUX', source: 'linuxProcSampler' },
  });

  // shipped correlator over the assembled record: the counters must reach the webview model island.
  const html = buildFrameCorrelatorHtml({
    title: 'live-v2', fps: frameRateHz, selectedIndex: 0,
    frames: record.frames.map((f) => ({ index: f.index, tMs: f.tMs, counters: f.counters, imageSrc: 'x' })),
  }, 'nlv2', '');
  const island = islandOf(html);
  const everyFrameHasCounters = record.frames.every((f) => f.counters && typeof f.counters.cpuTotalPct === 'number');
  const correlatorRendersCounters = !!(island && island.frames[0] && island.frames[0].counters && typeof island.frames[0].counters.cpuTotalPct === 'number');

  return {
    schema: LIVE_V2_CAPTURE_SCHEMA,
    capturedAtIso: new Date().toISOString(),
    host: { platform: platform(), cpus: cpus().length, hostname: hostname() },
    source: 'linuxProcSampler -> buildLaunchCapture -> frame-correlator',
    recordSchema: record.schema,
    frameRateHz,
    frameIntervalMs: series.frameIntervalMs,
    measured: series.measured,
    frameCount: record.frameCount,
    sampleCount: series.sampleCount,
    counterKeys: record.counterKeys || [],
    everyFrameHasCounters,
    correlatorRendersCounters,
  };
}

// CLI: node liveV2Capture.mjs [samples] > receipt.json
if (process.argv[1] && process.argv[1].endsWith('liveV2Capture.mjs')) {
  runLiveV2Capture({ samples: Number(process.argv[2]) || 36 }).then((receipt) => {
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    const m = receipt.measured;
    process.stderr.write(
      `[live-v2] ${receipt.frameCount} frames @ ${receipt.frameIntervalMs.toFixed(3)} ms -> ${m.effectiveFps.toFixed(3)} FPS ` +
      `(exactly12fps=${m.exactly12fps}); ${receipt.counterKeys.length} counters; everyFrameHasCounters=${receipt.everyFrameHasCounters}; ` +
      `correlatorRendersCounters=${receipt.correlatorRendersCounters}\n`
    );
    process.exit(receipt.everyFrameHasCounters && receipt.correlatorRendersCounters && m.exactly12fps ? 0 : 2);
  });
}
