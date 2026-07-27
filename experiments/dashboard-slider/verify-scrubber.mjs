/**
 * LBA dashboard next-horizon (Discussion #2365, task lba-dashboard):
 * deterministic Node self-test for the benchmark frame-scrubber shell. No
 * browser required -- it validates the nearest-preceding snap semantic (OQ3),
 * the self-contained HTML document invariants (nonce CSP, encoded JSON island,
 * sorted points), and the mprr synchronized-review-state mapper against the
 * real emitted Linux state when present. A headless-Chromium interaction proof
 * (slider drag / arrow paging / frame swap) is the follow-up, mirroring
 * vagrant/playwright/viPreviewViewerInteraction.cjs.
 *
 * Run: node experiments/dashboard-slider/verify-scrubber.mjs
 * Optional real state: VIHS_SCRUBBER_STATE=<path to synchronized-review-state.json>
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBenchmarkFrameScrubberHtml,
  resolveNearestPrecedingIndex
} from './buildBenchmarkFrameScrubberHtml.mjs';
import {
  buildScrubberModelFromSynchronizedReviewState
} from './scrubberModelFromState.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log('  ok   ' + label);
  } else {
    failures += 1;
    console.log('  FAIL ' + label + (detail ? '  -- ' + detail : ''));
  }
}

// ---------------------------------------------------------------------------
// 1. nearest-preceding snap semantic (OQ3)
// ---------------------------------------------------------------------------
console.log('nearest-preceding (all points eligible)');
const allEligible = [{ centiseconds: 0 }, { centiseconds: 12 }, { centiseconds: 30 }];
check('target 0 -> 0', resolveNearestPrecedingIndex(allEligible, 0) === 0);
check('target 5 -> 0 (preceding)', resolveNearestPrecedingIndex(allEligible, 5) === 0);
check('target 12 -> 1 (exact)', resolveNearestPrecedingIndex(allEligible, 12) === 1);
check('target 25 -> 1 (preceding)', resolveNearestPrecedingIndex(allEligible, 25) === 1);
check('target 30 -> 2 (exact end)', resolveNearestPrecedingIndex(allEligible, 30) === 2);
check('target 999 -> 2 (past end)', resolveNearestPrecedingIndex(allEligible, 999) === 2);
check('target -5 -> 0 (clamp before first)', resolveNearestPrecedingIndex(allEligible, -5) === 0);
check('empty -> -1', resolveNearestPrecedingIndex([], 5) === -1);

console.log('nearest-preceding (frame-start eligibility)');
const mixed = [
  { centiseconds: 0, isFrameStart: true },
  { centiseconds: 12, isFrameStart: false },
  { centiseconds: 30, isFrameStart: true }
];
check('target 20 -> 0 (skip non-frame-start 12)', resolveNearestPrecedingIndex(mixed, 20) === 0);
check('target 12 -> 0 (12 not a frame-start)', resolveNearestPrecedingIndex(mixed, 12) === 0);
check('target 30 -> 2 (frame-start)', resolveNearestPrecedingIndex(mixed, 30) === 2);

// ---------------------------------------------------------------------------
// 2. self-contained HTML document invariants
// ---------------------------------------------------------------------------
console.log('HTML document invariants');
const sample = {
  title: 'Sample </script> Scrub',
  metricLabel: 'cpuUsagePercent',
  selectedIndex: 1,
  points: [
    { pointId: 'p-b', label: '00:00:00.30', centiseconds: 30, metricValue: 42, image: 'data:image/png;base64,AAAA', isFrameStart: true },
    { pointId: 'p-a', label: '00:00:00.00', centiseconds: 0, metricValue: 17.5, image: 'data:image/png;base64,BBBB', isFrameStart: true }
  ]
};
const nonce = 'test-nonce-abc123';
const html = buildBenchmarkFrameScrubberHtml(sample, nonce);
check('has DOCTYPE', /^<!DOCTYPE html>/.test(html));
check('CSP carries the nonce', html.includes("script-src 'nonce-" + nonce + "'"));
check('CSP default-src none', html.includes("default-src 'none'"));
check('has JSON model island', html.includes('<script id="bfs-model" type="application/json" nonce="' + nonce + '"'));
check('runtime script carries the nonce', html.includes('<script nonce="' + nonce + '">'));
check('title < is escaped', html.includes('Sample &lt;/script> Scrub'));
const islandMatch = html.match(/<script id="bfs-model"[^>]*>([\s\S]*?)<\/script>/);
check('island present + closed', Boolean(islandMatch));
const islandText = islandMatch ? islandMatch[1] : '';
check('island has no raw </script', !islandText.toLowerCase().includes('</script'), 'raw </script found in island');
check('island < is unicode-escaped', islandText.includes('\\u003c'));
const islandModel = JSON.parse(islandText.replace(/\\u003c/g, '<'));
check('island points sorted ascending by cs', islandModel.points.map((p) => p.centiseconds).join(',') === '0,30');
check('builder preserves selectedIndex', islandModel.selectedIndex === 1);

// determinism
const htmlAgain = buildBenchmarkFrameScrubberHtml(sample, nonce);
check('build is deterministic', htmlAgain === html);

// ---------------------------------------------------------------------------
// 3a. mapper on a synthetic synchronized-review-state-v1 (hermetic, no files)
//     so this self-test is a full deterministic pass on any OS -- including
//     WIN's native-Windows cross-plane run -- with no /tmp scratch dependency.
// ---------------------------------------------------------------------------
console.log('synchronized-review-state mapper (synthetic, hermetic)');
const syntheticState = {
  schemaVersion: 'mprr-successor-shadow-dashboard-synchronized-review-state-v1',
  shellTitle: 'Synthetic Review',
  graphMetricField: 'cpuUsagePercent',
  selectedPointId: 'seg-0001-frame-0002',
  points: [
    {
      pointId: 'seg-0001-frame-0001',
      segmentOrdinal: 1,
      frameOrdinal: 1,
      benchmarkPacketTimestamp: '2026-04-12T00:00:00.000Z',
      metricValue: 17.5,
      metrics: { cpuUsagePercent: 17.5, ramUsageBytes: 1024 },
      packetDerivedImagePath: '/synthetic/frame-0001.png'
    },
    {
      pointId: 'seg-0001-frame-0002',
      segmentOrdinal: 1,
      frameOrdinal: 2,
      benchmarkPacketTimestamp: '2026-04-12T00:00:00.120Z',
      metricValue: 44.0,
      metrics: { cpuUsagePercent: 44.0, ramUsageBytes: 2048 },
      packetDerivedImagePath: '/synthetic/frame-0002.png'
    }
  ]
};
const synthResolver = (p) => 'data:image/png;base64,' + Buffer.from(p.pointId).toString('base64');
const synthModel = buildScrubberModelFromSynchronizedReviewState(syntheticState, { imageResolver: synthResolver });
check('metricLabel = graphMetricField', synthModel.metricLabel === 'cpuUsagePercent');
check('one model point per state point', synthModel.points.length === 2);
const synthCs = synthModel.points.map((p) => p.centiseconds);
check('centiseconds derived ascending [0,12]', synthCs.join(',') === '0,12', synthCs.join(','));
check('first frame-start is cs 0', synthCs[0] === 0);
check('metricValue read from metrics[graphMetricField]', synthModel.points[1].metricValue === 44.0);
check('selectedIndex resolves selectedPointId', synthModel.points[synthModel.selectedIndex].pointId === 'seg-0001-frame-0002');
check('every point has a data: image', synthModel.points.every((p) => p.image.startsWith('data:image/')));
check('synthetic document embeds data URIs', buildBenchmarkFrameScrubberHtml(synthModel, 'n').includes('data:image/png;base64,'));

// ---------------------------------------------------------------------------
// 3b. mapper on the REAL emitted state when present (bonus; writes a demo doc).
// ---------------------------------------------------------------------------
const statePath =
  process.env.VIHS_SCRUBBER_STATE ||
  '/tmp/lba-dash-linux/surface/successor-shadow-dashboard-synchronized-review-state.json';
if (existsSync(statePath)) {
  console.log('synchronized-review-state mapper (real emitted state)');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const realModel = buildScrubberModelFromSynchronizedReviewState(state);
  check('real model point count matches state', realModel.points.length === state.points.length);
  check(
    'real model centiseconds ascending',
    realModel.points.every((p, i) => i === 0 || p.centiseconds >= realModel.points[i - 1].centiseconds)
  );
  const realHtml = buildBenchmarkFrameScrubberHtml(realModel, 'demo-nonce-0001');
  check('real document embeds real PNG data URIs', realHtml.includes('data:image/png;base64,'));
  const demoOut = process.env.VIHS_SCRUBBER_DEMO_OUT || join(HERE, '.demo', 'scrubber-demo.html');
  mkdirSync(dirname(demoOut), { recursive: true });
  writeFileSync(demoOut, realHtml);
  console.log('  ..   wrote demo document -> ' + demoOut + ' (' + realHtml.length + ' bytes)');
} else {
  console.log('  ..   real emitted state not present (set VIHS_SCRUBBER_STATE to add the bonus check)');
}

// ---------------------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.error('verify-scrubber: ' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('verify-scrubber: all checks passed');
