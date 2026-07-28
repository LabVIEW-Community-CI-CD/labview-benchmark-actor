#!/usr/bin/env node
// MAINTAINER deterministic-screenshot harness (operator direction: "leverage deterministic screenshots ... for
// the next agent to conduct deterministic visual inspection for repeatability to compare both results"). NOT a
// CI gate -- it needs a browser (kept out of the .vsix + hosted CI, like viewer-render.mjs).
//
// It renders the SHIPPED benchmark viewer (../media/viewer.js importing ../media/viewerCursor.mjs) over a FIXED
// mprr short-packet series (from the committed fixture via the absorbed ring core), drives the time cursor to a
// FIXED sample, and screenshots the #chart SVG. It captures the render TWICE in fresh contexts and asserts the
// two PNGs are BYTE-IDENTICAL (SHA-256) -- per-plane repeatability. It also records the deterministic
// seriesHash (the cross-plane anchor: identical packets => identical series on BOTH planes, even though
// cross-OS pixel-identity is not guaranteed). Run the SAME script on Windows-native to produce the WIN receipt;
// the two receipts feed the cross-plane comparison.
//
// Run: cd playwright && npm install && npx playwright install chromium && node screenshot.mjs
//   (Requires `npm run compile` in the repo root first so media/viewerCursor.mjs is staged.)
//   Plane is auto-detected (win32 => WIN, else LINUX); override with LBA_PLANE.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { ingestShortPackets } from '../experiments/mprr-ring/mprrRing.mjs';
import { projectViewerSeries, seriesHash } from '../experiments/mprr-ring/mprrViewerSeries.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const plane = process.env.LBA_PLANE || (process.platform === 'win32' ? 'WIN' : 'LINUX');

if (!existsSync(join(repo, 'media', 'viewerCursor.mjs'))) {
  throw new Error('media/viewerCursor.mjs missing -- run `npm run compile` in the repo root first.');
}

// Deterministic input: the committed mprr fixture -> ring ingest -> the exact [{ t, v }] the viewer renders.
const fixture = JSON.parse(readFileSync(join(repo, 'experiments', 'mprr-ring', 'fixtures', 'short-packet-run.json'), 'utf8'));
const ingest = ingestShortPackets(fixture.packets, {
  blockDurationTicks: fixture.blockDurationTicks,
  capacityBytes: fixture.capacityBytes,
});
const series = projectViewerSeries(ingest, { metric: 'cumulativeBytes' });
const hash = seriesHash(series);
const N = series.length;
const rightsToMid = Math.floor((N - 1) / 2); // fixed, deterministic cursor target (mid-run sample)

// Fixed viewport + device scale so the raster is identical across the two captures on this plane.
const VIEWPORT = { width: 900, height: 320 };
const DEVICE_SCALE = 1;

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{animation:none!important;transition:none!important;caret-color:transparent!important}</style></head>
<body style="margin:0;background:#1e1e1e">
<svg id="chart" viewBox="0 0 800 240" style="width:800px;height:240px;display:block"></svg>
<div id="readout"></div>
<script type="application/json" id="lba-series">${JSON.stringify(series)}</script>
<script type="module" src="/media/viewer.js"></script>
</body></html>`;

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
    return;
  }
  const file = join(repo, url.replace(/^\/+/, ''));
  if (file.startsWith(repo) && existsSync(file)) {
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
    return;
  }
  res.writeHead(404);
  res.end('nf');
});

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL ' + msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
}

// One full capture: fresh context, deterministic driving, screenshot the #chart SVG -> PNG buffer.
async function captureOnce(browser, port) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE,
    reducedMotion: 'reduce',
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') {
      consoleErrors.push(m.text());
    }
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#chart polyline', { timeout: 5000 });
  // Drive the cursor to a FIXED sample so every capture is identical.
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('Home');
  for (let i = 0; i < rightsToMid; i += 1) {
    await page.keyboard.press('ArrowRight');
  }
  const readout = await page.textContent('#readout');
  assert(new RegExp(`sample ${rightsToMid + 1}/${N}\\b`).test(readout), `cursor at fixed sample, got: ${readout}`);
  const png = await page.locator('#chart').screenshot({ animations: 'disabled' });
  assert(consoleErrors.length === 0, 'no console errors: ' + consoleErrors.join(' | '));
  await context.close();
  return png;
}

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch();
try {
  const pngA = await captureOnce(browser, port);
  const pngB = await captureOnce(browser, port);
  const shaA = createHash('sha256').update(pngA).digest('hex');
  const shaB = createHash('sha256').update(pngB).digest('hex');
  const repeatable = shaA === shaB;
  assert(repeatable, `screenshot not byte-identical across runs: ${shaA} vs ${shaB}`);

  const artifactsDir = join(here, '.artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  const pngPath = join(artifactsDir, `mprr-viewer-${plane}.png`);
  writeFileSync(pngPath, pngA);

  const receipt = {
    schema: 'labview-benchmark-actor/mprr-viewer-screenshot-receipt@v1',
    producedBy: plane,
    engine: 'headless chromium (playwright)',
    producedAt: new Date().toISOString(),
    fixture: 'experiments/mprr-ring/fixtures/short-packet-run.json',
    metric: 'cumulativeBytes',
    seriesHash: hash,
    sampleCount: N,
    selectedSample: rightsToMid + 1,
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE,
    captureCount: 2,
    pngSha256: shaA,
    pngBytes: pngA.length,
    repeatable,
    pngArtifact: `playwright/.artifacts/mprr-viewer-${plane}.png`,
  };
  writeFileSync(join(here, `screenshot-receipt-${plane}.json`), JSON.stringify(receipt, null, 2) + '\n');
  console.log(
    `mprr-viewer screenshot (${plane}): PASS -- 2/2 captures byte-identical.\n` +
      `  seriesHash=${hash}\n  pngSha256=${shaA} (${pngA.length} bytes)\n` +
      `  wrote playwright/screenshot-receipt-${plane}.json + playwright/.artifacts/mprr-viewer-${plane}.png`
  );
} finally {
  await browser.close();
  server.close();
}
