// verify-counter.mjs — self-test for the viewer monotonic-counter renderer.
//
// The counter render side (counter-render.mjs, staged into media/) and the read side
// (known-digit-reader.mjs) MUST agree glyph-for-glyph or a captured counter would misread. This proves:
//   1. drift guard   — counter-render GLYPHS are byte-identical to the reader's GLYPHS.
//   2. round-trip    — the reader reads counter-render's bitmap back byte-exact (render <-> read closed).
//   3. SVG structure — counterSvg draws exactly one crisp rect per lit glyph pixel (+ the background).
//   4. state machine — tick() is monotonic and emits the {counter, caseId} series the record/pairing need.
//
//   node verify-counter.mjs   # exits 0 iff every check passes

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GLYPHS as CG, counterBitmap, counterSvg, litPixelCount, createCounter, tick, setCase, emitted } from './counter-render.mjs';
import { GLYPHS as RG, renderCounter, readCounter } from './known-digit-reader.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checks = [];
const check = (name, cond) => checks.push({ name, pass: !!cond });

// 1. drift guard — the render glyphs MUST equal the reader glyphs exactly.
check('counter-render GLYPHS identical to reader GLYPHS', JSON.stringify(CG) === JSON.stringify(RG));

// 2. round-trip — reader reads counter-render's bitmap back byte-exact, over a dense sample.
let bitmapMatch = true;
let roundTrip = true;
for (let n = 0; n <= 3000; n++) {
  const bmp = counterBitmap(n, 6);
  if (JSON.stringify(bmp) !== JSON.stringify(renderCounter(n, 6))) bitmapMatch = false;
  if (readCounter(bmp) !== n) roundTrip = false;
}
check('counterBitmap layout-identical to reader.renderCounter', bitmapMatch);
check('reader reads counter-render bitmap byte-exact (0..3000)', roundTrip);

// 3. SVG structure — one rect per lit pixel + one background rect; sane dimensions.
const V = 123456;
const svg = counterSvg(V, { minDigits: 6, cellPx: 6 });
const rectCount = (svg.match(/<rect/g) || []).length;
check('counterSvg draws litPixels + 1 background rect', rectCount === litPixelCount(V, 6) + 1);
check('counterSvg is a crisp-edges svg', svg.includes('shape-rendering="crispEdges"') && svg.startsWith('<svg'));

// 4. state machine — monotonic ticks + case markers -> emitted series.
const c = createCounter(1000);
setCase(c, 'TC-00'); tick(c); tick(c);
setCase(c, 'TC-01'); tick(c);
const series = emitted(c);
const monotonic = series.every((e, i) => i === 0 || e.counter === series[i - 1].counter + 1);
check('tick() is monotonic (+1 each)', monotonic && series[0].counter === 1001 && series[series.length - 1].counter === 1003);
check('caseId markers recorded per frame', series[0].caseId === 'TC-00' && series[2].caseId === 'TC-01');

const passed = checks.filter((c2) => c2.pass).length;
const verdict = passed === checks.length ? 'PASS' : 'FAIL';
writeFileSync(join(here, 'counter-receipt.json'), JSON.stringify({
  schema: 'labview-benchmark-actor/viewer-counter-receipt-v1',
  ranAt: new Date().toISOString(),
  total: checks.length,
  passed,
  failed: checks.length - passed,
  failures: checks.filter((c2) => !c2.pass).map((c2) => c2.name),
  verdict,
}, null, 2) + '\n');

for (const c2 of checks) console.log(`${c2.pass ? 'PASS' : 'FAIL'}  ${c2.name}`);
console.log(`\nviewer-counter: ${passed}/${checks.length}; verdict=${verdict}`);
process.exit(verdict === 'PASS' ? 0 : 1);
