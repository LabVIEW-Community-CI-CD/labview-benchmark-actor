// Self-test for frameMarkers.mjs -- the click-to-marker +/-200 ms image-grab core (LBA-REQ-011 ext).
// Deterministic, dependency-free. Run: node frameMarkers.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import {
  resolveMarkerImageGrab, buildMarker, classifyPointerGesture,
  FRAME_MARKER_SCHEMA, DEFAULT_MARKER_TOLERANCE_MS
} from './frameMarkers.mjs';

let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// 12 FPS capture clock: frame 0 at epoch 1000, 83.333.. ms/frame.
const epoch0 = 1000;
const frameIntervalMs = 1000 / 12;
// captured frames at frame instants (index * interval + epoch0), each with an image ref.
const frames = Array.from({ length: 12 }, (_, i) => ({
  index: i, captureEpochMs: epoch0 + i * frameIntervalMs, image: `frame-${i}.png`
}));

// --- resolveMarkerImageGrab ---
{
  // Exact hit on frame 5's capture instant -> admitted, that image.
  const t = frames[5].captureEpochMs;
  const r = resolveMarkerImageGrab(t, frames);
  assert.equal(r.nearestFrameIndex, 5);
  assert.equal(r.deltaMs, 0);
  assert.equal(r.admitted, true);
  assert.equal(r.imageRef, 'frame-5.png');
  ok('exact hit -> nearest frame admitted with its image');
}
{
  // 150 ms after frame 5 -> nearest is 5 or 6; within 200 ms -> admitted.
  const r = resolveMarkerImageGrab(frames[5].captureEpochMs + 150, frames, 200);
  assert.equal(r.admitted, true);
  assert.ok(r.deltaMs <= 200);
  assert.ok(typeof r.imageRef === 'string');
  ok('within tolerance (150 ms) -> admitted');
}
{
  // A gap: drop frames 6..11 so the nearest to t=frame5+250ms is frame 5 (delta 250 > 200) -> NOT admitted.
  const sparse = frames.slice(0, 6); // frames 0..5
  const t = frames[5].captureEpochMs + 250;
  const r = resolveMarkerImageGrab(t, sparse, 200);
  assert.equal(r.nearestFrameIndex, 5);
  assert.equal(r.deltaMs, 250);
  assert.equal(r.admitted, false);
  assert.equal(r.imageRef, null); // no wrong-frame image attached
  ok('outside tolerance (250 ms) -> NOT admitted, no image');
}
{
  // Boundary: exactly 200 ms -> admitted (<=).
  const t = frames[5].captureEpochMs + 200;
  const r = resolveMarkerImageGrab(t, frames.slice(0, 6), 200);
  assert.equal(r.deltaMs, 200);
  assert.equal(r.admitted, true);
  ok('boundary (exactly 200 ms) -> admitted (inclusive)');
}
{
  // No frames / empty -> miss.
  const r = resolveMarkerImageGrab(1234, [], 200);
  assert.deepEqual(r, { nearestFrameIndex: null, nearestCaptureEpochMs: null, deltaMs: null, admitted: false, imageRef: null });
  ok('no frames -> miss (not admitted)');
}
{
  // Tie: two frames equidistant (+/-50) -> keep the EARLIER frame deterministically.
  const two = [
    { index: 3, captureEpochMs: 1000, image: 'a.png' },
    { index: 4, captureEpochMs: 1100, image: 'b.png' }
  ];
  const r = resolveMarkerImageGrab(1050, two, 200);
  assert.equal(r.nearestFrameIndex, 3);
  assert.equal(r.deltaMs, 50);
  ok('equidistant tie -> earlier frame wins (deterministic)');
}
{
  // Admitted but the frame has no image -> imageRef null (admitted true).
  const r = resolveMarkerImageGrab(1000, [{ index: 0, captureEpochMs: 1000 }], 200);
  assert.equal(r.admitted, true);
  assert.equal(r.imageRef, null);
  ok('admitted frame without an image -> imageRef null');
}
{
  // Guard: negative tolerance throws.
  assert.throws(() => resolveMarkerImageGrab(1000, frames, -1));
  ok('negative tolerance -> throws');
}

// --- buildMarker ---
{
  const t = frames[7].captureEpochMs + 40; // within tolerance of frame 7
  const m = buildMarker(t, { epochMsAtFrameZero: epoch0, frameIntervalMs, frames, seq: 2, now: 0 });
  assert.equal(m.schema, FRAME_MARKER_SCHEMA);
  assert.equal(m.frameIndex, 7);
  assert.equal(m.label, 'marker 2');
  assert.equal(m.kind, 'user-click');
  assert.equal(m.id, `m-${Math.round(t)}-2`);
  assert.equal(m.createdAt, '1970-01-01T00:00:00.000Z');
  assert.equal(m.imageGrab.toleranceMs, 200);
  assert.equal(m.imageGrab.admitted, true);
  assert.equal(m.imageGrab.nearestFrameIndex, 7);
  ok('buildMarker -> frameIndex + default label + admitted image within tolerance');
}
{
  // Custom label + a click far from any frame -> not admitted.
  const m = buildMarker(epoch0 + 5000, { epochMsAtFrameZero: epoch0, frameIntervalMs, frames, label: 'GSW visible', seq: 1, now: 0 });
  assert.equal(m.label, 'GSW visible');
  assert.equal(m.imageGrab.admitted, false);
  assert.equal(m.imageGrab.imageRef, null);
  ok('buildMarker -> custom label + far click not admitted');
}
{
  assert.equal(DEFAULT_MARKER_TOLERANCE_MS, 200);
  ok('default tolerance is 200 ms');
}

// --- classifyPointerGesture (click vs scrub-drag) ---
{
  assert.equal(classifyPointerGesture({ downX: 100, upX: 102, downY: 50, upY: 51 }), 'click');
  assert.equal(classifyPointerGesture({ downX: 100, upX: 140, downY: 50, upY: 52 }), 'drag');
  assert.equal(classifyPointerGesture(null), 'drag'); // fail-safe: unknown gesture is a drag (no accidental marker)
  ok('classifyPointerGesture -> small move = click, large move = drag, unknown = drag');
}

console.log(`\nframeMarkers.selftest: ${passed}/${passed} checks passed`);
