#!/usr/bin/env node
// MAINTAINER browser render proof for LBA-REQ-004 (NOT a CI gate; needs a browser). Loads the SHIPPED webview
// assets -- ../media/viewer.js importing ../media/viewerCursor.mjs -- in a REAL headless Chromium via
// Playwright, and proves the benchmark metric SVG RENDERS and that a REAL pointer drag and Left/Right/Home/End
// keys move the time cursor over the run window (the cursor line + readout update). Chromium is the same
// engine the VS Code extension-host webview renders in, so this is the strongest render proof short of a live
// extension host. Kept out of the shipped .vsix + hosted CI (browser-free); mirrors vi-history-suite's
// vagrant/playwright viewer harness.
//
// Run: cd playwright && npm install && npx playwright install chromium && node viewer-render.mjs
// (Requires `npm run compile` in the repo root first so media/viewerCursor.mjs is staged.)

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const series = [
  { t: 0, v: 40 }, { t: 100, v: 44 }, { t: 200, v: 58 }, { t: 300, v: 63 },
  { t: 400, v: 55 }, { t: 500, v: 71 }, { t: 600, v: 66 }, { t: 700, v: 48 },
];

if (!existsSync(join(repo, 'media', 'viewerCursor.mjs'))) {
  throw new Error('media/viewerCursor.mjs missing -- run `npm run compile` in the repo root first.');
}

// The page mirrors the extension's webview: the series data block + the shipped viewer.js as a module.
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">
<svg id="chart" viewBox="0 0 800 240" style="width:800px;height:240px;display:block"></svg>
<div id="readout"></div>
<script type="application/json" id="lba-series">${JSON.stringify(series)}</script>
<script type="module" src="/media/viewer.js"></script>
</body></html>`;

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

// Serve the repo so viewer.js's `import './viewerCursor.mjs'` (same /media dir) resolves like a real webview.
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

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch();
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 320 } });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') {
      consoleErrors.push(m.text());
    }
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });

  // 1: the shipped module loaded + RENDERED the SVG (metric polyline + cursor line + selected dot).
  await page.waitForSelector('#chart polyline', { timeout: 5000 });
  assert(await page.$('#chart line'), 'cursor line rendered');
  assert(await page.$('#chart circle'), 'selected-sample dot rendered');
  const initial = await page.textContent('#readout');
  assert(/sample 1\/8\b/.test(initial) && /t=0\b/.test(initial), `initial readout sample 1 t=0, got: ${initial}`);
  results.push({ name: 'render', pass: true, detail: initial });

  // 2: real KEYBOARD -> ArrowRight/End/Home move the cursor over the run window.
  await page.keyboard.press('ArrowRight');
  assert(/sample 2\/8\b/.test(await page.textContent('#readout')), 'ArrowRight -> sample 2');
  await page.keyboard.press('End');
  assert(/sample 8\/8\b/.test(await page.textContent('#readout')), 'End -> sample 8');
  await page.keyboard.press('Home');
  assert(/sample 1\/8\b/.test(await page.textContent('#readout')), 'Home -> sample 1');
  results.push({ name: 'keyboard', pass: true });

  // 3: a REAL POINTER DRAG across the chart snaps the cursor to a late sample AND moves the cursor line x.
  const box = await page.$eval('#chart', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const lineX = () => page.$eval('#chart line', (l) => l.getAttribute('x1'));
  const xBefore = await lineX();
  await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.92, box.y + box.h * 0.5, { steps: 8 });
  await page.mouse.up();
  const afterDrag = await page.textContent('#readout');
  assert(/sample [78]\/8\b/.test(afterDrag), `drag right -> late sample, got: ${afterDrag}`);
  assert((await lineX()) !== xBefore, 'cursor line x moved on drag (render updated)');
  results.push({ name: 'pointer-drag', pass: true, detail: afterDrag });

  assert(consoleErrors.length === 0, 'no console errors: ' + consoleErrors.join(' | '));
  results.push({ name: 'no-console-errors', pass: true });

  console.log(
    'viewer-render (browser): PASS -- the shipped media/viewer.js renders the metric svg + draggable time ' +
      'cursor and tracks real pointer + keyboard input in headless Chromium.'
  );
  const receipt = {
    schema: 'labview-benchmark-actor/viewer-render-browser-receipt@v1',
    requirement: 'LBA-REQ-004',
    testItem: 'T-004',
    producedBy: 'LINUX',
    engine: 'headless chromium (playwright)',
    producedAt: new Date().toISOString(),
    pass: true,
    checks: results,
  };
  writeFileSync(join(here, 'viewer-render-browser-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log('wrote receipt -> playwright/viewer-render-browser-receipt.json');
} finally {
  await browser.close();
  server.close();
}
