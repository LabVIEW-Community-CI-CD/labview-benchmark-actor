/**
 * Deterministic Node self-test for the benchmark presentation builders
 * (benchmark-panels.mjs) — the VS Code UI wire-up surfaces. No browser: it
 * validates the dhash-grid decode, the STATIC single-run + trend document
 * invariants (strict CSP, escaped dynamic text, the headline / verdict / SVG
 * markup), the scrubber model mappers, determinism, and a full build off the
 * REAL committed LabVIEW launch record + trend fixtures.
 *
 * Run: node experiments/mprr-capture-ring/verify-benchmark-panels.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dhashGridCells,
  dhashGridSvg,
  dhashGridDataUri,
  buildBenchmarkPanelHtml,
  buildTrendPanelHtml,
  buildCrossPlaneTrendPanelHtml,
  buildResourcePanelHtml,
  buildCrossPlaneResourcePanelHtml,
  scrubberModelFromTrend,
  scrubberModelFromRecord,
  escapeHtml,
} from './benchmark-panels.mjs';
import { buildBenchmarkFrameScrubberHtml } from '../dashboard-slider/buildBenchmarkFrameScrubberHtml.mjs';
import { dhashHexToBits } from '../manual-procedure-record/fingerprint.mjs';
import { crossPlaneTrendReceipt } from './cross-plane-trend.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log('  ok   ' + label);
  } else {
    failures += 1;
    console.log('  FAIL ' + label + (detail ? '  -- ' + detail : ''));
  }
}

// ---------------------------------------------------------------------------
// 1. dhash grid decode (single-source dhashHexToBits projection)
// ---------------------------------------------------------------------------
console.log('dhash grid decode');
const PIN = '0000010101010100'; // the real LabVIEW UI-READY settle pin
const cells = dhashGridCells(PIN);
check('8x8 grid', cells.length === 8 && cells.every((r) => r.length === 8));
check('row 0 all off', cells[0].every((b) => b === false));
check('row 2 col 7 on', cells[2][7] === true);
check('row 2 cols 0..6 off', cells[2].slice(0, 7).every((b) => b === false));
const onCount = cells.flat().filter(Boolean).length;
check('pin has 5 lit cells (rows 2..6 col 7)', onCount === 5, 'got ' + onCount);
let threw = false;
try { dhashGridCells('nothex'); } catch { threw = true; }
check('bad dhash throws', threw);

// drift guard: the INLINED grid decode must agree with the canonical single-source
// dhashHexToBits (fingerprint.mjs) for every bit, so the stageable copy can't rot.
console.log('dhash decode drift guard (vs fingerprint.mjs)');
const driftSamples = ['0000010101010100', 'ffffffffffffffff', '0000000000000000', '8000000000000001', 'a5a5a5a5a5a5a5a5'];
let driftOk = true;
for (const hex of driftSamples) {
  const bits = dhashHexToBits(hex);
  const grid = dhashGridCells(hex);
  for (let r = 0; r < 8 && driftOk; r += 1) {
    for (let c = 0; c < 8; c += 1) {
      const canonical = ((bits >> BigInt(63 - (r * 8 + c))) & 1n) === 1n;
      if (grid[r][c] !== canonical) { driftOk = false; break; }
    }
  }
}
check('inlined decode matches canonical dhashHexToBits (no drift)', driftOk);

console.log('dhash grid svg / data uri');
const svg = dhashGridSvg(PIN, { cell: 10 });
check('svg has 64 cell rects + 1 bg', (svg.match(/<rect/g) || []).length === 65);
check('svg carries width/height (natural size for Fit)', /width="80" height="80"/.test(svg));
const uri = dhashGridDataUri(PIN);
check('data uri is base64 svg', uri.startsWith('data:image/svg+xml;base64,'));
check('data uri decodes back to the svg', Buffer.from(uri.split(',')[1], 'base64').toString('utf8').includes('<svg'));

// ---------------------------------------------------------------------------
// 2. escapeHtml
// ---------------------------------------------------------------------------
console.log('escapeHtml');
check('escapes < > & " \'', escapeHtml(`<b>&"'`) === '&lt;b&gt;&amp;&quot;&#39;');

// ---------------------------------------------------------------------------
// 3. single-run panel document invariants
// ---------------------------------------------------------------------------
console.log('single-run panel');
const record = {
  schema: 'labview-benchmark-actor/boot-benchmark-v1',
  workload: 'labview-ide-launch',
  plane: 'LINUX',
  hypervisor: 'vbox-vnc',
  frames: [{ index: 30, settled: true, caseId: 'UI-READY', perceptualFingerprint: PIN, integrityHash: 'd45eaf6eaf064724abc' }],
  spans: [{ id: 'launchMs', from: 'WORKLOAD-START', to: 'UI-READY', clock: 'host', scope: 'cross-plane', ms: 2577 }],
  sourceDetail: { framesCaptured: 481, stableTailFrames: 451, settleOpts: { window: 10, toleranceHamming: 3 } },
};
const nonce = 'nonce-abc123';
const phtml = buildBenchmarkPanelHtml(record, nonce);
check('DOCTYPE', /^<!DOCTYPE html>/.test(phtml));
check('CSP default-src none', phtml.includes("default-src 'none'"));
check('CSP has NO script-src (static, no client JS)', !phtml.includes('script-src'));
check('no <script> element (fully static)', !/<script/i.test(phtml));
check('headline carries launchMs 2577', phtml.includes('2577'));
check('embeds the dhash grid as a data: svg image', phtml.includes('src="data:image/svg+xml;base64,'));
check('shows the pin hex', phtml.includes(PIN));
check('shows capture stats (481 frames)', phtml.includes('481'));
check('deterministic', buildBenchmarkPanelHtml(record, nonce) === phtml);
// XSS: a hostile workload string is escaped, never a live tag.
const evil = buildBenchmarkPanelHtml({ ...record, workload: '<img src=x onerror=alert(1)>' }, nonce);
check('dynamic text is html-escaped', evil.includes('&lt;img src=x') && !evil.includes('<img src=x onerror'));

// ---------------------------------------------------------------------------
// 4. trend panel document invariants
// ---------------------------------------------------------------------------
console.log('trend panel');
const trend = {
  schema: 'labview-benchmark-actor/workload-trend@1',
  metric: 'launchMs',
  workload: 'labview-ide-launch',
  plane: 'LINUX',
  hypervisor: 'vbox-vnc',
  n: 5,
  values: [2414, 2843, 2745, 2664, 2355],
  stats: { min: 2355, max: 2843, mean: 2604.2, median: 2664, stddev: 189.1, spread: 488 },
  baselineMs: 2664,
  toleranceMs: 2000,
  latest: 2355,
  slopeMsPerRun: -29.7,
  driftThresholdMsPerRun: 400,
  drifting: false,
  regressed: false,
  verdict: 'PASS',
};
const thtml = buildTrendPanelHtml(trend, nonce);
check('DOCTYPE', /^<!DOCTYPE html>/.test(thtml));
check('CSP default-src none', thtml.includes("default-src 'none'"));
check('no <script> element (fully static)', !/<script/i.test(thtml));
check('PASS badge', thtml.includes('badge pass') && thtml.includes('PASS'));
check('renders an svg chart', thtml.includes('<svg class="chart"'));
check('one marker circle per run (5) + latest ring', (thtml.match(/<circle/g) || []).length === 6);
check('a value label per run', thtml.includes('>2414<') && thtml.includes('>2355<'));
check('shows the slope', thtml.includes('-29.7 ms/run'));
check('regression ceiling annotated (4664, not breached)', thtml.includes('4664') && thtml.includes('not breached'));
check('deterministic', buildTrendPanelHtml(trend, nonce) === thtml);
// a regressed trend flips the badge
const bad = buildTrendPanelHtml({ ...trend, verdict: 'REGRESSION', regressed: true, latest: 9000, values: [2414, 2843, 2745, 2664, 9000] }, nonce);
check('REGRESSION badge on a regressed trend', bad.includes('badge fail') && bad.includes('REGRESSION'));

// ---------------------------------------------------------------------------
// 4b. cross-plane trend panel (WIN vs LINUX overlay)
// ---------------------------------------------------------------------------
console.log('cross-plane trend panel');
const winTrend = { ...trend, plane: 'WIN', hypervisor: 'vmware-vnc', values: [2796, 2309, 2307, 2308, 2333], stats: { min: 2307, max: 2796, mean: 2410.6, median: 2309, stddev: 192.9, spread: 489 }, baselineMs: 2309, slopeMsPerRun: -92.7, latest: 2333 };
const xreceipt = crossPlaneTrendReceipt(winTrend, trend);
const xhtml = buildCrossPlaneTrendPanelHtml(xreceipt, winTrend, trend, nonce);
check('cross-plane DOCTYPE + strict CSP + no script', /^<!DOCTYPE html>/.test(xhtml) && xhtml.includes("default-src 'none'") && !/<script/i.test(xhtml));
check('cross-plane PASS badge', xhtml.includes('badge pass') && xhtml.includes('PASS'));
check('cross-plane overlays BOTH series (2 polylines)', (xhtml.match(/<polyline/g) || []).length === 2);
check('cross-plane markers = win + linux runs (10)', (xhtml.match(/<circle/g) || []).length === winTrend.values.length + trend.values.length);
check('cross-plane shows the witnessed mean delta', xhtml.includes(String(xreceipt.witness.meanDeltaMs)) && /mean .* \(WIN/.test(xhtml));
check('cross-plane names both planes/hypervisors', xhtml.includes('vmware-vnc') && xhtml.includes('vbox-vnc'));
check('cross-plane deterministic', buildCrossPlaneTrendPanelHtml(xreceipt, winTrend, trend, nonce) === xhtml);

// ---------------------------------------------------------------------------
// 4c. resource-correlation panel (LBA-REQ-011) off the REAL live fixture
// ---------------------------------------------------------------------------
console.log('resource-correlation panel');
const rcPath = join(HERE, 'fixtures', 'labview-launch-resource-correlation.json');
if (existsSync(rcPath)) {
  const rc = JSON.parse(readFileSync(rcPath, 'utf8'));
  const rchtml = buildResourcePanelHtml(rc, nonce);
  check('resource DOCTYPE + strict CSP + no script', /^<!DOCTYPE html>/.test(rchtml) && rchtml.includes("default-src 'none'") && !/<script/i.test(rchtml));
  check('resource panel has a CPU/RAM/disk sparkline each (3 svgs)', (rchtml.match(/<svg/g) || []).length === 3);
  check('each sparkline draws the trigger line + a polyline', (rchtml.match(/<polyline/g) || []).length === 3 && rchtml.includes('#ff7b72'));
  check('resource panel shows the launchMs badge', rchtml.includes(String(rc.launchMs) + ' ms launch'));
  check('resource panel labels CPU/RAM/disk', rchtml.includes('CPU %') && rchtml.includes('RAM MB') && rchtml.includes('Disk %'));
  check('resource panel shows the RAM delta headline', rchtml.includes(String(Math.round(rc.windows.ram.deltaMean * 100) / 100)));
  check('resource panel deterministic', buildResourcePanelHtml(rc, nonce) === rchtml);
} else {
  console.log('  ..   live resource fixture not present yet');
}

// ---------------------------------------------------------------------------
// 4d. cross-plane resource-agreement panel off the REAL committed receipt
// ---------------------------------------------------------------------------
console.log('cross-plane resource panel');
const xrcPath = join(HERE, 'fixtures', 'resource-cross-plane-receipt.json');
if (existsSync(xrcPath)) {
  const xrc = JSON.parse(readFileSync(xrcPath, 'utf8'));
  const xrchtml = buildCrossPlaneResourcePanelHtml(xrc, nonce);
  check('xplane-resource DOCTYPE + strict CSP + no script', /^<!DOCTYPE html>/.test(xrchtml) && xrchtml.includes("default-src 'none'") && !/<script/i.test(xrchtml));
  check('xplane-resource verdict badge', xrchtml.includes(`badge ${xrc.verdict === 'PASS' ? 'pass' : 'fail'}`) && xrchtml.includes(xrc.verdict));
  check('xplane-resource has WIN + LINUX delta bars per metric (6 svgs)', (xrchtml.match(/<svg/g) || []).length === 6);
  check('xplane-resource shows the launch delta', xrchtml.includes(String(xrc.launchDeltaMs)));
  check('xplane-resource RAM agreement headline', xrchtml.includes('substrate-independent') && xrchtml.includes(String(xrc.metrics.ram.agreementDelta)));
  check('xplane-resource per-metric status badges', ['cpu', 'ram', 'disk'].every((k) => xrchtml.includes(xrc.metrics[k].status.toUpperCase())));
  check('xplane-resource deterministic', buildCrossPlaneResourcePanelHtml(xrc, nonce) === xrchtml);
} else {
  console.log('  ..   cross-plane resource receipt not present yet');
}

// ---------------------------------------------------------------------------
// 5. scrubber model mappers -> feed the proven scrubber builder
// ---------------------------------------------------------------------------
console.log('scrubber models');
const tModel = scrubberModelFromTrend(trend, { pinDhash: PIN });
check('one scrubber point per run', tModel.points.length === 5);
check('metricLabel = trend metric', tModel.metricLabel === 'launchMs');
check('point metricValue = launchMs', tModel.points[1].metricValue === 2843);
check('every point carries the dhash-grid image', tModel.points.every((p) => p.image.startsWith('data:image/svg+xml;base64,')));
check('selectedIndex = latest run', tModel.selectedIndex === 4);
check('every point is a frame-start (snap target)', tModel.points.every((p) => p.isFrameStart));
const tScrub = buildBenchmarkFrameScrubberHtml(tModel, nonce);
check('trend model builds a valid scrubber doc', /^<!DOCTYPE html>/.test(tScrub) && tScrub.includes("script-src 'nonce-" + nonce + "'"));
check('scrubber doc embeds the frame images', tScrub.includes('data:image/svg+xml;base64,'));
let noVals = false;
try { scrubberModelFromTrend({ values: [] }, {}); } catch { noVals = true; }
check('empty trend throws', noVals);

const rModel = scrubberModelFromRecord(record);
check('record -> one point per fingerprinted frame', rModel.points.length === 1);
check('record point image is a dhash grid', rModel.points[0].image.startsWith('data:image/svg+xml;base64,'));

// ---------------------------------------------------------------------------
// 6. REAL committed fixtures build end-to-end
// ---------------------------------------------------------------------------
console.log('real committed fixtures');
const realRecord = JSON.parse(readFileSync(join(HERE, 'fixtures', 'labview-launch-record.json'), 'utf8'));
const realTrend = JSON.parse(readFileSync(join(HERE, 'fixtures', 'labview-launch-trend.json'), 'utf8'));
const realPin = realRecord.frames.find((f) => f.settled).perceptualFingerprint;
check('real record builds a panel with its launchMs', buildBenchmarkPanelHtml(realRecord, nonce).includes(String(realRecord.spans[0].ms)));
check('real trend builds a PASS panel', buildTrendPanelHtml(realTrend, nonce).includes(realTrend.verdict));
const realScrub = buildBenchmarkFrameScrubberHtml(scrubberModelFromTrend(realTrend, { pinDhash: realPin }), nonce);
check('real trend + real pin build the frame-correlator scrubber', realScrub.includes('data:image/svg+xml;base64,') && realScrub.includes('run 5'));

// ---------------------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.error('verify-benchmark-panels: ' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('verify-benchmark-panels: all checks passed');
