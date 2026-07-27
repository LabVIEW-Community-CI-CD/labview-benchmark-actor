# ADR-0002: Viewer — a single selected-time source of truth

- Status: Proposed
- Owner: WIN
- Traces to: LBA-REQ-004 (draggable cursor), LBA-REQ-005 (time-indexed picture)
- Standards baseline: `repo-standards-review` v0.2.19

## Context

The benchmark viewer shows a metric chart with a draggable vertical cursor and,
below it, the picture captured at the cursor's time. The failure mode to design
out is **desynchronization** — the picture lagging or disagreeing with the
cursor. Both widgets read the same run-result (ADR-0001).

## Decision

Model the viewer around **one piece of state: `selectedTimeMs`** (run-relative,
on the ADR-0001 clock).

- **Single writer:** only the cursor interaction writes `selectedTimeMs`
  (pointer drag, or keyboard: arrow = ±one sample, Home/End = run start/end).
  The value is clamped to `[frames/metrics min t, max t]` so no selection falls
  outside the recorded window (LBA-REQ-004.2).
- **Readers:** the chart renders the cursor at `selectedTimeMs`; the picture
  panel resolves the frame via the ADR-0001 nearest-at-or-before rule and shows
  it with its `index` and `t` labels. Both derive from the same value, so they
  cannot disagree (LBA-REQ-005.2).
- **Smooth scrubbing:** during a pointer drag, update the cursor's transform and
  the selected-time readout on each input event **without a full chart
  re-render** (transform-only); resolve+swap the picture on the same frame. This
  keeps dragging smooth (LBA-REQ-004.3).
- **No-frame state:** when the resolver returns none (selected time before the
  first frame), the panel renders an explicit "no frame at this time" state, not
  a stale image (LBA-REQ-005.3).
- **Accessibility:** the cursor is a labeled slider-like control; keyboard
  paging and an ARIA value (current time) are first-class, not mouse-only.

## Consequences

- **+** Cursor and picture are structurally synchronized (one value, many
  readers) — the core UX guarantee.
- **+** Deterministic + unit-testable: given a run-result and a `selectedTimeMs`,
  the resolved frame index and cursor position are pure functions (T-004/T-005),
  with a browser harness for the interaction layer.
- **+** Transform-only cursor updates decouple scrub smoothness from chart size.
- **−** A very dense frame set makes the picture swap the drag bottleneck;
  mitigate by decoding/caching the neighborhood of `selectedTimeMs`.
- **Open:** whether the chart is Canvas or SVG (perf vs a11y) — a UI-detail
  follow-up, not blocking this binding decision.
