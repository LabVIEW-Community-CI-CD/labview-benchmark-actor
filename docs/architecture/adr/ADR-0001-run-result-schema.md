# ADR-0001: Run-result schema — metrics and time-indexed pictures on one clock

- Status: Proposed
- Owner: WIN
- Traces to: LBA-REQ-003 (and the viewer contract in LBA-REQ-004/005)
- Standards baseline: `repo-standards-review` v0.2.19

## Context

The agentic actor drives a benchmark run and the viewer renders it. These are
different lanes (and will run on different VMs), so they need a stable contract.
The viewer's core feature — scrub a time cursor and see the picture captured at
that time (LBA-REQ-004/005) — only works if metrics and pictures share **one
run clock** and pictures are resolvable by time in sub-linear time.

## Decision

Define a single **schema-versioned run-result** as the actor↔viewer contract.

- **Envelope:** `{ schema: "labview-benchmark-actor/run-result@1", runId, startedAt, clock, metrics, frames }`.
- **Run clock:** `clock` declares the unit (`"ms"`) and origin (`"run-start"`);
  every sample and frame carries a `t` that is **run-relative** on this clock.
  There is exactly one clock per run.
- **Metrics:** `metrics` is a list of named series, each an ordered array of
  `{ t, v }` sorted ascending by `t`. Multiple series may share the chart.
- **Frames (pictures):** `frames` is an ordered array of
  `{ index, t, ref, w, h }` sorted ascending by `t`, where `ref` is a
  content-addressed pointer (path or hash) to the captured image and `index` is
  its ordinal. Frames are **not** required to be evenly spaced.
- **Resolution rule:** the frame for a selected time `T` is the last frame with
  `t <= T` (nearest-at-or-before). With frames sorted by `t`, this is an
  O(log n) binary search. If `T < frames[0].t`, there is no frame (viewer shows
  the explicit no-frame state).
- **Versioning:** the `schema` string is the version gate; a viewer refuses a
  major it does not understand rather than mis-rendering.
- **Reproducibility:** two runs on the same golden VM + inputs produce
  equivalently-shaped results; numeric variance is bounded and the bound is
  recorded in the run result (`clock`/metadata), satisfying LBA-REQ-003.3.

## Consequences

- **+** Viewer and actor evolve independently behind one versioned contract.
- **+** Cursor→picture is deterministic and O(log n) (enables smooth scrubbing,
  LBA-REQ-004.3 / LBA-REQ-005).
- **+** Content-addressed `ref` lets frames be stored/transported separately
  from the metric envelope (large images off the hot path).
- **−** Requires the actor to stamp every sample/frame on the run clock at
  capture time; a late/monotonic-clock bug would desync metrics and pictures
  (mitigated by a schema validation test, T-003).
- **Open:** frame `ref` transport across VMs (inline vs fetched over the bus) is
  a transport concern — defer to the LINUX bus ADRs (ADR-0003/0004).
