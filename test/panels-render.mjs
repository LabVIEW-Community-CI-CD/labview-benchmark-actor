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

const { buildBenchmarkPanelHtml, buildTrendPanelHtml, buildCrossPlaneTrendPanelHtml, buildResourcePanelHtml, buildCrossPlaneResourcePanelHtml } = await import(
  mediaUrl('benchmark-panels.mjs')
);
const { buildLaunchCapture } = await import(mediaUrl('launch-capture.mjs'));
const { buildFrameCorrelatorHtml } = await import(mediaUrl('frame-correlator.mjs'));

const record = mediaJson('labview-launch-record.json');
const trend = mediaJson('labview-launch-trend.json');
const winTrend = mediaJson('labview-launch-trend-win.json');
const crossReceipt = mediaJson('cross-plane-trend-receipt.json');
const resourceRc = mediaJson('labview-launch-resource-correlation.json');
const crossResourceReceipt = mediaJson('resource-cross-plane-receipt.json');
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

// --- 2e. cross-plane resource-agreement panel (static): WIN vs LINUX deltas + RAM agreement headline ---------
{
  const dom = new JSDOM(buildCrossPlaneResourcePanelHtml(crossResourceReceipt, NONCE));
  const doc = dom.window.document;
  assert(doc.querySelectorAll('svg').length === 6, 'cross-plane resource panel draws a WIN + LINUX delta bar per metric');
  const badge = doc.querySelector('h2 .badge');
  assert(badge && badge.textContent.trim() === crossResourceReceipt.verdict, `cross-plane resource verdict badge (${crossResourceReceipt.verdict})`);
  assert(doc.body.textContent.includes(String(crossResourceReceipt.launchDeltaMs)), 'shows the cross-plane launch delta');
  assert(/substrate-independent/.test(doc.body.textContent), 'shows the RAM-agreement headline');
  assert(!doc.querySelector('script'), 'cross-plane resource panel is fully static');
}

// --- 3. frame correlator (interactive): CPU/RAM/disk curves + the real screenshot track the red scrub line --
{
  const startMs = 1_700_000_000_000;
  const N = 6;
  const frames = Array.from({ length: N }, (_, i) => ({
    index: i,
    imageFile: `frame-${String(i).padStart(5, '0')}.png`,
    imageBytes: 1000 + i,
    ms: startMs + Math.round((i * 1000) / 12),
  }));
  const resourceSamples = Array.from({ length: N }, (_, i) => ({
    ms: startMs + Math.round((i * 1000) / 12),
    cpuPct: 10 + i * 5,
    ramMb: 2000 + i * 10,
    diskPct: i * 3,
  }));
  const cap = buildLaunchCapture({ frames, resourceSamples, startMs, fps: 12, meta: { workload: 'labview-launch', plane: 'WIN' } });
  assert(cap.frameCount === N, `capture assembles ${N} frames, got ${cap.frameCount}`);
  assert(cap.dualPacket && cap.dualPacket.authoritative === true, 'capture dual-packet is authoritative (all long payloads admitted)');
  // a 1x1 transparent PNG data URI stands in for the VM-local webview screenshot URI.
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const model = {
    title: 'LabVIEW launch — frame correlator',
    fps: cap.fps,
    selectedIndex: 0,
    frames: cap.frames.map((f) => ({ index: f.index, tMs: f.tMs, cpuPct: f.cpuPct, ramMb: f.ramMb, diskPct: f.diskPct, imageSrc: px })),
  };
  const html = buildFrameCorrelatorHtml(model, NONCE, 'vscode-webview://render');
  assert(/Content-Security-Policy/.test(html) && html.includes(`nonce-${NONCE}`), 'correlator sets a nonce CSP');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const root = doc.getElementById('fc-root');
  assert(root, 'correlator mounts #fc-root');
  const svg = doc.getElementById('fc-graph');
  assert(svg && svg.tagName.toLowerCase() === 'svg', 'correlator renders the metric graph svg');
  assert(svg.querySelectorAll('polyline').length === 3, `correlator plots CPU + RAM + disk polylines, got ${svg.querySelectorAll('polyline').length}`);
  const redline = svg.querySelector('line[stroke="#ff3b30"]');
  assert(redline, 'correlator renders the draggable red cursor line');
  const img = doc.getElementById('fc-img');
  assert(img && img.getAttribute('src') === px, 'correlator lower pane shows the captured screenshot of the selected frame');
  assert(root.getAttribute('data-selected-index') === '0', `correlator selects frame 0 initially, got ${root.getAttribute('data-selected-index')}`);
  const readout = doc.getElementById('fc-readout');
  assert(readout && /frame 1\/6\b/.test(readout.textContent), `readout shows the frame index, got: ${readout && readout.textContent}`);

  // scrub with the keyboard: ArrowRight -> frame 2, End -> last frame, Home -> frame 1; the red line stays vertical.
  const key = (k) => doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  key('ArrowRight');
  assert(root.getAttribute('data-selected-index') === '1', `ArrowRight scrubs to frame 2, got ${root.getAttribute('data-selected-index')}`);
  assert(redline.getAttribute('x1') === redline.getAttribute('x2'), 'red line stays vertical while scrubbing');
  key('End');
  assert(root.getAttribute('data-selected-index') === String(N - 1), `End scrubs to the last frame, got ${root.getAttribute('data-selected-index')}`);
  key('Home');
  assert(root.getAttribute('data-selected-index') === '0', 'Home scrubs back to frame 0');
}

console.log(
  'panels-render: PASS -- the single-run + trend panels render their real launchMs/verdict/stats, and the ' +
    'frame correlator renders its CPU/RAM/disk curves + captured screenshot and tracks the red scrub line (jsdom).'
);
process.exit(0);
