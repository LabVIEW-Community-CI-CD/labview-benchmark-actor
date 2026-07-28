# viewer-cursor (LBA-REQ-004)

Deterministic core for the benchmark viewer's **draggable time cursor**: map pointer + keyboard input to a
selected point on the time (X) axis, always clamped to the run's recorded window. Pure + immutable, so the
interaction logic is testable independent of the browser/webview render (T-004).

## Contract

- `createCursor(samples)` — a cursor over a non-decreasing time axis, starting at the first sample.
- `setPointer(cursor, xFraction)` — pointer drag: `xFraction` in `[0,1]` of the chart width maps to a time
  in the run window and snaps to the **nearest sample**; out-of-range fractions clamp to the bounds.
- `step(cursor, delta)` — keyboard: arrow keys step by one sample (`+1` / `-1`), clamped (no wrap).
- `jump(cursor, 'start' | 'end')` — Home / End jump to the run's start / end sample.
- `selectedIndex` / `selectedTime` — the current selection. **No operation can select outside**
  `[samples[0], samples[n-1]]`.

The selected time is the single source of truth for the linked picture panel (LBA-REQ-005).

## Verify

```
node experiments/viewer-cursor/verify-viewer-cursor.mjs [--json]
```

Runs the dependency-free self-test (no browser) and writes `receipt.json`. Proves pointer/keyboard mapping,
Home/End jumps, continuous drag updates, and the no-out-of-range invariant. Re-validated by
`experiments/verify-local-gates.mjs`.

## Scope

The interaction **logic** is proven here (moves LBA-REQ-004 from Planned to Partial). The browser/webview
render over the real mprr short-packet `timingTicks64` axis is the UI/maintainer step (Partial -> Proven
later).
