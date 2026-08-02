// Self-test for meshCalibrationView.mjs -- the mesh-stress calibration ANALYSIS VIEW (overview §3.6 / VW-1,
// LBA-REQ-032). Browser-free: build the HTML from the COMMITTED live-ladder receipt and assert the rendered
// surface -- the commanded ladder, the cpuTotalPct calibration curve (SVG polyline whose y-coordinates descend
// as the value climbs, proving the curve visually tracks idle -> saturate + its tolerance band), the
// monotone/separable/repeatable invariant badges, the per-boundary separability, and the inverse-read readout.
// Also asserts the surface is inert (CSP script-src 'none', no <script>) and escapes hostile input.
// Run: node meshCalibrationView.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildMeshCalibrationHtml, MESH_CALIBRATION_VIEW_SCHEMA } from './meshCalibrationView.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(here, 'fixtures', 'mesh-live-ladder-receipt.json'), 'utf8'));
const html = buildMeshCalibrationHtml(receipt, { cspSource: 'vscode-resource:' });
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// --- 1. a well-formed, INERT document ---
{
  assert.ok(html.startsWith('<!DOCTYPE html>'), 'emits a full HTML document');
  assert.match(html, /Content-Security-Policy/, 'declares a CSP');
  assert.match(html, /script-src 'none'/, "the surface is script-free (script-src 'none')");
  assert.ok(!/<script/i.test(html), 'contains no <script> element');
  assert.ok(MESH_CALIBRATION_VIEW_SCHEMA.length > 0, 'exports a view schema id');
  ok('renders an inert, script-free HTML document with a CSP');
}

// --- 2. the commanded ladder (idle -> saturate) is shown ---
{
  for (const rung of ['idle', 'light', 'medium', 'heavy', 'saturate']) {
    assert.ok(html.includes(`<b>${rung}</b>`), `commanded ladder shows the ${rung} rung`);
  }
  ok('renders the full commanded ladder idle -> saturate');
}

// --- 3. the SVG calibration curve climbs (y descends as the value rises) + shows a tolerance band ---
{
  assert.match(html, /class="mc-band"/, 'renders the tolerance band polygon');
  const m = html.match(/class="mc-line" points="([^"]+)"/);
  assert.ok(m, 'renders the calibration polyline');
  const ys = m[1].trim().split(/\s+/).map((p) => Number(p.split(',')[1]));
  assert.equal(ys.length, receipt.cpuTotalPctMeanCurve.length, 'the polyline has one point per rung');
  for (let i = 1; i < ys.length; i += 1) assert.ok(ys[i] < ys[i - 1], `curve climbs: y descends across the ladder (${ys.join(',')})`);
  for (const p of receipt.cpuTotalPctMeanCurve) assert.ok(html.includes(`${Number(p.expected.toFixed(1))}%`), `labels the ${p.rung} value ${p.expected}%`);
  ok(`calibration curve climbs monotonically across ${ys.length} rungs with a tolerance band`);
}

// --- 4. the invariant badges reflect the REAL result (all ok) ---
{
  assert.match(html, /class="mc-badge ok">\u2713 monotone 100%/, 'monotone badge is green at 100%');
  assert.match(html, /class="mc-badge ok">\u2713 separable/, 'separable badge is green');
  assert.match(html, /class="mc-badge ok">\u2713 repeatable/, 'repeatable badge is green');
  assert.ok(html.includes(`${receipt.salientDimensions.length} salient dims`), 'shows the salient-dimension count');
  ok('invariant badges are all green (monotone 100% / separable / repeatable)');
}

// --- 5. per-boundary separability + inverse read ---
{
  for (const s of receipt.separability) assert.ok(html.includes(`${s.from} \u2192 ${s.to}`), `separability lists ${s.from}->${s.to}`);
  const ir = receipt.inverseRead;
  assert.ok(html.includes(`inferred <b>${ir.inferredRung}</b>`), 'shows the inferred rung');
  assert.match(html, /recovered \u2713/, 'the inverse read is marked recovered');
  ok(`separability (${receipt.separability.length} boundaries) + inverse read ${receipt.inverseRead.heldOutRung}->${receipt.inverseRead.inferredRung} recovered`);
}

// --- 6. hostile input is escaped (no HTML injection) ---
{
  const evil = buildMeshCalibrationHtml({
    schema: '<img src=x onerror=alert(1)>',
    host: { hostname: '</style><script>bad()</script>' },
    ladder: { commanded: [{ rung: '<b>x</b>', spinners: 0 }] },
    cpuTotalPctMeanCurve: [], separability: [], salientDimensions: ["'\"><script>"], invariants: {}, inverseRead: {},
  });
  assert.ok(!evil.includes('<script>bad()</script>'), 'hostile hostname is escaped');
  assert.ok(!evil.includes('<img src=x onerror'), 'hostile schema is escaped');
  assert.ok(evil.includes('&lt;'), 'markup is entity-escaped');
  ok('escapes hostile input (no HTML/script injection)');
}

console.log(`\nmeshCalibrationView.selftest: ${passed}/${passed} checks passed`);
