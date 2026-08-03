# ADR-0064: The mesh carries a second benchmark family — the mesh fulfillment engine is benchmark-generic (LBA-REQ-083)

- Status: Accepted
- Date: 2026-08-03
- Deciders: roadmap Phase 2 ⇄ Phase 3 convergence (the benchmark suite meets the actor mesh) + operator ("think bigger" + "become prescriptive") + agent
- Relates to: LBA-REQ-083 (realized here), LBA-REQ-073 / ADR-0054 (the mesh fulfillment engine reused), LBA-REQ-081 / ADR-0062 (the VI Analyzer trend adapter reused), LBA-REQ-072 / ADR-0053 (the launch benchmark this run is distinct from)

## Context

The actor mesh (Phase 3, LBA-REQ-072..080) and the cross-plane benchmark suite (Phase 2, LBA-REQ-081..082) grew as
two separate threads, and they meet at a gap: the mesh has only ever fulfilled ONE benchmark — the IDE launch
benchmark (LBA-REQ-072). Every committed mesh receipt is a launch run. The mesh fulfillment engine (LBA-REQ-073)
is written generically (it validates any `workload-trend@1` and any `launchIdentity`), but nothing PROVES it
carries more than launch — so "the mesh runs the benchmark suite" is an unproven claim. The VI Analyzer benchmark
now has real two-plane captures and a proven cross-plane identity (LBA-REQ-081), so it is the natural second family
to run through the mesh and close the gap.

## Decision

- **Govern "the mesh carries a second benchmark family" as LBA-REQ-083** with a pure, rg-free verifier
  (`experiments/mesh-fulfillment/viAnalyzerMeshRun.mjs`) + a committed run record
  (`mesh-run-vi-analyzer-family.json`) + a selftest (7/7) + the gate `mesh-benchmark-family-vi-analyzer`.
- **REUSE both engines with no new logic.** The two golden-VM actors (golden-linux, golden-win) each return their VI
  Analyzer `workload-trend@1` via `trendFromEvidence` (LBA-REQ-081, from the committed
  `vi-analyzer-trend-live-evidence@1` captures); the LBA-REQ-073 `meshFulfillment.buildReceipt` / `validateReceipt`
  decides the cross-plane fulfillment. No fulfillment logic is duplicated — the same engine that fulfils launch
  fulfils VI Analyzer.
- **A `mesh-benchmark-family-run@1`** wraps the fulfillment with the genericity proof: the run is `carried` iff the
  embedded LBA-REQ-073 fulfillment is proven AND the benchmark identity is the VI Analyzer identity AND that
  identity is DISTINCT from the launch identity (so the mesh demonstrably carries more than one benchmark).
  `validateFamilyRun` fails closed if the fulfillment is not proven, the actor receipts do not descend from the
  real committed evidence, the run is not the VI Analyzer benchmark, it is not distinct from launch, or the digest
  is tampered.
- **The gate** `mesh-benchmark-family-vi-analyzer` proves, offline + deterministically: the selftest (7/7); the
  committed run re-derives from the two committed VI Analyzer captures via the CLI; the mesh carried a benchmark
  distinct from launch; the carried benchmark is VI Analyzer (the same identity the LBA-REQ-081 parity proves); and
  the embedded fulfillment is a real LBA-REQ-073 cross-plane fulfillment (≥ 2 distinct actors, both planes).

## Consequences

- **The mesh provably carries more than one benchmark** — launch (LBA-REQ-072/073) and now VI Analyzer (this ADR) —
  so "the mesh runs the benchmark suite cross-plane" is now a proven claim, not an aspiration. The mesh fulfillment
  engine is demonstrably benchmark-generic, mirroring the parity engine's genericity (LBA-REQ-081).
- **The two roadmap threads converge** — the Phase-2 benchmark suite (the VI Analyzer family + its trend adapter)
  and the Phase-3 mesh (the fulfillment engine) compose into one run, grounded in the same real captures that back
  the VI Analyzer parity (LBA-REQ-081). The mesh coverage observatory (LBA-REQ-075) can fold this run to show the
  mesh spanning two benchmarks.
- **Adding further families is an instantiation, not new machinery** — a mass-compile or unit-test mesh run (once
  real two-plane captures exist) is the same adapter + `buildFamilyRun`, with no new fulfillment logic.
- Grounded in REAL committed captures (the two `vi-analyzer-trend-live-evidence@1` files), with no fabricated data;
  the gate is DETERMINISTIC + offline, consistent with the rg-free / tool-free CI constraint. Authored under the
  singular-requirement directive (one `shall`).
