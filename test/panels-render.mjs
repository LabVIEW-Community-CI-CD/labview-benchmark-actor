#!/usr/bin/env node
// Maintainer RENDER proof for the benchmark UI surfaces wired into the extension (LBA-REQ-004/005): load the
// SHIPPED media/ builders + the REAL staged fixtures, build each webview document, and render it in a real DOM
// (jsdom) to prove the markup actually renders -- the static single-run + trend panels AND the interactive
// vertical-line frame correlator (execute its inline runtime, scrub it, and assert the selection tracks).
//
// Run: npm test (needs jsdom + a prior `npm run compile` to stage media/).

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mediaUrl = (f) => pathToFileURL(join(here, '..', 'media', f)).href;
const mediaJson = (f) => JSON.parse(readFileSync(join(here, '..', 'media', f), 'utf8'));

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL  ${msg}`);
    process.exit(1);
  }
}

const { buildBenchmarkPanelHtml, buildTrendPanelHtml, buildCrossPlaneTrendPanelHtml, buildResourcePanelHtml, scrubberModelFromTrend } = await import(
  mediaUrl('benchmark-panels.mjs')
);
const { buildBenchmarkFrameScrubberHtml } = await import(mediaUrl('buildBenchmarkFrameScrubberHtml.mjs'));

const record = mediaJson('labview-launch-record.json');
const trend = mediaJson('labview-launch-trend.json');
const winTrend = mediaJson('labview-launch-trend-win.json');
const crossReceipt = mediaJson('cross-plane-trend-receipt.json');
const resourceRc = mediaJson('labview-launch-resource-correlation.json');
const NONCE = 'render-nonce-000000000000000000ab';

// --- 1. single-run panel (static) renders the launchMs headline, the dhash-grid frame, and stats ------------
{
  const dom = new JSDOM(buildBenchmarkPanelHtml(record, NONCE));
  const doc = dom.window.document;
  const headline = doc.querySelector('.headline');
  assert(headline && /\b2577\b/.test(headline.textContent), `run panel headline shows launchMs 2577, got: ${headline && headline.textContent}`);
  const img = doc.querySelector('img');
  assert(img && /^data:image\/svg\+xml;base64,/.test(img.getAttribute('src')), 'run panel embeds the dhash-grid frame as a data: svg image');
  const cells = [...doc.querySelectorAll('td.v')].map((td) => td.textContent);
  assert(cells.includes('481'), `run panel shows the capture stats (481 frames), got cells: ${cells.join(' | ')}`);
  assert(doc.body.textContent.includes(record.frames[0].perceptualFingerprint), 'run panel shows the UI-READY pin hex');
  assert(!doc.querySelector('script'), 'run panel is fully static (no script element)');
}

// --- 2. trend panel (static) renders the verdict badge, the run chart, and the value labels -----------------
{
  const dom = new JSDOM(buildTrendPanelHtml(trend, NONCE));
  const doc = dom.window.document;
  const badge = doc.querySelector('.badge');
  assert(badge && badge.textContent.trim() === 'PASS' && badge.classList.contains('pass'), `trend panel shows the PASS badge, got: ${badge && badge.textContent}`);
  const svg = doc.querySelector('svg.chart');
  assert(svg, 'trend panel renders the run-series svg chart');
  assert(svg.querySelectorAll('circle').length === trend.values.length + 1, `a marker per run (${trend.values.length}) + the latest ring`);
  assert(svg.querySelector('polyline'), 'trend panel draws the series polyline');
  for (const v of [trend.values[0], trend.values[trend.values.length - 1]]) {
    assert(svg.textContent.includes(String(v)), `trend chart labels run value ${v}`);
  }
  assert(doc.body.textContent.includes(`${trend.slopeMsPerRun} ms/run`), 'trend panel shows the slope');
}

// --- 2b. cross-plane trend panel (static) overlays both series + witnessed deltas + both verdicts -----------
{
  const dom = new JSDOM(buildCrossPlaneTrendPanelHtml(crossReceipt, winTrend, trend, NONCE));
  const doc = dom.window.document;
  const svg = doc.querySelector('svg.chart');
  assert(svg, 'cross-plane panel renders the overlay chart');
  assert(svg.querySelectorAll('polyline').length === 2, 'cross-plane panel overlays BOTH plane series');
  assert(svg.querySelectorAll('circle').length === winTrend.values.length + trend.values.length, 'a marker per run on both planes');
  const badge = doc.querySelector('.badge');
  assert(badge && badge.textContent.trim() === crossReceipt.verdict, `cross-plane verdict badge (${crossReceipt.verdict})`);
  assert(doc.body.textContent.includes(String(crossReceipt.witness.meanDeltaMs)), 'cross-plane panel shows the witnessed mean delta');
  assert(doc.body.textContent.includes('vmware-vnc') && doc.body.textContent.includes('vbox-vnc'), 'cross-plane panel names both hypervisors');
  assert(!doc.querySelector('script'), 'cross-plane panel is fully static');
}

// --- 2d. resource-correlation panel (static) renders CPU/RAM/disk sparklines split at the settle trigger -----
{
  const dom = new JSDOM(buildResourcePanelHtml(resourceRc, NONCE));
  const doc = dom.window.document;
  assert(doc.querySelectorAll('svg').length === 3, 'resource panel renders a CPU/RAM/disk sparkline each');
  assert(doc.querySelectorAll('svg polyline').length === 3, 'each metric sparkline draws its series polyline');
  assert(doc.body.textContent.includes(`${resourceRc.launchMs} ms launch`), 'resource panel shows the launchMs badge');
  assert(/CPU %/.test(doc.body.textContent) && /RAM MB/.test(doc.body.textContent) && /Disk %/.test(doc.body.textContent), 'resource panel labels all three metrics');
  assert(!doc.querySelector('script'), 'resource panel is fully static');
}

// --- 3. frame correlator (interactive) renders + scrubs; the selection tracks the vertical slider -----------
{
  const settled = record.frames.find((f) => f && f.settled) || record.frames[0];
  const model = scrubberModelFromTrend(trend, { pinDhash: settled.perceptualFingerprint });
  const html = buildBenchmarkFrameScrubberHtml(model, NONCE);
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const root = doc.getElementById('bfs-root');
  assert(root, 'scrubber mounts #bfs-root');
  const slider = doc.querySelector('input.bfs-slider');
  assert(slider && slider.type === 'range', 'scrubber renders the vertical range slider');
  const graph = doc.querySelector('svg.bfs-graph');
  assert(graph && graph.querySelector('polyline') && graph.querySelectorAll('circle').length === trend.values.length, `scrubber graph plots ${trend.values.length} run points`);
  const frameImg = doc.querySelector('.bfs-frames img.bfs-img');
  assert(frameImg && /^data:image\/svg\+xml;base64,/.test(frameImg.getAttribute('src')), 'scrubber lower pane shows the captured dhash-grid frame');
  // selection starts at the latest run (selectedIndex = n-1)
  assert(root.getAttribute('data-selected-index') === String(trend.values.length - 1), `scrubber selects the latest run initially, got ${root.getAttribute('data-selected-index')}`);
  const readout = doc.querySelector('.bfs-readout');
  assert(readout && /run 5\b/.test(readout.textContent) && /launchMs/.test(readout.textContent), `readout correlates the run + metric, got: ${readout && readout.textContent}`);

  // scrub earlier with ArrowDown (earlier in time) -> selection moves to run 4, then back with ArrowUp.
  const key = (k) => doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  key('ArrowDown');
  assert(root.getAttribute('data-selected-index') === String(trend.values.length - 2), `ArrowDown scrubs to run 4, got ${root.getAttribute('data-selected-index')}`);
  assert(/run 4\b/.test(doc.querySelector('.bfs-readout').textContent), 'readout updates to run 4 after scrubbing');
  key('ArrowUp');
  assert(root.getAttribute('data-selected-index') === String(trend.values.length - 1), 'ArrowUp scrubs back to run 5');
}

console.log(
  'panels-render: PASS -- the single-run + trend panels render their real launchMs/verdict/stats, and the ' +
    'frame-correlator scrubber mounts its graph + slider + dhash-grid frame and tracks the scrub selection (jsdom).'
);
process.exit(0);
