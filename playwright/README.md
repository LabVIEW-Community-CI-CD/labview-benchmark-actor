# Playwright browser render harness (maintainer, LBA-REQ-004)

Real headless-Chromium render proof for the benchmark viewer webview. **Not shipped** in the `.vsix` and
**not a hosted CI gate** (hosted CI stays browser-free) — mirrors vi-history-suite's `vagrant/playwright`
viewer harness. Chromium is the same engine the VS Code extension-host webview renders in, so this is the
strongest render proof short of a live extension host.

## Run

```bash
# from the repo root, stage the shipped viewer cursor asset:
npm run compile
# then:
cd playwright
npm install
npx playwright install chromium
node viewer-render.mjs
```

`viewer-render.mjs` serves the shipped `media/viewer.js` (importing `media/viewerCursor.mjs`) over a tiny
local HTTP server, loads it in headless Chromium, and asserts:
1. the metric SVG **renders** (polyline + cursor line + selected dot),
2. **keyboard** (ArrowRight/End/Home) moves the time cursor,
3. a **real pointer drag** across the chart snaps the cursor to a late sample and moves the cursor line,
4. **no console errors**.

It writes `viewer-render-browser-receipt.json`.

## Deterministic screenshots (cross-plane visual inspection)

`screenshot.mjs` renders the shipped viewer over a **fixed mprr short-packet series** (the committed fixture
`experiments/mprr-ring/fixtures/short-packet-run.json` -> the absorbed ring core `ingestShortPackets` ->
`projectViewerSeries`), at a **fixed viewport + device scale + animations disabled**, drives the time cursor to
a **fixed sample**, and screenshots the `#chart` SVG. It captures the render **twice** in fresh contexts and
asserts the two PNGs are **byte-identical** (SHA-256) — per-plane repeatability.

```bash
npm run compile          # repo root: stage media/viewerCursor.mjs
cd playwright && npm install && npx playwright install chromium
node screenshot.mjs       # plane auto-detected (win32 => WIN, else LINUX); override with LBA_PLANE
```

It writes `screenshot-receipt-<PLANE>.json` (committed evidence) and `.artifacts/mprr-viewer-<PLANE>.png`
(gitignored). The receipt records:
- `seriesHash` — SHA-256 of the deterministic `[{ t, v }]` series. This is the **cross-plane anchor**:
  identical packets => identical series => **identical `seriesHash` on both planes**, because the mprr ring
  core is dependency-free and deterministic.
- `pngSha256` — the raster hash. This is **plane-specific** (cross-OS pixel-identity is not guaranteed: fonts
  and antialiasing differ). Its authority is *within* a plane (both captures byte-identical = repeatable).

**Cross-plane protocol:** LINUX and WIN each run `node screenshot.mjs` on the SAME committed fixture. Assert
`seriesHash` matches across planes (the data is identical); the per-plane `pngSha256` is the visual witness the
next agent inspects for repeatability. The two receipts feed the benchmark-store cross-plane comparison.

