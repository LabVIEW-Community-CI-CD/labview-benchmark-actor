#!/usr/bin/env node
// Behavior + coverage test for the viewer's monotonic-counter anchor (media/counter-render.mjs) -- pure
// functions, no DOM: createCounter / tick / setCase / emitted / counterBitmap / counterSvg / litPixelCount.
// The counter is the correlation ground truth the capture reader pairs frames against (LBA-REQ-003/005).
//
// Usage: npm test (runs after `npm run compile` stages media/counter-render.mjs).
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const {
  createCounter, tick, setCase, emitted, counterBitmap, counterSvg, litPixelCount, GLYPH_W, GLYPH_H,
} = await import(join(here, '..', 'media', 'counter-render.mjs'));

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL  counter-render: ${msg}`);
    process.exit(1);
  }
}

// --- monotonic counter series (the correlation ground truth) ---
const c = createCounter(0);
assert(emitted(c).length === 0, 'a new counter has an empty emitted series');
setCase(c, 'TC-03');
assert(tick(c) === 1 && tick(c) === 2, 'tick advances the counter value monotonically');
const series = emitted(c);
assert(series.length === 2 && series[0].counter === 1 && series[0].caseId === 'TC-03',
  'emitted() records {counter, caseId} per tick after the case boundary');
assert(emitted(c) !== series, 'emitted() returns a defensive copy, not the internal array');

// --- abstract bitmap (reader-consumable) ---
const bmp = counterBitmap(42, 4);
assert(bmp.height === GLYPH_H && bmp.rows.length === GLYPH_H && bmp.width > 0, 'counterBitmap returns a GLYPH_H-row bitmap');
let threw = false;
try { counterBitmap(-1); } catch { threw = true; }
assert(threw, 'counterBitmap rejects a negative value (fail-closed)');

// --- crisp SVG (viewer-visible) ---
const svg = counterSvg(42, { minDigits: 6 });
assert(typeof svg === 'string' && svg.startsWith('<svg') && /crispEdges/.test(svg) && /<rect/.test(svg),
  'counterSvg renders a crisp-edge <rect> grid');
assert(litPixelCount(42, 6) > 0 && GLYPH_W > 0 && GLYPH_H > 0, 'litPixelCount + glyph dims are positive');

console.log('counter-render: PASS -- createCounter/tick/setCase/emitted/counterBitmap/counterSvg/litPixelCount exercised');
