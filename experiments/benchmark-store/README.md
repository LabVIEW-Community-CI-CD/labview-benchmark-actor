# Benchmark ring-buffer store (big-drive, cross-plane compare)

Operator direction: *use the large drive to store data from the ring buffer so LINUX and WIN can compare
against each other's benchmark.* A capacity-oriented store that persists each plane's **raw ring-buffer
capture** (mprr dual-packet-stream / Windows zero-copy ring buffer — mprr ADR-0031/0032) **by reference** plus
the **derived metrics**, keyed by a shared `benchmarkId` so the two planes' runs of the SAME benchmark can be
compared deterministically.

## Why a separate drive

The ring-buffer capture is large (a rolling packet stream); the code/repo is not the place for it. The store
root is **caller/env supplied** (`LBA_BENCHMARK_STORE_ROOT`) — the big drive on this box
(`/run/media/sergio/Data/lba-benchmark-store`, ~226 GB free), WIN's drive on theirs. No machine path is baked
into `benchmarkStore.mjs`; only the maintainer `init-store-on-drive.mjs` knows this box's default.

## Layout

```
<root>/store-index.json          # small append-only index of every run (schema benchmark-store@v1)
<root>/<plane>/<runId>/run.json  # metadata + metrics + ringBufferRef/framesRef (schema benchmark-run@v1)
<root>/<plane>/<runId>/ring-buffer.ndjson   # the LARGE capture, referenced not copied into the index
```

## API (`benchmarkStore.mjs`, dependency-free)

- `openStore(root)` / `resolveStoreRoot(explicit?)` — open/create; root from arg or `LBA_BENCHMARK_STORE_ROOT`.
- `registerRun(store, { plane, runId, benchmarkId, metrics, ringBufferRef, ... })` — LINUX|WIN only.
- `listRuns` / `readRun`.
- `crossPlaneCompare(store, benchmarkId)` — pairs the LINUX run and the WIN run of the same benchmark and
  reports: `deltas` (numeric metrics, WIN vs LINUX, absolute + % of LINUX) **and** `digests` (string metrics —
  the deterministic `seriesHash` MUST match cross-plane; the per-plane screenshot `pngSha256` is a visual
  witness reported with `match: false` when the rasters differ, which is expected across OSes). Throws unless
  BOTH planes have registered the benchmark — so a comparison never silently runs against one plane.
- `compareRuns(benchmarkId, linuxMetrics, winMetrics)` — the pure comparison over two loose run records (the
  store-free core `crossPlaneCompare` delegates to). Lets `compare-cross-plane.mjs` compare a LINUX run.json
  against a WIN run.json the other plane sends over, without both being in one store.

## Cross-plane workflow (LINUX ⇄ WIN)

1. Each plane captures a benchmark's ring buffer, stages the large capture under its store, and `registerRun`s
   it with the **shared `benchmarkId`** (LINUX writes to its drive, WIN to theirs).
2. Exchange the two `run.json` records (small — over the bus or a synced folder; the large capture stays on the
   drive it was captured on unless a diff needs the raw stream).
3. `crossPlaneCompare(store, benchmarkId)` → deterministic LINUX-vs-WIN metric deltas, so the **next agent** can
   repeat the comparison and get the same numbers (repeatability).

## Ties to the rest

- The per-run `metrics` feed the **LBA-REQ-010** corpus: `ingestCorpusManifest` → `concentrate` →
  `ollama-comparison` explains the run-over-run / cross-plane change.
- Paired with the **deterministic screenshot** harness (`playwright/`), a benchmark can be compared both
  numerically (metric deltas) and visually (byte-identical PNG per plane) for full cross-plane repeatability.
- The absorbed **mprr ring** (`experiments/mprr-ring/`) is the first real producer: `register-mprr-run.mjs`
  ingests the committed short-packet fixture, stages the derived ring-buffer capture on the drive by
  reference, and registers a run under `benchmarkId=mprr-short-ring-fixture` carrying `seriesHash` (the
  deterministic cross-plane anchor) and, when present, the screenshot `pngSha256` witness.

Run the self-test: `node experiments/benchmark-store/verify-benchmark-store.mjs` (gated by verify-local-gates).
Instantiate on this box's drive: `node experiments/benchmark-store/init-store-on-drive.mjs`.
Register the mprr benchmark run (each plane): `node experiments/benchmark-store/register-mprr-run.mjs`.
Compare two planes' runs (the LBA-REQ-014 evidence): `node experiments/benchmark-store/compare-cross-plane.mjs
<linux-run.json> <win-run.json>` — emits `cross-plane-comparison-receipt.json` and exits non-zero unless the
deterministic `seriesHash` matches across planes.
