#!/usr/bin/env node
// Maintainer RENDER proof for the benchmark UI surfaces wired into the extension (LBA-REQ-004/005): load the
// SHIPPED media/ builders + the REAL staged fixtures, build each webview document, and render it in a real DOM
// (jsdom) to prove the markup actually renders -- the static single-run + trend panels AND the interactive
// vertical-line frame correlator (execute its inline runtime, scrub it, and assert the selection tracks).
//
// Run: npm test (needs jsdom + a prior `npm run compile` to stage media/).

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mediaUrl = (f) => pathToFileURL(join(here, '..', 'media', f)).href;
const mediaJson = (f) => JSON.parse(readFileSync(join(here, '..', 'media', f), 'utf8'));

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL  ${msg}`);
    process.exit(1);
  }
}

const { buildBenchmarkPanelHtml, buildTrendPanelHtml, buildCrossPlaneTrendPanelHtml, buildResourcePanelHtml, buildCrossPlaneResourcePanelHtml, scrubberModelFromTrend, scrubberModelFromRecord, dhashGridCells } = await import(
  mediaUrl('benchmark-panels.mjs')
);
const { buildLaunchCapture } = await import(mediaUrl('launch-capture.mjs'));
const { buildFrameCorrelatorHtml } = await import(mediaUrl('frame-correlator.mjs'));

const record = mediaJson('labview-launch-record.json');
const trend = mediaJson('labview-launch-trend.json');
const winTrend = mediaJson('labview-launch-trend-win.json');
const crossReceipt = mediaJson('cross-plane-trend-receipt.json');
const resourceRc = mediaJson('labview-launch-resource-correlation.json');
const crossResourceReceipt = mediaJson('resource-cross-plane-receipt.json');
const NONCE = 'render-nonce-000000000000000000ab';

// --- 1. single-run panel (static) renders the launchMs headline, the dhash-grid frame, and stats ------------
{
  const dom = new JSDOM(buildBenchmarkPanelHtml(record, NONCE));
  const doc = dom.window.document;
  const headline = doc.querySelector('.headline');
  assert(headline && /\b2577\b/.test(headline.textContent), `run panel headline shows launchMs 2577, got: ${headline && headline.textContent}`);
  const img = doc.querySelector('img');
  assert(img && /^data:image\/svg\+xml;base64,/.test(img.getAttribute('src')), 'run panel embeds the dhash-grid frame as a data: svg image');
  const cells = [...doc.querySelectorAll('td.v')].map((td) => td.textContent);
  assert(cells.includes('481'), `run panel shows the capture stats (481 frames), got cells: ${cells.join(' | ')}`);
  assert(doc.body.textContent.includes(record.frames[0].perceptualFingerprint), 'run panel shows the UI-READY pin hex');
  assert(!doc.querySelector('script'), 'run panel is fully static (no script element)');
}

// --- 2. trend panel (static) renders the verdict badge, the run chart, and the value labels -----------------
{
  const dom = new JSDOM(buildTrendPanelHtml(trend, NONCE));
  const doc = dom.window.document;
  const badge = doc.querySelector('.badge');
  assert(badge && badge.textContent.trim() === 'PASS' && badge.classList.contains('pass'), `trend panel shows the PASS badge, got: ${badge && badge.textContent}`);
  const svg = doc.querySelector('svg.chart');
  assert(svg, 'trend panel renders the run-series svg chart');
  assert(svg.querySelectorAll('circle').length === trend.values.length + 1, `a marker per run (${trend.values.length}) + the latest ring`);
  assert(svg.querySelector('polyline'), 'trend panel draws the series polyline');
  for (const v of [trend.values[0], trend.values[trend.values.length - 1]]) {
    assert(svg.textContent.includes(String(v)), `trend chart labels run value ${v}`);
  }
  assert(doc.body.textContent.includes(`${trend.slopeMsPerRun} ms/run`), 'trend panel shows the slope');
}

// --- 2b. cross-plane trend panel (static) overlays both series + witnessed deltas + both verdicts -----------
{
  const dom = new JSDOM(buildCrossPlaneTrendPanelHtml(crossReceipt, winTrend, trend, NONCE));
  const doc = dom.window.document;
  const svg = doc.querySelector('svg.chart');
  assert(svg, 'cross-plane panel renders the overlay chart');
  assert(svg.querySelectorAll('polyline').length === 2, 'cross-plane panel overlays BOTH plane series');
  assert(svg.querySelectorAll('circle').length === winTrend.values.length + trend.values.length, 'a marker per run on both planes');
  const badge = doc.querySelector('.badge');
  assert(badge && badge.textContent.trim() === crossReceipt.verdict, `cross-plane verdict badge (${crossReceipt.verdict})`);
  assert(doc.body.textContent.includes(String(crossReceipt.witness.meanDeltaMs)), 'cross-plane panel shows the witnessed mean delta');
  assert(doc.body.textContent.includes('vmware-vnc') && doc.body.textContent.includes('vbox-vnc'), 'cross-plane panel names both hypervisors');
  assert(!doc.querySelector('script'), 'cross-plane panel is fully static');
}

// --- 2d. resource-correlation panel (static) renders CPU/RAM/disk sparklines split at the settle trigger -----
{
  const dom = new JSDOM(buildResourcePanelHtml(resourceRc, NONCE));
  const doc = dom.window.document;
  assert(doc.querySelectorAll('svg').length === 3, 'resource panel renders a CPU/RAM/disk sparkline each');
  assert(doc.querySelectorAll('svg polyline').length === 3, 'each metric sparkline draws its series polyline');
  assert(doc.body.textContent.includes(`${resourceRc.launchMs} ms launch`), 'resource panel shows the launchMs badge');
  assert(/CPU %/.test(doc.body.textContent) && /RAM MB/.test(doc.body.textContent) && /Disk %/.test(doc.body.textContent), 'resource panel labels all three metrics');
  assert(!doc.querySelector('script'), 'resource panel is fully static');
}

// --- 2e. cross-plane resource-agreement panel (static): WIN vs LINUX deltas + RAM agreement headline ---------
{
  const dom = new JSDOM(buildCrossPlaneResourcePanelHtml(crossResourceReceipt, NONCE));
  const doc = dom.window.document;
  assert(doc.querySelectorAll('svg').length === 6, 'cross-plane resource panel draws a WIN + LINUX delta bar per metric');
  const badge = doc.querySelector('h2 .badge');
  assert(badge && badge.textContent.trim() === crossResourceReceipt.verdict, `cross-plane resource verdict badge (${crossResourceReceipt.verdict})`);
  assert(doc.body.textContent.includes(String(crossResourceReceipt.launchDeltaMs)), 'shows the cross-plane launch delta');
  assert(/substrate-independent/.test(doc.body.textContent), 'shows the RAM-agreement headline');
  assert(!doc.querySelector('script'), 'cross-plane resource panel is fully static');
}

// --- 3. frame correlator (interactive): CPU/RAM/disk curves + the real screenshot track the red scrub line --
{
  const startMs = 1_700_000_000_000;
  const N = 6;
  const frames = Array.from({ length: N }, (_, i) => ({
    index: i,
    imageFile: `frame-${String(i).padStart(5, '0')}.png`,
    imageBytes: 1000 + i,
    ms: startMs + Math.round((i * 1000) / 12),
  }));
  const resourceSamples = Array.from({ length: N }, (_, i) => ({
    ms: startMs + Math.round((i * 1000) / 12),
    cpuPct: 10 + i * 5,
    ramMb: 2000 + i * 10,
    diskPct: i * 3,
  }));
  const cap = buildLaunchCapture({ frames, resourceSamples, startMs, fps: 12, meta: { workload: 'labview-launch', plane: 'WIN' } });
  assert(cap.frameCount === N, `capture assembles ${N} frames, got ${cap.frameCount}`);
  assert(cap.dualPacket && cap.dualPacket.authoritative === true, 'capture dual-packet is authoritative (all long payloads admitted)');
  // a 1x1 transparent PNG data URI stands in for the VM-local webview screenshot URI.
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const model = {
    title: 'LabVIEW launch — frame correlator',
    fps: cap.fps,
    selectedIndex: 0,
    frames: cap.frames.map((f) => ({ index: f.index, tMs: f.tMs, cpuPct: f.cpuPct, ramMb: f.ramMb, diskPct: f.diskPct, imageSrc: px })),
  };
  const html = buildFrameCorrelatorHtml(model, NONCE, 'vscode-webview://render');
  assert(/Content-Security-Policy/.test(html) && html.includes(`nonce-${NONCE}`), 'correlator sets a nonce CSP');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const root = doc.getElementById('fc-root');
  assert(root, 'correlator mounts #fc-root');
  const svg = doc.getElementById('fc-graph');
  assert(svg && svg.tagName.toLowerCase() === 'svg', 'correlator renders the metric graph svg');
  assert(svg.querySelectorAll('polyline').length === 3, `correlator plots CPU + RAM + disk polylines, got ${svg.querySelectorAll('polyline').length}`);
  const redline = svg.querySelector('line[stroke="#ff3b30"]');
  assert(redline, 'correlator renders the draggable red cursor line');
  const img = doc.getElementById('fc-img');
  assert(img && img.getAttribute('src') === px, 'correlator lower pane shows the captured screenshot of the selected frame');
  assert(root.getAttribute('data-selected-index') === '0', `correlator selects frame 0 initially, got ${root.getAttribute('data-selected-index')}`);
  const readout = doc.getElementById('fc-readout');
  assert(readout && /frame 1\/6\b/.test(readout.textContent), `readout shows the frame index, got: ${readout && readout.textContent}`);

  // scrub with the keyboard: ArrowRight -> frame 2, End -> last frame, Home -> frame 1; the red line stays vertical.
  const key = (k) => doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  key('ArrowRight');
  assert(root.getAttribute('data-selected-index') === '1', `ArrowRight scrubs to frame 2, got ${root.getAttribute('data-selected-index')}`);
  assert(redline.getAttribute('x1') === redline.getAttribute('x2'), 'red line stays vertical while scrubbing');
  key('End');
  assert(root.getAttribute('data-selected-index') === String(N - 1), `End scrubs to the last frame, got ${root.getAttribute('data-selected-index')}`);
  key('Home');
  assert(root.getAttribute('data-selected-index') === '0', 'Home scrubs back to frame 0');
}

// --- 3a2. frame correlator WITH per-physical-disk throughput -> a write+read MB/s curve per disk ------------
{
  const startMs = 1_700_000_000_000;
  const N = 5;
  const frames = Array.from({ length: N }, (_, i) => ({ index: i, imageFile: `f-${i}.png`, imageBytes: 1000 + i, ms: startMs + Math.round((i * 1000) / 12) }));
  // two physical disks; disk "0 C:" streams 11.4 MB/s at frame 2 (the case that % Disk Time would miss).
  const resourceSamples = Array.from({ length: N }, (_, i) => ({
    ms: startMs + Math.round((i * 1000) / 12),
    cpuPct: 20 + i, ramMb: 3000 + i, diskPct: 1,
    disks: [
      { name: '0 C:', writeMBs: i === 2 ? 11.4 : 0, readMBs: 0 },
      { name: '1 D:', writeMBs: 0, readMBs: i * 2 },
    ],
  }));
  const cap = buildLaunchCapture({ frames, resourceSamples, startMs, fps: 12, meta: { workload: 'labview-launch', plane: 'WIN' } });
  assert(Array.isArray(cap.diskNames) && cap.diskNames.length === 2, `capture exposes 2 disk names, got ${cap.diskNames}`);
  assert(cap.frames[2].disks && cap.frames[2].disks[0].writeMBs === 11.4, 'capture carries the 11.4 MB/s write onto the frame');
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const model = {
    title: 'disk throughput', fps: cap.fps, selectedIndex: 2,
    frames: cap.frames.map((f) => ({ index: f.index, tMs: f.tMs, cpuPct: f.cpuPct, ramMb: f.ramMb, diskPct: f.diskPct, disks: f.disks, imageSrc: px })),
    diskNames: cap.diskNames,
  };
  const html = buildFrameCorrelatorHtml(model, NONCE, 'vscode-webview://render');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const doc = dom.window.document;
  const svg = doc.getElementById('fc-graph');
  // 3 base (CPU/RAM/disk%) + 2 disks x {write,read} = 7 metric polylines (the red cursor is a <line>).
  assert(svg.querySelectorAll('polyline').length === 7, `correlator plots base + per-disk throughput curves, got ${svg.querySelectorAll('polyline').length}`);
  const legend = doc.getElementById('fc-legend').innerHTML;
  assert(/Disk 0 C: write MB\/s/.test(legend), 'legend labels the per-disk write throughput curve');
  assert(/Disk 1 D: read MB\/s/.test(legend), 'legend labels the per-disk read throughput curve');
  assert(/11\.4/.test(legend), 'legend shows the 11.4 MB/s write value at the streaming frame');
}

// --- 3b. frame correlator, EMPTY record -> the no-frames empty state (early return, no graph built) ---------
{
  const html = buildFrameCorrelatorHtml({ title: 'empty', fps: 12, selectedIndex: 0, frames: [] }, NONCE, 'vscode-webview://render');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const doc = dom.window.document;
  assert(doc.getElementById('fc-empty'), 'correlator shows the empty state when the record has no frames');
  assert(/No captured frames/.test(doc.getElementById('fc-root').textContent), 'empty correlator names the no-frames condition');
  assert(!doc.getElementById('fc-graph'), 'empty correlator builds no graph svg (early return)');
}

// --- 3c. frame correlator, POINTER drag + ArrowLeft + out-of-range selectedIndex + missing-field fallbacks --
{
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const frames = [
    { index: 0, tMs: 0, cpuPct: 10, ramMb: 2000, diskPct: 0, imageSrc: px },
    { index: 1, cpuPct: null, ramMb: 2010, diskPct: 2 }, // no tMs, no imageSrc, cpu null -> null-continue + fallbacks
    { index: 2, tMs: 200, cpuPct: 20, ramMb: 2020, diskPct: 4, imageSrc: px },
    { index: 3, tMs: 300, cpuPct: 25, ramMb: 2030, diskPct: 6, imageSrc: px },
  ];
  const html = buildFrameCorrelatorHtml({ title: 'drag', fps: 12, selectedIndex: 99, frames }, NONCE, '');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const root = doc.getElementById('fc-root');
  assert(root.getAttribute('data-selected-index') === '0', `out-of-range selectedIndex clamps to 0, got ${root.getAttribute('data-selected-index')}`);
  const svg = doc.getElementById('fc-graph');
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 150, right: 500, bottom: 150, x: 0, y: 0 });
  svg.setPointerCapture = () => {};
  const pointer = (type, clientX) => svg.dispatchEvent(new window.MouseEvent(type, { clientX, bubbles: true }));
  pointer('pointerdown', 500);
  assert(root.getAttribute('data-selected-index') === String(frames.length - 1), `pointer drag to the right edge selects the last frame, got ${root.getAttribute('data-selected-index')}`);
  pointer('pointermove', 0);
  assert(root.getAttribute('data-selected-index') === '0', 'pointer drag to the left edge selects frame 0');
  pointer('pointerup', 0);
  pointer('pointermove', 500);
  assert(root.getAttribute('data-selected-index') === '0', 'pointermove after pointerup does not scrub (drag ended)');
  const key = (k) => doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  key('ArrowRight');
  assert(root.getAttribute('data-selected-index') === '1', 'ArrowRight from 0 -> 1');
  assert(doc.getElementById('fc-legend').innerHTML.includes('--'), 'legend shows -- for the frame with a missing metric value');
  assert(doc.getElementById('fc-img').getAttribute('src') === '', 'frame image falls back to empty src when the frame has no imageSrc');
  assert(/frame 2\/4/.test(doc.getElementById('fc-readout').textContent), 'readout tracks to frame 2 (t derived from fps when tMs is absent)');
  key('ArrowLeft');
  assert(root.getAttribute('data-selected-index') === '0', 'ArrowLeft from 1 -> 0');
  key('ArrowLeft');
  assert(root.getAttribute('data-selected-index') === '0', 'ArrowLeft clamps at frame 0');
}

// --- 3c-v2. frame correlator, v2 counters{} frames -> plots the SELECTED performance-counter curves ----------
{
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const N = 8;
  const frames = Array.from({ length: N }, (_, i) => ({
    index: i, tMs: Math.round((i * 1000) / 12), imageSrc: px,
    counters: { cpuTotalPct: 10 + i * 7, memAvailableMb: 4000 - i * 12, diskWriteBytesPerSec: 1e6 * (i % 3), contextSwitchesPerSec: 2000 + i * 130 },
  }));
  const counterKeys = ['cpuTotalPct', 'memAvailableMb', 'diskWriteBytesPerSec'];
  const html = buildFrameCorrelatorHtml({ title: 'v2', fps: 12, selectedIndex: 0, frames, counterKeys }, NONCE, 'vscode-webview://render');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const doc = dom.window.document;
  const svg = doc.getElementById('fc-graph');
  assert(svg.querySelectorAll('polyline').length === counterKeys.length, `v2 correlator plots one curve per selected counter (${counterKeys.length}), got ${svg.querySelectorAll('polyline').length}`);
  const legend = doc.getElementById('fc-legend');
  assert(counterKeys.every((k) => legend.innerHTML.includes(k)), 'v2 legend labels each plotted performance counter by key');
  assert(/frame 1\/8/.test(doc.getElementById('fc-readout').textContent), 'v2 correlator readout tracks the frame index');
}

// --- 3c-default. v2 counters WITHOUT counterKeys -> a curated default subset is plotted ----------------------
{
  const frames = Array.from({ length: 5 }, (_, i) => ({
    index: i, tMs: Math.round((i * 1000) / 12),
    counters: { cpuTotalPct: 5 + i, memAvailableMb: 3000 - i, diskWriteBytesPerSec: 1e6, diskReadBytesPerSec: 5e5, netBytesReceivedPerSec: 1e4, contextSwitchesPerSec: 1500 },
  }));
  const html = buildFrameCorrelatorHtml({ title: 'v2-default', fps: 12, selectedIndex: 0, frames }, NONCE, '');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  const doc = dom.window.document;
  const plotted = doc.getElementById('fc-graph').querySelectorAll('polyline').length;
  assert(plotted >= 3 && plotted <= 6, `v2 default subset plots a curated few counters, got ${plotted}`);
  assert(doc.getElementById('fc-legend').innerHTML.includes('cpuTotalPct'), 'v2 default subset includes cpuTotalPct');
}

// --- 3d. launch-capture ASSEMBLER (buildLaunchCapture, a c8 module) through its non-happy branches: capacity-
//         degraded + missing-long + no samples + synthesized timing + fps default + dhashHex + screen/source,
//         short-protection-blocked, and startMs-from-frame + invalid-sample filtering + nearest-sample search. -
{
  // A. tiny ring capacity -> some long payloads deferred (degraded), a 0-byte long fails, no samples -> null
  //    metrics, frames without ms -> synthesized timing, fps 0 -> default 12, dhashHex kept, screen + source.
  const degraded = buildLaunchCapture({
    frames: [
      { imageFile: 'f0.png', imageBytes: 500, dhashHex: '0011223344556677' },
      { imageFile: 'f1.png', imageBytes: 0 },
      { imageFile: 'f2.png', imageBytes: 100000 },
    ],
    fps: 0,
    capacityBytes: 1000,
    meta: { workload: 'lv-launch', plane: 'LINUX', source: 'x11grab', screenW: 1920, screenH: 1080 },
  });
  assert(degraded.fps === 12, `invalid fps falls back to 12, got ${degraded.fps}`);
  assert(degraded.startMs === 0, 'startMs defaults to 0 when neither startMs nor frame ms is present');
  assert(degraded.frames[0].dhashHex === '0011223344556677', 'frame keeps its dhashHex when present');
  assert(degraded.frames[0].cpuPct === null && degraded.frames[0].ramMb === null, 'no resource samples -> null metrics');
  assert(degraded.frames[2].tMs === 167, `timing is synthesized from fps when a frame lacks ms, got ${degraded.frames[2].tMs}`);
  assert(degraded.source === 'x11grab' && degraded.screen.width === 1920 && degraded.screen.height === 1080, 'meta source + screen size flow through');
  assert(degraded.dualPacket.authoritative === false && degraded.dualPacket.outcome === 'degraded-long-deferred', `over-capacity long payloads degrade the packet, got ${degraded.dualPacket.outcome}`);
  assert(degraded.dualPacket.authoritativeFrames === 1, `only the fitting long payload is authoritative, got ${degraded.dualPacket.authoritativeFrames}`);
  assert(degraded.dualPacket.frames[1].outcome === 'failed' && degraded.dualPacket.frames[1].driftClass === 'missing-long-payload', 'a 0-byte long payload fails as missing-long-payload');

  // B. shorts alone exceed the ring capacity -> fail closed (short-protection-blocked), metadata defaults.
  const blocked = buildLaunchCapture({
    frames: [{ imageFile: 'a.png', imageBytes: 10 }, { imageFile: 'b.png', imageBytes: 10 }],
    capacityBytes: 30,
    meta: {},
  });
  assert(blocked.dualPacket.outcome === 'short-protection-blocked' && blocked.dualPacket.authoritative === false, `shorts over capacity fail closed, got ${blocked.dualPacket.outcome}`);
  assert(blocked.dualPacket.authoritativeFrames === 0 && blocked.dualPacket.frames.length === 0, 'short-protection-blocked admits no frames');
  assert(blocked.workload === 'labview-launch' && blocked.plane === null && blocked.source === 'ffmpeg-gdigrab' && blocked.screen === null, 'empty meta falls back to the default workload/source and null plane/screen');

  // C. no startMs but frames carry ms -> t0 from frames[0].ms; a NaN-ms sample is filtered; nearest-in-time wins.
  const withMs = buildLaunchCapture({
    frames: [{ imageFile: 'x.png', imageBytes: 50, ms: 1000 }, { imageFile: 'y.png', imageBytes: 50, ms: 1100 }],
    resourceSamples: [{ ms: NaN, cpuPct: 99 }, { ms: 1050, cpuPct: 30, ramMb: 2000, diskPct: 5 }, { ms: 1090, cpuPct: 40, ramMb: 2100, diskPct: 6 }],
    fps: 24,
  });
  assert(withMs.startMs === 1000, `t0 comes from frames[0].ms when startMs is absent, got ${withMs.startMs}`);
  assert(withMs.fps === 24, 'a valid fps is kept');
  assert(withMs.frames[0].cpuPct === 30 && withMs.frames[1].cpuPct === 40, `each frame takes its nearest-in-time sample (NaN-ms sample filtered), got ${withMs.frames[0].cpuPct}/${withMs.frames[1].cpuPct}`);
  assert(withMs.frames[0].tMs === 0 && withMs.frames[1].tMs === 100, 'tMs is measured from t0');

  // D. an empty (or absent) frames[] fails closed -- buildLaunchCapture refuses to assemble a record with no
  //    captured frame rather than emitting a degenerate one.
  let emptyThrew = false;
  try { buildLaunchCapture({ frames: [] }); } catch { emptyThrew = true; }
  assert(emptyThrew, 'buildLaunchCapture throws on an empty frames[] (a capture with no frame is not assembled)');
}

// --- 4. DEGENERATE / ALTERNATIVE branch fixtures: prove the builders render their FALLBACK markup for the
//        paths the happy-path fixtures never reach (absent fields, non-PASS verdicts, drift/breach, negative
//        deltas, missing planes/metrics). This is the branch-coverage floor for the shipped UI builders. ------

// 4a. single-run panel, FULLY degenerate record ({}) -> "no captured frame", em-dash headline, 'metric' span.
{
  const dom = new JSDOM(buildBenchmarkPanelHtml({}, NONCE));
  const doc = dom.window.document;
  assert(doc.body.textContent.includes('no captured frame'), 'degenerate run panel shows the no-frame placeholder');
  assert(!doc.querySelector('img'), 'degenerate run panel embeds no frame image');
  const hl = doc.querySelector('.headline');
  assert(hl && hl.textContent.trim().startsWith('\u2014'), `degenerate run panel headline is an em-dash, got: ${hl && hl.textContent}`);
  assert(doc.querySelector('.headline small').textContent.includes('metric'), 'degenerate run panel falls back to the metric span label');
  assert(doc.querySelectorAll('td.v').length === 0, 'degenerate run panel has no stat rows');
}

// 4b. single-run panel, PARTIAL record: a non-launchMs span with a non-numeric ms + an unsettled, fingerprint-
//     less frame -> spans[0]/frames[0] fallbacks, span stats present but the dhash/integrity rows skipped.
{
  const partial = {
    workload: 'partial',
    spans: [{ id: 'bootMs', ms: 'n/a', from: 'a', to: 'b', clock: 'mono', scope: 'proc' }],
    frames: [{ index: 0, settled: false }],
  };
  const dom = new JSDOM(buildBenchmarkPanelHtml(partial, NONCE));
  const doc = dom.window.document;
  assert(doc.querySelector('.headline').textContent.trim().startsWith('\u2014'), 'partial run panel headline is an em-dash (non-numeric ms)');
  assert(doc.querySelector('.headline small').textContent.includes('bootMs'), 'partial run panel labels the first span (bootMs) as primary');
  assert(doc.body.textContent.includes('no captured frame'), 'partial run panel shows no-frame (frame lacks a fingerprint)');
  const cells = [...doc.querySelectorAll('td.v')].map((td) => td.textContent);
  assert(cells.some((c) => c.includes('mono / proc')), `partial run panel shows the span clock/scope stat, got: ${cells.join(' | ')}`);
  assert(!cells.some((c) => /\b[0-9a-f]{16}\b/.test(c)), 'partial run panel skips the dhash/integrity rows (no fingerprint)');
}

// 4c. trend panel, REGRESSING + DRIFTING: FAIL badge, over-baseline red markers, DRIFTING + BREACHED ceiling.
{
  const regress = {
    workload: 'lv', metric: 'launchMs', plane: 'WIN', hypervisor: 'vmware',
    values: [100, 120, 140], verdict: 'REGRESSION', regressed: true,
    baselineMs: 100, toleranceMs: 10, driftThresholdMsPerRun: 5, drifting: true,
    slopeMsPerRun: 20, latest: 140, stats: { mean: 120, median: 120, min: 100, max: 140, stddev: 16, spread: 40 },
  };
  const dom = new JSDOM(buildTrendPanelHtml(regress, NONCE));
  const doc = dom.window.document;
  const badge = doc.querySelector('.badge');
  assert(badge && badge.textContent.trim() === 'REGRESSION' && badge.classList.contains('fail'), `regressing trend shows the REGRESSION fail badge, got: ${badge && badge.textContent}`);
  assert(doc.querySelector('svg.chart circle[fill="#ff7b72"]'), 'regressing trend paints over-baseline runs with the red marker');
  assert(doc.body.textContent.includes('DRIFTING'), 'regressing trend reports the drift verdict');
  assert(doc.body.textContent.includes('BREACHED'), 'regressing trend reports the breached regression ceiling');
}

// 4d. trend panel, VERDICT-ABSENT + not regressed + no tolerance -> computed PASS, stable drift, no ceiling.
{
  const noVerdict = {
    workload: 'lv', metric: 'launchMs', plane: 'LINUX', hypervisor: 'vbox',
    values: [90, 92, 91], regressed: false, driftThresholdMsPerRun: 5, drifting: false,
    slopeMsPerRun: 0.5, latest: 91, stats: { median: 91 },
  };
  const dom = new JSDOM(buildTrendPanelHtml(noVerdict, NONCE));
  const doc = dom.window.document;
  const badge = doc.querySelector('.badge');
  assert(badge && badge.textContent.trim() === 'PASS' && badge.classList.contains('pass'), `verdict-absent trend computes PASS, got: ${badge && badge.textContent}`);
  assert(doc.body.textContent.includes('stable'), 'verdict-absent trend reports the stable drift verdict');
  assert(!doc.body.textContent.includes('regression ceiling'), 'verdict-absent trend omits the ceiling legend (no tolerance)');
}

// 4e. trend panel, SINGLE run (n=1), verdict-absent + regressed -> computed REGRESSION, one marker, no polyline.
{
  const single = { workload: 'lv', metric: 'launchMs', values: [200], regressed: true, stats: {} };
  const dom = new JSDOM(buildTrendPanelHtml(single, NONCE));
  const doc = dom.window.document;
  const svg = doc.querySelector('svg.chart');
  assert(doc.querySelector('.badge').textContent.trim() === 'REGRESSION', 'single-run + regressed computes REGRESSION');
  assert(!svg.querySelector('polyline'), 'single-run trend draws no series polyline (n<2)');
  assert(svg.querySelectorAll('circle').length === 2, `single-run trend draws one marker + the latest ring, got ${svg.querySelectorAll('circle').length}`);
}

// 4f. trend panel, EMPTY (n=0) -> no markers, no polyline.
{
  const empty = { workload: 'lv', metric: 'launchMs', values: [], stats: {} };
  const dom = new JSDOM(buildTrendPanelHtml(empty, NONCE));
  const doc = dom.window.document;
  const svg = doc.querySelector('svg.chart');
  assert(svg.querySelectorAll('circle').length === 0, 'empty trend draws no run markers');
  assert(!svg.querySelector('polyline'), 'empty trend draws no polyline');
}

// 4g. cross-plane trend, NON-PASS verdict + a MISSING plane + null witness deltas + no flags + an empty series.
{
  const failReceipt = {
    workload: 'lv', metric: 'launchMs', verdict: 'REVIEW',
    witness: { meanDeltaMs: 5, status: 'within', toleranceMs: 20, faster: 'LINUX' },
    linux: { hypervisor: 'vbox', mean: 90, median: 91, spread: 4, slopeMsPerRun: 0.2, verdict: 'PASS' },
    flags: [],
  };
  const dom = new JSDOM(buildCrossPlaneTrendPanelHtml(failReceipt, { values: [] }, { values: [90, 91, 92] }, NONCE));
  const doc = dom.window.document;
  const badge = doc.querySelector('.badge');
  assert(badge && badge.textContent.trim() === 'REVIEW' && badge.classList.contains('fail'), `cross-plane non-PASS verdict badge, got: ${badge && badge.textContent}`);
  assert(doc.body.textContent.includes('WIN (?)'), 'cross-plane panel falls back to ? for the absent WIN hypervisor');
  assert(doc.querySelectorAll('.card').length === 2, `cross-plane panel renders no WIN plane card (witness + LINUX only), got ${doc.querySelectorAll('.card').length}`);
  assert(doc.querySelectorAll('svg.chart polyline').length === 1, 'cross-plane panel draws only the non-empty (LINUX) series polyline');
  assert(doc.body.textContent.includes('none'), 'cross-plane panel shows no flags');
}

// 4h. resource panel, DEGENERATE: <2 samples (empty sparklines), a missing window, a negative delta.
{
  const degRc = {
    workload: 'lv', plane: 'WIN', hypervisor: 'vmware', launchMs: 3000, triggerEpochMs: 1000,
    samples: [{ epochMs: 1000, cpuPct: 5, ramMb: 10, diskPct: 1 }],
    windows: { cpu: { pre: { mean: 50 }, post: { mean: 40 }, deltaMean: -10 }, disk: { pre: {}, post: {}, deltaMean: 0 } },
    preSampleCount: 0, postSampleCount: 1, triggerFrameIndex: 0, hostGuestOffsetMs: 0,
  };
  const dom = new JSDOM(buildResourcePanelHtml(degRc, NONCE));
  const doc = dom.window.document;
  assert(doc.querySelectorAll('svg').length === 3, 'resource panel still renders three metric svgs');
  assert(doc.querySelectorAll('svg polyline').length === 0, 'resource panel draws no sparkline polylines (< 2 samples)');
  assert(doc.body.textContent.includes('\u2014'), 'resource panel shows an em-dash for the missing-window means');
  assert(doc.body.textContent.includes('-10'), 'resource panel shows the negative CPU delta');
}

// 4i. cross-plane resource, NON-PASS + a DISAGREE metric + a MISSING metric (no RAM headline) + negative delta.
{
  const degCross = {
    workload: 'lv', verdict: 'REVIEW', win: { hypervisor: 'vmware' }, linux: { hypervisor: 'vbox' }, launchDeltaMs: -5,
    metrics: {
      cpu: { status: 'disagree', win: { deltaMean: -3 }, linux: { deltaMean: 2 }, agreementDelta: 5, toleranceDelta: 1, witness: true },
      disk: { status: 'agree', win: {}, linux: {}, agreementDelta: 0, toleranceDelta: 1 },
    },
  };
  const dom = new JSDOM(buildCrossPlaneResourcePanelHtml(degCross, NONCE));
  const doc = dom.window.document;
  const badge = doc.querySelector('h2 .badge');
  assert(badge && badge.textContent.trim() === 'REVIEW' && badge.classList.contains('fail'), `cross-plane resource non-PASS badge, got: ${badge && badge.textContent}`);
  assert(doc.body.textContent.includes('DISAGREE'), 'cross-plane resource shows the DISAGREE metric status');
  assert(doc.body.textContent.includes('AGREE'), 'cross-plane resource shows the AGREE metric status');
  assert(doc.body.textContent.includes('witness'), 'cross-plane resource tags the witnessed metric');
  assert(doc.body.textContent.includes('-3'), 'cross-plane resource shows the negative WIN delta');
  assert(!doc.body.textContent.includes('RAM agreement:'), 'cross-plane resource omits the RAM headline when the ram metric is absent');
}

// 4j. cross-plane TREND, both series EMPTY -> the degenerate chart (nMax<=1, empty domain, no polylines) still
//     renders its frame, and receipt flags (when present) are listed rather than 'none'.
{
  const dom = new JSDOM(buildCrossPlaneTrendPanelHtml(
    { workload: 'lv', metric: 'launchMs', verdict: 'PASS', witness: { meanDeltaMs: 0, status: 'within', toleranceMs: 10, faster: 'none' }, flags: ['degenerate'] },
    { values: [] }, { values: [] }, NONCE,
  ));
  const doc = dom.window.document;
  assert(doc.querySelector('svg.chart'), 'cross-plane trend renders the chart frame even when both series are empty');
  assert(doc.querySelectorAll('svg.chart polyline').length === 0, 'cross-plane trend with empty series draws no polylines');
  assert(doc.body.textContent.includes('degenerate'), 'cross-plane trend lists the receipt flags when present');
}

// --- 5. shipped scrubber-model mappers + dhash guard: media/benchmark-panels.mjs also ships the frame-scrubber
//        model builders (the GATED experiment scrubber's data source, not the extension's current correlator)
//        + the dhash grid helpers. Prove the shipped API (verify-benchmark-panels.mjs is the exhaustive guard).
{
  let badHex = false;
  try { dhashGridCells('not-16-hex-str'); } catch { badHex = true; }
  assert(badHex, 'dhashGridCells rejects non-dhash-64 input (the single-source dhash guard)');

  const sm = scrubberModelFromTrend(trend, { pinDhash: record.frames[0].perceptualFingerprint });
  assert(sm.points.length === trend.values.length && sm.selectedIndex === trend.values.length - 1, 'scrubberModelFromTrend maps one point per run, latest selected');
  assert(sm.points.every((p) => typeof p.image === 'string' && p.image.startsWith('data:image/svg+xml')), 'each scrubber point carries the UI-READY frame as a data: svg image');
  assert(sm.points[0].metricValue === Number(trend.values[0]), 'scrubber points carry the run metric value');
  const smDefault = scrubberModelFromTrend(trend);
  assert(smDefault.points[0].image.startsWith('data:image/svg+xml'), 'scrubberModelFromTrend uses a neutral pin grid when none is supplied');
  let noVals = false;
  try { scrubberModelFromTrend({ values: [] }); } catch { noVals = true; }
  assert(noVals, 'scrubberModelFromTrend throws on an empty trend');

  const rm = scrubberModelFromRecord(record);
  assert(rm.points.length >= 1 && rm.points[rm.points.length - 1].image.startsWith('data:image/svg+xml'), 'scrubberModelFromRecord maps fingerprinted frames to scrubber points');
  let noFrames = false;
  try { scrubberModelFromRecord({ frames: [] }); } catch { noFrames = true; }
  assert(noFrames, 'scrubberModelFromRecord throws when the record has no fingerprinted frames');
}

console.log(
  'panels-render: PASS -- the single-run + trend panels render their real launchMs/verdict/stats, and the ' +
    'frame correlator renders its CPU/RAM/disk curves + captured screenshot and tracks the red scrub line (jsdom).'
);
process.exit(0);
