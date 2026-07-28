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

`screenshot.mjs` renders the viewer at a **fixed viewport + fixed series + animations disabled** and captures a
PNG plus its SHA-256, twice, asserting the two are **byte-identical** (determinism). The PNG + hash are the
baseline for **cross-plane visual repeatability**: LINUX and WIN each capture the same deterministic shot of
the deployed viewer and compare hashes, so the next agent can do a deterministic visual regression across both
planes. See `docs`/the coordination bus for the mprr-fed series once absorbed.
