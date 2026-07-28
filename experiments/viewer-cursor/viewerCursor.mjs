#!/usr/bin/env node
// Benchmark viewer time-cursor logic (LBA-REQ-004): map pointer + keyboard input to a selected point on
// the time (X) axis, always clamped to the run's recorded window. Dependency-free ESM; pure + immutable, so
// the interaction logic is deterministically testable independent of the browser/webview render (T-004).
//
// The cursor position is the single source of truth for the linked picture panel (LBA-REQ-005): keep them
// bound to one selected-time value. Every operation returns a NEW cursor and can never select outside the
// bounds [samples[0], samples[n-1]].

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

/** Create a cursor over a non-decreasing time axis (sample times). Starts at the first sample. */
export function createCursor(samples) {
  assert(Array.isArray(samples) && samples.length > 0, 'samples must be a non-empty time axis');
  for (let i = 1; i < samples.length; i += 1) {
    assert(samples[i] >= samples[i - 1], 'samples must be non-decreasing (a time axis)');
  }
  return { samples, index: 0 };
}

export function selectedIndex(cursor) {
  return cursor.index;
}

export function selectedTime(cursor) {
  return cursor.samples[cursor.index];
}

// Clamp an index into [0, n-1] so a cursor can never select outside the recorded window.
function withIndex(cursor, index) {
  const n = cursor.samples.length;
  const clamped = Math.max(0, Math.min(n - 1, index));
  return { samples: cursor.samples, index: clamped };
}

/**
 * Pointer drag: `xFraction` is the pointer position as a fraction [0,1] of the chart width. It maps to a
 * time within the run window and snaps to the NEAREST sample. Out-of-range fractions clamp to the bounds.
 */
export function setPointer(cursor, xFraction) {
  const f = Math.max(0, Math.min(1, xFraction));
  const { samples } = cursor;
  const start = samples[0];
  const end = samples[samples.length - 1];
  const t = start + f * (end - start);
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < samples.length; i += 1) {
    const d = Math.abs(samples[i] - t);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return withIndex(cursor, best);
}

/** Keyboard: arrow keys step the cursor by one sample (delta +1 / -1); clamped at the bounds (no wrap). */
export function step(cursor, delta) {
  return withIndex(cursor, cursor.index + delta);
}

/** Home / End: jump to the run's start or end sample. */
export function jump(cursor, where) {
  assert(where === 'start' || where === 'end', "where must be 'start' or 'end'");
  return withIndex(cursor, where === 'start' ? 0 : cursor.samples.length - 1);
}
