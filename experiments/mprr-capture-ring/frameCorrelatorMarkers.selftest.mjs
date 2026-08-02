// Self-test for the frame-correlator CLICK-TO-MARKER wiring (LBA-REQ-011, extended per performance-counter-schema.json).
//
// Browser-free: asserts the built document embeds the click-to-marker runtime + renders pre-seeded markers, and
// anchors the SPEC the inline runtime mirrors against the AUTHORITATIVE frameMarkers.mjs primitives
// (classifyPointerGesture click-vs-drag + resolveMarkerImageGrab nearest-image-within-tolerance). The LIVE
// behavioral parity (a real pointer click drops a marker; a drag scrubs; the image grab respects the tolerance)
// is proven by the committed Playwright receipt (frameCorrelatorMarkers.playwright.cjs). Deterministic.
// Run: node frameCorrelatorMarkers.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { buildFrameCorrelatorHtml } from './frame-correlator.mjs';
import { classifyPointerGesture, resolveMarkerImageGrab, DEFAULT_MARKER_TOLERANCE_MS } from '../resource-usage-correlation/frameMarkers.mjs';

let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

const frames = [
  { index: 0, tMs: 0, cpuPct: 10, ramMb: 100, diskPct: 2, imageSrc: 'vscode-webview://x/f0.png' },
  { index: 1, tMs: 83, cpuPct: 40, ramMb: 130, diskPct: 8, imageSrc: 'vscode-webview://x/f1.png' },
  { index: 2, tMs: 167, cpuPct: 22, ramMb: 120, diskPct: 5, imageSrc: 'vscode-webview://x/f2.png' },
];

// --- built document embeds the click-to-marker runtime + tolerance ---
{
  const html = buildFrameCorrelatorHtml({ title: 'markers', fps: 12, selectedIndex: 0, frames }, 'nonce-1', 'vscode-webview://x');
  for (const token of ['classifyGesture', 'dropMarkerAtClientX', 'grabNearestImage', 'instantMsFromClientX', 'data-marker-count', "type: 'frame-marker'"]) {
    assert.ok(html.includes(token), `runtime must embed ${token}`);
  }
  assert.ok(html.includes('id="fc-markreadout"'), 'document has a marker readout element');
  assert.ok(/CLICK a spot to drop a marker/i.test(html), 'the hint documents click-to-marker');
  ok('built document embeds the click-to-marker runtime + marker readout + hint');
}

// --- pre-seeded markers are embedded in the model island (rendered as pins at load) ---
{
  const markers = [{ id: 'seed-a', frameIndex: 1, kind: 'seed' }];
  const html = buildFrameCorrelatorHtml({ title: 'seed', fps: 12, selectedIndex: 0, frames, markers, markerToleranceMs: 200 }, 'nonce-2', '');
  const island = JSON.parse(html.match(/<script id="fc-model"[^>]*>([\s\S]*?)<\/script>/)[1].replace(/\\u003c/g, '<'));
  assert.equal(island.markers.length, 1, 'seeded marker survives into the model island');
  assert.equal(island.markers[0].frameIndex, 1);
  assert.equal(island.markerToleranceMs, 200, 'tolerance carried into the runtime');
  ok('pre-seeded markers + tolerance are embedded in the model island');
}

// --- AUTHORITATIVE spec the runtime mirrors: classifyPointerGesture (click vs drag) ---
{
  assert.equal(classifyPointerGesture({ downX: 100, upX: 102, downY: 50, upY: 51 }, 4), 'click', 'small movement -> click (drops a marker)');
  assert.equal(classifyPointerGesture({ downX: 100, upX: 160, downY: 50, upY: 52 }, 4), 'drag', 'large movement -> drag (scrubs)');
  ok('authoritative classifyPointerGesture: small move -> click, large move -> drag');
}

// --- AUTHORITATIVE spec the runtime mirrors: nearest-image-within-tolerance grab ---
{
  const capFrames = frames.map((f) => ({ index: f.index, captureEpochMs: f.tMs, image: f.imageSrc }));
  const near = resolveMarkerImageGrab(90, capFrames, DEFAULT_MARKER_TOLERANCE_MS); // 7 ms from frame 1
  assert.equal(near.admitted, true, 'a click near a frame grabs its image within tolerance');
  assert.equal(near.nearestFrameIndex, 1);
  assert.equal(near.imageRef, 'vscode-webview://x/f1.png');
  const far = resolveMarkerImageGrab(500, capFrames, 50); // >50 ms from any frame
  assert.equal(far.admitted, false, 'a click far from every frame grabs NO image (never a wrong-frame image)');
  assert.equal(far.imageRef, null);
  ok('authoritative resolveMarkerImageGrab: within tolerance -> image, outside -> none');
}

console.log(`\nframeCorrelatorMarkers.selftest: ${passed}/${passed} checks passed`);
