#!/usr/bin/env node
// Maintainer RENDER proof for the LBA-REQ-004 benchmark viewer (T-004): load the SHIPPED media/viewer.js in a
// real DOM (jsdom) and prove it actually RENDERS the metric SVG + a draggable time cursor and RESPONDS to
// pointer + keyboard input by moving the cursor over the run window -- executing the real browser presentation
// code, not just asserting the HTML shape (that is extension-activation.mjs's job). The cursor math is the
// proven viewerCursor core (verify-viewer-cursor.mjs 5/5), imported VERBATIM by viewer.js; this proves the DOM
// wiring around it. The interactive render inside a real VS Code host is the remaining maintainer step.
//
// Run: npm test (needs jsdom + a prior `npm run compile` to stage media/viewerCursor.mjs).

import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const series = [
  { t: 0, v: 40 },
  { t: 100, v: 44 },
  { t: 200, v: 58 },
  { t: 300, v: 63 },
  { t: 400, v: 55 },
  { t: 500, v: 71 },
  { t: 600, v: 66 },
  { t: 700, v: 48 },
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

// Expose the DOM as globals so the shipped browser module runs against it, then stub what a headless DOM lacks:
// a plotted width for the pointer math, pointer capture, and the vscode webview api (absent -> viewer.js no-ops
// the postMessage). viewer.js already guards capture in try/catch; the no-ops just exercise the happy path.
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
function pointerDown(clientX) {
  svg.dispatchEvent(new window.MouseEvent('pointerdown', { clientX, bubbles: true }));
}
function key(k) {
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

// Import the SHIPPED viewer module -> its top-level code renders + wires listeners against the jsdom globals.
await import(pathToFileURL(join(here, '..', 'media', 'viewer.js')).href);

// 1: initial render -> the SVG carries the metric polyline + a cursor line + the selected dot; readout sample 1.
assert(svg.querySelector('polyline'), 'viewer renders the metric polyline');
assert(svg.querySelector('line'), 'viewer renders the cursor line');
assert(svg.querySelector('circle'), 'viewer renders the selected-sample dot');
assert(/sample 1\/8\b/.test(readout()) && /t=0\b/.test(readout()), `initial readout at sample 1 t=0, got: ${readout()}`);

// 2: keyboard -> ArrowRight steps to sample 2 (t=100); End jumps to the last sample (t=700); Home back to t=0.
key('ArrowRight');
assert(/sample 2\/8\b/.test(readout()) && /t=100\b/.test(readout()), `ArrowRight -> sample 2 t=100, got: ${readout()}`);
key('End');
assert(/sample 8\/8\b/.test(readout()) && /t=700\b/.test(readout()), `End -> sample 8 t=700, got: ${readout()}`);
key('Home');
assert(/sample 1\/8\b/.test(readout()) && /t=0\b/.test(readout()), `Home -> sample 1 t=0, got: ${readout()}`);

// 3: pointer drag to the right edge snaps the cursor to the last sample AND moves the cursor line x (the
//    interaction updates the RENDER, not just the readout text).
const cursorLine = svg.querySelector('line');
const xBefore = cursorLine.getAttribute('x1');
pointerDown(780); // beyond the plot right edge -> setPointer clamps to the last sample
assert(/sample 8\/8\b/.test(readout()), `drag to right edge -> last sample, got: ${readout()}`);
assert(cursorLine.getAttribute('x1') !== xBefore, 'the cursor line moved on drag (render updated)');

// 4: a drag to ~42% of the plot snaps to the nearest interior sample (t=300, sample 4).
pointerDown(32 + 0.42 * (800 - 64));
assert(/sample 4\/8\b/.test(readout()) && /t=300\b/.test(readout()), `drag to ~42% -> sample 4 t=300, got: ${readout()}`);

console.log(
  'viewer-render: PASS -- media/viewer.js renders the metric svg + draggable time cursor and tracks pointer + ' +
    'keyboard input in a real DOM (jsdom); cursor math is the proven viewerCursor core.'
);
process.exit(0);
