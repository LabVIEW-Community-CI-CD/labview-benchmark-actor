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
   <div id="lba-mpr-counter" data-case="TC-03"></div>
   <script type="application/json" id="lba-series">${JSON.stringify(series)}</script>
   </body>`,
  { pretendToBeVisual: true }
);
const { window } = dom;

// Expose the DOM as globals so the shipped browser module runs against it, then stub what a headless DOM lacks:
// a plotted width for the pointer math, pointer capture, and the vscode webview api. Here the api is PRESENT
// (capturing) so BOTH the cursor's selection posts AND the MPR counter's ground-truth posts are exercised, and
// setInterval is shimmed to CAPTURE the counter tick so we drive it deterministically (never wait on a timer).
globalThis.window = window;
globalThis.document = window.document;
let mprTickCb = null;
globalThis.setInterval = (cb) => { mprTickCb = cb; return 0; };
const posted = [];
globalThis.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m), setState() {}, getState() {} });
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

// 4b: ArrowLeft steps back; a non-arrow key is a no-op; and a full pointer drag (down -> move -> up -> move)
//     exercises the drag-move + release + drag-ended branches.
key('ArrowLeft'); // from sample 4 -> sample 3 (t=200)
assert(/sample 3\/8\b/.test(readout()) && /t=200\b/.test(readout()), `ArrowLeft -> sample 3 t=200, got: ${readout()}`);
const beforeNoop = readout();
key('a'); // a non-navigation key: the handler returns without moving the cursor
assert(readout() === beforeNoop, 'a non-arrow key does not move the cursor');
svg.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 32, bubbles: true })); // left edge -> sample 1
assert(/sample 1\/8\b/.test(readout()), `pointerdown at the left edge -> sample 1, got: ${readout()}`);
svg.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 780, bubbles: true })); // dragging -> tracks to the last sample
assert(/sample 8\/8\b/.test(readout()), `pointermove while dragging tracks to the last sample, got: ${readout()}`);
svg.dispatchEvent(new window.MouseEvent('pointerup', { clientX: 780, bubbles: true })); // release -> dragging=false
svg.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 32, bubbles: true })); // NOT dragging -> no change
assert(/sample 8\/8\b/.test(readout()), 'pointermove after pointerup does not move the cursor (drag released)');

// 4c: pointerup release is BEST-EFFORT -- if releasePointerCapture throws, the handler swallows it and the
//     viewer stays responsive (the try/catch guard around the capture release).
svg.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 400, bubbles: true }));
svg.releasePointerCapture = () => { throw new Error('capture already released'); };
svg.dispatchEvent(new window.MouseEvent('pointerup', { clientX: 400, bubbles: true })); // the catch swallows the throw
key('Home');
assert(/sample 1\/8\b/.test(readout()), 'the viewer survives a releasePointerCapture failure on pointerup and still responds to keys');

// 4d: pointerdown capture is BEST-EFFORT too -- if setPointerCapture throws, the pointerdown handler swallows
//     it (the try/catch around the capture acquire) and STILL selects, so the viewer works where the host DOM
//     lacks pointer capture.
svg.setPointerCapture = () => { throw new Error('pointer capture unsupported'); };
svg.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 780, bubbles: true }));
assert(/sample 8\/8\b/.test(readout()), 'the viewer survives a setPointerCapture failure on pointerdown and still selects');
svg.setPointerCapture = () => {};

// 4e: the shipped viewerCursor core fails CLOSED on malformed host input (its assert guard) -- an empty axis, a
//     non-monotonic axis, and an unknown jump target all throw rather than silently selecting out of bounds.
const vc = await import(pathToFileURL(join(here, '..', 'media', 'viewerCursor.mjs')).href);
let cursorGuardThrows = 0;
for (const bad of [() => vc.createCursor([]), () => vc.createCursor([5, 3, 4]), () => vc.jump(vc.createCursor([0, 1]), 'middle')]) {
  try { bad(); } catch { cursorGuardThrows += 1; }
}
assert(cursorGuardThrows === 3, 'viewerCursor rejects an empty axis, a non-monotonic axis, and an unknown jump target (fails closed)');

// 5: MPR counter feature (opt-in) -- with a #lba-mpr-counter present, the viewer ticks a monotonic plain-digit
//    counter (the exact known-digit-reader glyphs) into it and posts each {counter,caseId} to the host as the
//    deterministic-record correlation ground truth. Invoke the captured interval callback to tick it.
assert(mprTickCb, 'viewer scheduled the MPR counter tick when #lba-mpr-counter is present');
mprTickCb();
const mprHost = window.document.getElementById('lba-mpr-counter');
const counterEl = mprHost.querySelector('svg');
assert(counterEl && counterEl.getAttribute('shape-rendering') === 'crispEdges', 'MPR counter renders a crisp-edges plain-digit svg');
assert(counterEl.querySelectorAll('rect').length > 1, 'MPR counter svg paints the digit pixels');
let mprPosts = posted.filter((p) => p && p.type === 'mpr-counter');
assert(mprPosts.length === 1 && mprPosts[0].counter === 1 && mprPosts[0].caseId === 'TC-03', `MPR counter posts the {counter,caseId} ground truth, got: ${JSON.stringify(mprPosts)}`);
mprTickCb();
mprPosts = posted.filter((p) => p && p.type === 'mpr-counter');
assert(mprPosts.length === 2 && mprPosts[1].counter === 2, 'MPR counter is monotonic across ticks');

// 6: shipped counter-render READ-side contract -- the staged media/ module also ships the reader-consumable
//    bitmap + structural helpers (the deterministic-record read side viewer.js does not import). Prove the
//    shipped API is intact (verify-counter.mjs is the exhaustive drift/round-trip guard on the source).
const cr = await import(pathToFileURL(join(here, '..', 'media', 'counter-render.mjs')).href);
const bmp = cr.counterBitmap(123, 6);
assert(bmp.height === 5 && bmp.rows.length === 5, 'counterBitmap is a 5-row plain-digit bitmap');
assert(bmp.width === bmp.rows[0].length, 'counterBitmap width matches its row length');
assert(cr.litPixelCount(123, 6) === bmp.rows.join('').split('1').length - 1, 'litPixelCount equals the lit cells in the bitmap');
const anchor = cr.createCounter(0);
cr.setCase(anchor, 'TC-09');
cr.tick(anchor);
cr.tick(anchor);
const emittedSeries = cr.emitted(anchor);
assert(emittedSeries.length === 2 && emittedSeries[1].counter === 2 && emittedSeries[1].caseId === 'TC-09', `emitted returns the ticked {counter,caseId} series, got: ${JSON.stringify(emittedSeries)}`);

console.log(
  'viewer-render: PASS -- media/viewer.js renders the metric svg + draggable time cursor and tracks pointer + ' +
    'keyboard input in a real DOM (jsdom); the opt-in MPR counter ticks the plain-digit anchor + posts its ' +
    'ground truth; cursor math is the proven viewerCursor core.'
);
process.exit(0);
