# ADR-0053: Cross-plane launch-benchmark parity — identity is the benchmark spec, not the series (LBA-REQ-072)

- Status: Accepted
- Date: 2026-08-03
- Deciders: roadmap Phase 2/4 (the real benchmark suite + Linux⇄Windows parity — the §8 success metric "identical identity for the same benchmark across planes") + agent
- Relates to: LBA-REQ-072 (realized here), LBA-REQ-014 (mprr cross-plane parity via `seriesHash` — the sibling, but a deterministic memory series), LBA-REQ-015 / LBA-REQ-043 (VI Analyzer parity via `resultHash`), LBA-REQ-050 (the cross-plane benchmark grid), LBA-REQ-054 (the Benchmark Observatory), LBA-REQ-055 (the launch-capture beacon), the committed launch trends `media/labview-launch-trend{,-win}.json` (`workload-trend@1`)

## Context

The flagship exact-12-FPS **launch-to-ready** benchmark (`workload-trend@1`, metric `launchMs`, workload
`labview-ide-launch`) is the canonical cross-plane payload: the Linux golden VM launches LabVIEW in ~2604 ms, the
Windows one in ~2410 ms (both committed). Existing cross-plane PARITY is governed only for benchmarks whose
measured value is deterministic + plane-INDEPENDENT: the mprr ring-buffer `seriesHash` (LBA-REQ-014, byte-identical
memory series) and the VI Analyzer `resultHash` (LBA-REQ-015/043). The launch benchmark is fundamentally different
— its measured quantity (elapsed time) is inherently plane-DEPENDENT, so there is no identical series/result to
anchor on. Today's launch cross-plane receipts (`cross-plane-trend`, `resource-cross-plane`) compare timing/resource
deltas as WITNESSES; nothing proves the two planes ran the SAME launch benchmark, which is the precondition that
makes their timings legitimately comparable.

## Decision

- **Govern cross-plane launch-benchmark parity as LBA-REQ-072** with a committed fail-closed receipt
  (`experiments/launch-parity/cross-plane-launch-parity-receipt.json`, schema
  `cross-plane-launch-parity-receipt@1`) + a pure, rg-free verifier (`launchParity.mjs`) + a selftest (7/7) + the
  gate **`cross-plane-launch-parity`**.
- **The identity is the benchmark SPEC, not the series.** `launchIdentity` = sha256 over `{ metric, workload, n }`
  (what was measured + how + the sample count) — deliberately EXCLUDING the plane-dependent timing, the plane, and
  the hypervisor. Two planes running the same launch benchmark share this machine-independent identity; that
  shared identity is exactly what licenses comparing their timings.
- **Timing is a plane-specific PERFORMANCE WITNESS, never identity.** The receipt records each plane's mean/median
  + the signed delta (WIN − LINUX), the delta as a % of the LINUX mean, and the faster plane — but none of that
  enters the identity. Parity is proven iff both receipts are valid `workload-trend@1`, they are cross-plane (one
  LINUX + one WIN), and their launch identities match. It fails closed on an identity mismatch (a different
  metric/workload/sample-count = a different benchmark), a non-cross-plane pair, an invalid trend, or a tampered
  digest.
- The committed receipt is **derived from the real committed launch trends** (`media/labview-launch-trend{,-win}.json`);
  the gate re-derives it and asserts the plane means equal the real trend means, so the parity receipt cannot be
  fabricated apart from the real launch data.

## Consequences

- **The roadmap §8 parity metric is now realized for the flagship launch benchmark** — Linux and Windows launch
  runs are provably the same benchmark, so the calibration/grid/observatory can compare + discount them with a
  fail-closed identity guarantee. This complements (does not duplicate) the deterministic-series parity of
  LBA-REQ-014/015/043.
- **A new plane joins by emitting a `workload-trend@1` with the same `{ metric, workload, n }`** — its identity
  matches automatically; only its timing differs. Refreshing = re-capturing the launch trends + rebuilding the
  receipt (the digest re-derives, the gate re-verifies).
- The gate is DETERMINISTIC + offline (no VM / LabVIEW / network at gate time), consistent with the rg-free /
  tool-free CI constraint. Authored under the singular-requirement directive (one `shall`).
