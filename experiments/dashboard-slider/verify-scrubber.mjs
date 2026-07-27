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
// 3. mapper against the real emitted Linux synchronized-review state
// ---------------------------------------------------------------------------
console.log('synchronized-review-state mapper');
const statePath =
  process.env.VIHS_SCRUBBER_STATE ||
  '/tmp/lba-dash-linux/surface/successor-shadow-dashboard-synchronized-review-state.json';
if (existsSync(statePath)) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  // Deterministic image resolver so the test does not depend on PNG bytes.
  const model = buildScrubberModelFromSynchronizedReviewState(state, {
    imageResolver: (p) => 'data:image/png;base64,' + Buffer.from(p.pointId).toString('base64')
  });
  check('model metricLabel = state graphMetricField', model.metricLabel === state.graphMetricField);
  check('model has one point per state point', model.points.length === state.points.length);
  const cs = model.points.map((p) => p.centiseconds);
  check('centiseconds ascending', cs.every((v, i) => i === 0 || v >= cs[i - 1]), cs.join(','));
  check('first frame-start is cs 0', cs[0] === 0);
  check('selectedIndex resolves state.selectedPointId', model.points[model.selectedIndex].pointId === state.selectedPointId);
  check('every point has a data: image', model.points.every((p) => p.image.startsWith('data:image/')));

  // Build the real document from real PNG bytes and emit a demo for the
  // follow-up browser proof + manual inspection.
  const realModel = buildScrubberModelFromSynchronizedReviewState(state);
  const realHtml = buildBenchmarkFrameScrubberHtml(realModel, 'demo-nonce-0001');
  check('real document embeds real PNG data URIs', realHtml.includes('data:image/png;base64,'));
  const demoOut = process.env.VIHS_SCRUBBER_DEMO_OUT || join(HERE, '.demo', 'scrubber-demo.html');
  mkdirSync(dirname(demoOut), { recursive: true });
  writeFileSync(demoOut, realHtml);
  console.log('  ..   wrote demo document -> ' + demoOut + ' (' + realHtml.length + ' bytes)');
} else {
  console.log('  skip real-state mapper (no state at ' + statePath + ')');
}

// ---------------------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.error('verify-scrubber: ' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('verify-scrubber: all checks passed');
