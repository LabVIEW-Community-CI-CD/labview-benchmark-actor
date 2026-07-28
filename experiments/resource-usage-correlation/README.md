# experiment: resource-usage-correlation (LBA-REQ-011, T-011)

Correlates **CPU, RAM, and disk** usage samples to the benchmark **frame
timeline** and, anchored on a **trigger** instant, computes a **pre/post-trigger
window analysis** per metric — the "read CPU/RAM/disk before vs after the
trigger" capability for post-processing.

The trigger is intended to be the LabVIEW **Getting-Started-Window-visible**
frame (or the benchmark-start marker): capturing the GSW onto a frame gives a
frame index whose epoch anchors the pre-window (baseline) and post-window
(cold-launch pressure) reads.

## Module

[`resourceUsageCorrelation.mjs`](resourceUsageCorrelation.mjs) — pure,
dependency-free ESM. `buildResourceUsageCorrelation(input)`:

- **Input:** `{ frameRateHz = 12, epochMsAtFrameZero, triggerEpochMs, samples[] }`,
  each sample `{ epochMs, cpuPct?, ramMb?, diskPct? }` (any order; a metric may be
  `null` when its counter was absent).
- **Output** (`labview-benchmark-actor/resource-usage-correlation@v1`):
  - each sample resolved to a `frameIndex` (floor of elapsed / frame interval;
    `null` before frame zero — the same rule the picture-cursor viewer uses,
    LBA-REQ-005), plus `sinceTriggerMs` and a `pre`/`post` phase;
  - `triggerFrameIndex`;
  - `windows.{cpu,ram,disk}` each with a `pre` and `post` summary
    (`count`, `mean`, `min`, `max`) and `deltaMean = post.mean − pre.mean`.

Sampling (typeperf / logman / Get-Counter) and the live GSW capture live in the
capture harness (the maintainer / VM step); this module is pure so it stays a
re-runnable local-gate artifact.

## Self-test + receipt

[`verify-resource-correlation.mjs`](verify-resource-correlation.mjs) exercises
the module over a canonical synthetic CPU/RAM/disk series (GSW-visible trigger at
frame 12; CPU/RAM/disk `deltaMean` 37.25 / 227.5 / 23.75) and writes a
**deterministic** [`receipt.json`](receipt.json) (no timestamps, byte-stable).

```
node experiments/resource-usage-correlation/verify-resource-correlation.mjs
```

The receipt is re-validated by the local gate
(`node experiments/verify-local-gates.mjs`, check
`resource-usage-correlation-receipt-green`).
