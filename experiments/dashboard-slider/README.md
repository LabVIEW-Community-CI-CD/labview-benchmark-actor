# Benchmark frame-scrubber shell (LBA next horizon)

Discussion #2365, task `lba-dashboard`. The **vi-history-suite half** of the
benchmark frame-scrubber dashboard: the human target is a dashboard whose
**upper half holds the benchmark** (a metric graph over the capture timeline)
with a **vertical slider**, and whose **lower half shows the captured frame**
(the packet-derived image) at the scrubbed instant. Moving the vertical slider
scrubs the benchmark timeline and the lower half navigates to the captured
frame, snapping to the **nearest-preceding frame-start** (mprr timepoint
resolver `benchmarkSelectionMode "nearest-preceding-frame-start"`).

This shell **composes** existing mprr primitives (it does not re-plumb them):

- `runReviewCaptureSuccessorRuntimePacketDerivedImageReader.js` reconstructs the
  byte-equivalent frame from the long-packet payload (**pure Node**, confirmed
  cross-platform on Linux).
- the shadow-dashboard **timepoint resolver** + **synchronized review surface**
  emit `successor-shadow-dashboard-synchronized-review-state-v1` (`points[]`,
  `graphMetricField`, `selectedPointId`).

and reuses the shipped [`viPreviewFramesViewer.ts`](../../../../src/reporting/viPreview/viPreviewFramesViewer.ts)
pattern: a strict **nonce CSP**, a **JSON island**, and an inline runtime with
pan / zoom / Fit and keyboard paging. WIN then folds the proven markup into the
mprr synchronized-review surface as a new `timestampNavigationMode`.

## Files

| File | Role |
| --- | --- |
| `buildBenchmarkFrameScrubberHtml.mjs` | pure builder: model + nonce -> self-contained HTML; exports `resolveNearestPrecedingIndex` (the authoritative snap semantic) |
| `scrubberModelFromState.mjs` | maps mprr `synchronized-review-state-v1` + packet-derived images into the scrubber model |
| `verify-scrubber.mjs` | deterministic Node self-test (snap semantic, HTML invariants, real-state mapper); no browser |
| `scrubberInteraction.playwright.cjs` | headless-Chromium interaction proof of OUR builder (slider scrub, arrow paging, frame swap) |
| `mprrSurfaceScrub.playwright.cjs` | headless-Chromium proof against the SHIPPED mprr surface (merged nav mode) over `file://` |

## Run

Node self-test (deterministic, no browser):

```bash
node experiments/dashboard-slider/verify-scrubber.mjs
# optional real state:
VIHS_SCRUBBER_STATE=/path/to/synchronized-review-state.json \
  node experiments/dashboard-slider/verify-scrubber.mjs
```

Headless-Chromium interaction proof (hosted CI stays browser-free, so Playwright
is **not** a committed dependency — install it ephemerally with the cached
Chromium):

```bash
dir=$(mktemp -d); (cd "$dir" && npm init -y >/dev/null && npm i playwright >/dev/null && npx playwright install chromium >/dev/null)
NODE_PATH="$dir/node_modules" node experiments/dashboard-slider/scrubberInteraction.playwright.cjs
```

## Producing a real state to scrub (Linux, portable output dir)

```bash
cd <mprr>
node scripts/runReviewCaptureSuccessorShadowDashboardSynchronizedReviewSurface.js \
  --output-dir /tmp/lba-dash-linux/surface --json
VIHS_SCRUBBER_STATE=/tmp/lba-dash-linux/surface/successor-shadow-dashboard-synchronized-review-state.json \
  node experiments/dashboard-slider/verify-scrubber.mjs
```

Pass an explicit `--output-dir` on non-WSL Linux: the mprr self-test profile
bakes a WSL-style `/mnt/e/...` default. mprr MR !138 added a portable derivation
(`MPRR_SELF_TEST_SURFACE_ROOT` env override, then an `os.tmpdir()` scratch on
win32), but a bare Linux run still keeps the baked `/mnt/e` (WSL back-compat).

## Merged into mprr (loop closed)

WIN folded the proven slider into the mprr synchronized-review surface as the
`vertical-slider-scrubs-timepoint` `timestampNavigationMode`, and **made it the
default** -- the shipped surface *is* the scrubber (mprr `develop` @ `42cc73b`,
after MR !138 path-portability round 2). `mprrSurfaceScrub.playwright.cjs` drives
the real emitted surface over `file://` and confirms it scrubs on Linux (the
slider is a vertical range input, the client JS derives the range from the
points, and `#packet-image` tracks the nearest-preceding frame). Design ->
fold-in -> merge -> cross-platform browser proof, closed.
