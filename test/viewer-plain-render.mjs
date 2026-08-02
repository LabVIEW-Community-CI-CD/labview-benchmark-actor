#!/usr/bin/env node
// Maintainer RENDER proof for the DEFAULT benchmark viewer (LBA-REQ-004): load the SHIPPED media/viewer.js in a
// real DOM (jsdom) in its PLAIN configuration -- NO #lba-mpr-counter element and NO vscode webview api -- to
// prove the common case renders + scrubs with the host-facing postMessage inert (the `vscode` null branch) and
// the manual-procedure-record counter block fully inert (the `#lba-mpr-counter` absent branch). The opt-in MPR
// counter + webview-api-present paths are proven in viewer-render.mjs; this is the byte-for-byte-unchanged
// normal viewer the module comment promises when neither opt-in hook is present.
//
// Run: npm test (needs jsdom + a prior `npm run compile` to stage media/viewer.js + media/counter-render.mjs).

import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const series = [
  { t: 0, v: 40 },
  { t: 100, v: 44 },
  { t: 200, v: 58 },
  { t: 300, v: 63 },
];

const dom = new JSDOM(
  `<!DOCTYPE html><body>
   <svg id="chart" viewBox="0 0 800 240"></svg>
   <div id="readout"></div>
   <script type="application/json" id="lba-series">${JSON.stringify(series)}</script>
   </body>`,
  { pretendToBeVisual: true }
);
const { window } = dom;

// PLAIN config: no #lba-mpr-counter element, and acquireVsCodeApi ABSENT -> viewer.js `vscode` resolves to null
// (the post-to-host branches are skipped) and the counter block is inert. Stub only what a headless DOM lacks.
globalThis.window = window;
globalThis.document = window.document;
globalThis.acquireVsCodeApi = undefined;
const svg = window.document.getElementById('chart');
svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 240, right: 800, bottom: 240, x: 0, y: 0 });
svg.setPointerCapture = () => {};
svg.releasePointerCapture = () => {};

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL  ${msg}`);
    process.exit(1);
  }
}
const readout = () => window.document.getElementById('readout').textContent;

// Import the SHIPPED viewer module -> its top-level code renders + wires listeners against the jsdom globals.
await import(pathToFileURL(join(here, '..', 'media', 'viewer.js')).href);

// 1: the plain viewer renders the metric polyline + cursor line + selected dot; readout at sample 1.
assert(svg.querySelector('polyline'), 'plain viewer renders the metric polyline');
assert(svg.querySelector('line'), 'plain viewer renders the cursor line');
assert(svg.querySelector('circle'), 'plain viewer renders the selected-sample dot');
assert(/sample 1\/4\b/.test(readout()) && /t=0\b/.test(readout()), `plain viewer initial readout sample 1 t=0, got: ${readout()}`);

// 2: keyboard scrub works with NO webview api present (the vscode-null post-skip branch) -> render still updates.
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
assert(/sample 2\/4\b/.test(readout()) && /t=100\b/.test(readout()), `plain viewer ArrowRight -> sample 2 t=100 (no webview api), got: ${readout()}`);

// 3: pointer drag works with no webview api -> the render tracks, the missing api never throws.
svg.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 780, bubbles: true }));
assert(/sample 4\/4\b/.test(readout()), `plain viewer drag to the right edge -> last sample, got: ${readout()}`);

// 4: the manual-procedure-record counter block is inert when #lba-mpr-counter is absent (no element created).
assert(!window.document.getElementById('lba-mpr-counter'), 'plain viewer creates no MPR counter host');

console.log(
  'viewer-plain-render: PASS -- the default media/viewer.js renders + scrubs (keyboard + pointer) with NO webview ' +
    'api and NO MPR counter hook: the host-post + counter blocks stay inert (vscode-null + counter-absent branches).'
);
process.exit(0);
