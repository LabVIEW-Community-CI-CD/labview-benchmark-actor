# Mesh-stress performance-signature calibration (design + ladder plan)

**Status: design-spec — no live runs yet.** Schema: [mesh-stress-signature-schema.json](mesh-stress-signature-schema.json)
(`labview-benchmark-actor/mesh-stress-signature@v1`).

This experiment plans how to **re-verify the maximum achievable streaming-to-disk** (the MPRR visual-ring
frame→disk ceiling) under a **stressed host** while a **mesh of actors** each runs at a **different stress
level**, instrumented with the full **42-counter performance schema** per actor
([../resource-usage-correlation/performance-counter-schema.json](../resource-usage-correlation/performance-counter-schema.json)),
so we gather the initial metadata to **design + calibrate a performance-signature calibrator** for later
**ladder testing**. All actors run **on this host** (Windows guest mesh + Linux guest mesh).

## 1. Re-verify max achievable streaming to disk

The MPRR visual ring streams captured frames to disk (ADR-0005/0007/0009). "Maximum achievable" = the
**highest sustained frames/sec written with ZERO drops** (the drop-free ceiling) + the MB/sec at that ceiling.
Re-verification re-runs the streaming benchmark while sampling **all 42 counters per actor** and correlating
each sample to the **12 FPS** frame timeline (`performance-counter-correlation@v2`), then **refreshes the
committed receipt** as posted evidence. The primary dimensions of the ceiling are the disk-write counters
(`diskWriteBytesPerSec`, `diskAvgSecPerWrite`, `diskAvgQueueLength`, `procIoWriteBytesPerSec`) plus memory
headroom and kernel time. The ceiling is expected to **move as stress rises** — that movement is the signal.

## 2. Mesh + per-actor instrumentation

- **Placement:** all actors on this host. Mesh size `N` is sized to the host budget (≈60 GB RAM / 24 CPUs;
  ≈24 GB free with 2 VMs up) so `N` actor VMs + the host stressor fit without thrash; recorded per run.
- **Actor:** one VM running the actor + the in-guest 42-counter sampler + the MPRR ring streamer.
- **Per-actor instrumentation:** each actor samples the full catalog on its own clock; samples fold onto the
  host epoch-ms axis via a measured host↔guest offset (as in `resource-usage-correlation`). Linux actors map
  the catalog keys onto `/proc` + `/sys` equivalents; counters with no analogue sample `null` and are skipped.

## 3. Stress model — each actor at a *different* level

| Layer | Mechanism |
| --- | --- |
| **Host load** | `stress-ng` (cpu / mem / io-hdd) runs in the background so actors measure themselves on a **loaded** host. |
| **Per-actor workload** | a `stress-ng` / synthetic workload **inside** each actor VM sized to its level. |
| **Per-actor throttle** | bound the level with a VirtualBox CPU cap (`--cpuexecutioncap`) + IO bandwidth limit (`--bandwidthctl`) / Linux `cgroup io.max`. |

Levels: `idle · light · medium · heavy · saturate`. In **one** acquisition each actor is pinned to a
**different** level (a horizontal slice across the ladder). Each level is both **commanded** (workload+throttle)
and **measured** (the 42-counter signature); calibration compares commanded vs measured.

## 4. Performance signature

A **signature** fingerprints *this actor at this stress level on this host* as the **repetitive**
(structural/periodic) and **outlier** (anomalous) patterns extracted from the per-actor counter series **across
multiple repeated benchmarks**. Structure that survives repeats is the signature; what varies is the noise floor.

- **Per-counter features:** mean, std, p50/p95/p99, min/max, drift slope, dominant period + periodicity strength,
  outlier rate, outlier epochs.
- **Cross-counter:** counter pairs whose **outliers co-occur within ±200 ms** (shared-cause signature).
- **Repetition model:** run `R` repeats per (actor, level); a feature is *signature* when its across-repeat
  coefficient-of-variation ≤ a stability threshold, else *noise*.
- **Post-processing:** each outlier epoch becomes a **frame marker** (`frame-marker@v2`, ±200 ms image grab) so
  the captured frame at the anomaly is pulled for visual root-cause — tying back to the click-marker mechanism.

## 5. Calibrator + ladder

- **Ladder:** drive the mesh through **increasing stress rungs** (`idle → light → medium → heavy → saturate`),
  `R` repeats per rung, capturing a signature at each rung.
- **Calibrator input:** the per-rung signatures across the ladder × repeats, per actor, per plane.
- **Calibrator output:** a **calibration curve** per counter/feature (`stressRung → expected value + tolerance
  band` from the across-repeat variance), the **streaming-ceiling curve** vs rung, and an **inverse read**
  (observed signature → inferred stress level + confidence).
- **Fit:** monotone / piecewise-linear over the rungs; non-monotone rungs are flagged as instrumentation
  artifacts and dropped from the signature.
- **Design invariants:** *monotone* (salient features track the rung), *separable* (adjacent rungs' bands don't
  fully overlap for ≥K dimensions — the ladder is resolvable), *repeatable* (across-repeat CoV ≤ threshold).
- **Later ladder testing** replays the ladder and scores each rung's signature vs the calibrated curve
  (pass = within band; fail = drift/regression).

## 6. Evidence

A receipt in this directory will record: host budget, mesh size + per-actor commanded levels, the re-verified
max drop-free streaming ceiling **with all-42-counter correlation**, the extracted per-(actor,level) signatures,
the fitted calibration curve + ladder resolvability, and pass/fail vs the design invariants. The existing
max-streaming evidence (ADR-0005/0007, self-test-conformance receipts) is re-verified under the expanded schema
and the refreshed numbers are posted here.

## 7. Implementation follow-up (own requirement + gates)

Each a dependency-free engine + self-test + gate + a real receipt: the in-guest 42-counter samplers
(Windows PDH + Linux `/proc`), the stress orchestrator (host `stress-ng` + per-actor workload/throttle), the
live Windows & Linux mesh ladder runs, the signature extractor, and the calibration-curve fitter.
