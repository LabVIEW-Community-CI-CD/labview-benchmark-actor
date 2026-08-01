/**
 * Real-pointer interaction proof for the frame-correlator CLICK-TO-MARKER wiring (LBA-REQ-011, extended).
 * Mirrors experiments/dashboard-slider/scrubberInteraction.playwright.cjs: it builds the SHIPPED document from
 * frame-correlator.mjs and drives REAL Chromium pointer events to prove the user-facing behavior --
 *   - a CLICK (pointer down+up without drag) drops exactly one marker, grabs the nearest frame image within the
 *     tolerance, and posts { type:'frame-marker', marker } to the host (stubbed acquireVsCodeApi);
 *   - a DRAG (down, move past the click slop, up) scrubs the selected frame and drops NO marker;
 *   - a second click drops a second marker.
 * Emits a receipt to fixtures/frame-correlator-markers-playwright-receipt.json (committed; a local gate replays it).
 *
 * Hosted CI stays browser-free -- this driver is NOT in package.json / npm test. Run with a cached Chromium:
 *   dir=$(mktemp -d); (cd "$dir" && npm init -y >/dev/null && npm i playwright >/dev/null)
 *   NODE_PATH="$dir/node_modules" node experiments/mprr-capture-ring/frameCorrelatorMarkers.playwright.cjs
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

let failures = 0;
const checks = [];
function check(name, cond, detail) {
  checks.push({ name, pass: !!cond, detail: detail || undefined });
  if (cond) { console.log('  ok   ' + name); } else { failures += 1; console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
}

// Three distinct 1x1 PNGs (red / green / blue) so the scrubbed frame is byte-distinguishable per selection.
const IMG = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA0eEd6QAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYPhfDwAEhQGAiHqV/AAAAABJRU5ErkJggg=='
];

async function main() {
  const mod = await import(pathToFileURL(path.join(__dirname, 'frame-correlator.mjs')).href);
  const N = 13;
  const frames = [];
  for (let i = 0; i < N; i += 1) {
    frames.push({ index: i, tMs: Math.round((i * 1000) / 12), cpuPct: 10 + (i % 5) * 8, ramMb: 100 + i, diskPct: 2 + (i % 3), imageSrc: 'data:image/png;base64,' + IMG[i % IMG.length] });
  }
  const html = mod.buildFrameCorrelatorHtml({ title: 'Frame Correlator Marker Proof', fps: 12, selectedIndex: 0, frames, markerToleranceMs: 200 }, 'proof-nonce-0001', '');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  // Inject a nonce'd host stub (CSP permits the matching nonce) so it runs BEFORE the runtime defines `vscode`,
  // proving the real click -> postMessage({type:'frame-marker'}) path in a browser.
  const stub = '<script nonce="proof-nonce-0001">window.__msgs=[];window.acquireVsCodeApi=function(){return{postMessage:function(m){window.__msgs.push(m);},getState:function(){},setState:function(){}};};</script>';
  await page.setContent(html.replace('<body>', '<body>' + stub), { waitUntil: 'load' });

  const attr = (name) => page.evaluate((n) => document.getElementById('fc-root').getAttribute(n), name);
  const msgs = () => page.evaluate(() => (window.__msgs ? window.__msgs.slice() : []));
  const sel = () => page.evaluate(() => document.getElementById('fc-root').getAttribute('data-selected-index'));
  const box = await page.locator('#fc-graph').boundingBox();
  const at = (fx) => ({ x: box.x + box.width * fx, y: box.y + box.height * 0.5 });

  check('render: no markers initially', (await attr('data-marker-count')) === null || (await attr('data-marker-count')) === '0');

  // CLICK at 30% -> one marker, image admitted, posted to host.
  const c1 = at(0.30);
  await page.mouse.click(c1.x, c1.y);
  await page.waitForTimeout(40);
  check('click drops exactly one marker', (await attr('data-marker-count')) === '1', 'count=' + (await attr('data-marker-count')));
  check('click marker image admitted within tolerance', (await attr('data-last-marker-admitted')) === 'true');
  const m1 = await msgs();
  check('click posts a frame-marker to the host', m1.length === 1 && m1[0] && m1[0].type === 'frame-marker' && !!m1[0].marker, JSON.stringify(m1[0] || null));

  const selBefore = await sel();

  // DRAG 30% -> 78% -> scrubs, drops NO new marker.
  const d0 = at(0.30);
  const d1 = at(0.78);
  await page.mouse.move(d0.x, d0.y);
  await page.mouse.down();
  await page.mouse.move(d1.x, d1.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(40);
  check('drag scrubs the selected frame', (await sel()) !== selBefore, selBefore + ' -> ' + (await sel()));
  check('drag drops no new marker', (await attr('data-marker-count')) === '1');
  check('drag posts no marker to the host', (await msgs()).length === 1);

  // second CLICK at 62% -> second marker.
  const c2 = at(0.62);
  await page.mouse.click(c2.x, c2.y);
  await page.waitForTimeout(40);
  check('second click drops a second marker', (await attr('data-marker-count')) === '2');
  check('two markers posted to host', (await msgs()).length === 2);

  check('no page errors', pageErrors.length === 0, pageErrors.join('; '));

  await browser.close();

  const receipt = {
    schema: 'labview-benchmark-actor/frame-correlator-markers-receipt@v1',
    requirement: 'LBA-REQ-011',
    testItem: 'T-011',
    producedBy: process.platform === 'win32' ? 'WIN' : (process.env.CODESPACES ? 'CODESPACE' : 'LINUX'),
    engine: 'headless chromium (playwright)',
    producedAt: new Date().toISOString(),
    pass: failures === 0,
    frames: N,
    markerToleranceMs: 200,
    checks
  };
  const out = path.join(__dirname, 'fixtures', 'frame-correlator-markers-playwright-receipt.json');
  fs.writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n');
  console.log('\nwrote ' + out + '  pass=' + receipt.pass + '  (' + checks.filter((c) => c.pass).length + '/' + checks.length + ')');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
