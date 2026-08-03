# ADR-0062: Cross-plane VI Analyzer performance parity — the parity engine generalizes to a second benchmark family (LBA-REQ-081)

- Status: Accepted
- Date: 2026-08-03
- Deciders: roadmap Phase 2 (the real benchmark suite — "Linux ⇄ Windows parity per benchmark") + operator ("think bigger" + "become prescriptive") + agent
- Relates to: LBA-REQ-081 (realized here), LBA-REQ-072 / ADR-0053 (the launch-parity engine reused — `launchIdentity` / `decideParity` / `planeSummary` / `performanceWitness`), LBA-REQ-043 / ADR-0031 (cross-plane VI Analyzer DETERMINISM — the resultHash equivalence this complements + folds in), LBA-REQ-015 (the machine-independent VI Analyzer resultHash)

## Context

The cross-plane parity metric (roadmap §8 — "identical benchmark across Linux and Windows planes, timings
comparable") is proven for exactly one benchmark: the IDE launch-to-ready benchmark (LBA-REQ-072). The roadmap's
Phase 2 is the *suite* — VI Analyzer, mass-compile, unit-test — each with Linux ⇄ Windows parity. The VI Analyzer
benchmark already has real, committed two-plane evidence (`vi-analyzer-trend-live-evidence@1` for LINUX and WIN,
each six `LabVIEWCLI RunVIAnalyzer` runs of the shipped LabVIEWCLIExampleProject → 69 tests) and a governed
DETERMINISM proof (LBA-REQ-043: the resultHash is identical across planes — the *answer* matches). What was not
proven is cross-plane *performance* parity: that the two planes ran the SAME benchmark identity so their run times
are comparable performance witnesses. That is exactly the LBA-REQ-072 insight — separate the machine-independent
identity from the plane-dependent timing — and the launch-parity engine's core is benchmark-generic, so it should
extend to VI Analyzer with no new parity logic.

## Decision

- **Govern cross-plane VI Analyzer performance parity as LBA-REQ-081** with a pure, rg-free verifier
  (`experiments/vi-analyzer/viAnalyzerParity.mjs`) + a committed receipt
  (`cross-plane-vi-analyzer-parity-receipt.json`) + a selftest (7/7) + the gate `cross-plane-vi-analyzer-parity`.
- **REUSE the LBA-REQ-072 engine's generic core** — `launchIdentity` (the identity over `{ metric, workload, n }`),
  `trendOk`, `decideParity`, `planeSummary`, `performanceWitness` — proving that engine is not launch-specific. An
  adapter `trendFromEvidence` turns a committed `vi-analyzer-trend-live-evidence@1` capture into the
  `workload-trend@1` the engine consumes (the per-run `wallMs` become the trend values; PASS iff every run exited 0
  with no failed/errored tests).
- **The benchmark identity is `{ viAnalyzerMs, vi-analyzer-labviewcli-example, n }`** — both planes run the same
  LabVIEWCLIExampleProject config, so the identity matches while the run time is plane-dependent.
- **Fold in the determinism link.** A VI Analyzer run has a deterministic result (unlike launch), so the receipt is
  parity-proven only when the planes share BOTH the benchmark identity (comparable timing) AND the deterministic
  `resultHash` (LBA-REQ-043 — the same answer). This makes LBA-REQ-081 strictly stronger than a timing-only parity
  and ties the two VI Analyzer cross-plane proofs together.
- **The gate** `cross-plane-vi-analyzer-parity` proves, offline + deterministically: the selftest (7/7); the
  committed receipt re-derives byte-stably from the two committed evidence captures (via the CLI); parity is proven
  (cross-plane + identity match + resultHash match); and the receipt reflects the real captures. It fails closed on
  an identity mismatch, a non-cross-plane pair, a differing resultHash, an invalid trend, or a tampered digest.

## Consequences

- **The parity engine is proven benchmark-generic** — the launch-parity core now backs a second real family with no
  new parity logic, so adding mass-compile / unit-test parity (once real two-plane timing exists) is an adapter +
  a receipt, not a new engine.
- **VI Analyzer is now fully characterized cross-plane** — LBA-REQ-043 proves the two planes compute the same
  answer (resultHash), and LBA-REQ-081 proves they ran the same benchmark identity with comparable, witnessed run
  times (LINUX ~4.7 s mean vs WIN ~21 s mean, WIN dominated by a cold first-launch; the medians ~4.2 s vs ~5.9 s
  are the warm witnesses). Together they are the §8 parity metric for VI Analyzer.
- **The benchmark suite has grown to two families** — launch (072) + VI Analyzer (081) — advancing roadmap Phase 2
  and giving the mesh more than one benchmark to carry.
- Grounded in REAL committed captures (the two `vi-analyzer-trend-live-evidence@1` files, already git-tracked and
  gated for determinism by LBA-REQ-043's trend verifier), with no fabricated data; the gate is DETERMINISTIC +
  offline, consistent with the rg-free / tool-free CI constraint. Authored under the singular-requirement directive
  (one `shall`).
