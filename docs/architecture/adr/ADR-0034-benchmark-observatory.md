# ADR-0034: Benchmark Observatory — the suite-wide coverage + determinism map

- Status: Accepted
- Date: 2026-08-02
- Deciders: operator directive (2026-08, "think bigger") + agent
- Relates to: LBA-REQ-054, ADR-0031 (cross-plane benchmark grid), ADR-0033 (2-actor icon-editor grid), docs/roadmap.md (Phase 2 — the real benchmark suite)

## Context

The suite now has several benchmark **types** — VI Analyzer, Mass Compile, the icon-editor
**PPL build** (ADR-0033 builder), and the icon-editor **LUnit test** (ADR-0033 tester) — run
across several **planes** — the bare-metal Linux host, the golden VM `lba-golden`, the NI
LabVIEW container, and a Windows box. The cross-plane grid (ADR-0031) proves determinism
*per benchmark*, but it only folds in VI Analyzer + Mass Compile and offers no suite-wide
view: there is no single artifact that answers **what has been measured, where, whether it
reproduces, and what to measure next**. As the suite grows along its axes (benchmark type ×
plane × OS × hardware × LabVIEW version), that map becomes the product.

## Decision

Introduce the **Benchmark Observatory** (`benchmark-observatory@1`), a governed artifact
*above* the grid that:

- folds **every** committed benchmark receipt into one **benchmark-type × plane coverage
  matrix** (a cell is filled iff that benchmark ran on that plane, carrying its identity +
  performance);
- keeps the **determinism ledger** — a benchmark's identity (`resultHash`) must **agree**
  across the planes it ran on; performance is expected to differ;
- exposes the empty `(benchmark, plane)` cells as a data-driven **frontier** — the concrete
  next measurements;
- is **derived** from the committed receipts (pure + offline), regenerated in the `lba verify`
  pipeline into `docs/benchmarks/benchmark-observatory.md`, and gated fail-closed by
  `benchmark-observatory` on a determinism violation, a coverage matrix that contradicts the
  receipts, a stale surface, a forged verdict, or a tampered digest.

It **composes with** — does not replace — the grid (ADR-0031) and the 2-actor icon-editor grid
(ADR-0033); new benchmark types, planes, and projects slot in as receipts.

## Consequences

- The whole suite is now one map: **4 benchmark types × 5 planes**, 2 cross-plane-proven
  (Mass Compile across host + golden VM + Windows, VI Analyzer across host + scratch VM),
  2 pending (PPL build, LUnit test — single-plane so far), 0 determinism violations, ~35 %
  cell coverage.
- The **frontier turns the roadmap into data**: 13 unmeasured cells (e.g. PPL build on the
  host / golden VM / Windows, LUnit test on the host / container / Windows) are the concrete
  next benchmarks — pick a cell, produce a receipt, the coverage + determinism update
  themselves.
- The observatory is the natural home for future growth (more projects reproduced as
  build+test actors, more planes over the WIN↔LINUX bus, more LabVIEW versions), advancing
  roadmap Phase 2 (the real benchmark suite) toward an observable, extensible determinism +
  performance observatory.
