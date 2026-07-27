/**
 * LBA dashboard next-horizon (Discussion #2365, task lba-dashboard):
 * headless-Chromium interaction proof for the benchmark frame-scrubber shell,
 * mirroring vagrant/playwright/viPreviewViewerInteraction.cjs. It builds the
 * shipped document from buildBenchmarkFrameScrubberHtml.mjs over a synthetic
 * points model and asserts the user-facing behavior: the VERTICAL slider scrubs
 * the benchmark timeline, snapping the LOWER frame pane to the nearest-preceding
 * frame-start; arrow keys page frame-to-frame; the benchmark readout + selected
 * marker track the scrubbed instant.
 *
 * hosted CI stays browser-free -- this driver is NOT in package.json and NOT in
 * npm test. Run it with an ephemeral Playwright + cached Chromium:
 *   dir=$(mktemp -d); (cd "$dir" && npm init -y >/dev/null && npm i playwright >/dev/null)
 *   NODE_PATH="$dir/node_modules" node experiments/dashboard-slider/scrubberInteraction.playwright.cjs
 */

'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log('  ok   ' + label);
  } else {
    failures += 1;
    console.log('  FAIL ' + label + (detail ? '  -- ' + detail : ''));
  }
}

// Three distinct 1x1 PNGs (red / green / blue) so the displayed frame is
// visually and byte-distinguishable per selection.
const IMG = {
  a: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  b: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA0eEd6QAAAABJRU5ErkJggg==',
  c: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYPhfDwAEhQGAiHqV/AAAAABJRU5ErkJggg=='
};

async function main() {
  const mod = await import(
    pathToFileURL(path.join(__dirname, 'buildBenchmarkFrameScrubberHtml.mjs')).href
  );
  const model = {
    title: 'Scrubber Interaction Proof',
    metricLabel: 'cpuUsagePercent',
    selectedIndex: 0,
    points: [
      { pointId: 'frame-0000', label: '00:00:00.00', centiseconds: 0, metricValue: 17.5, image: IMG.a, isFrameStart: true },
      { pointId: 'frame-0012', label: '00:00:00.12', centiseconds: 12, metricValue: 44.0, image: IMG.b, isFrameStart: true },
      { pointId: 'frame-0030', label: '00:00:00.30', centiseconds: 30, metricValue: 9.25, image: IMG.c, isFrameStart: true }
    ]
  };
  const html = mod.buildBenchmarkFrameScrubberHtml(model, 'proof-nonce-0001');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.setContent(html, { waitUntil: 'load' });

  const state = () => page.evaluate(() => {
    const root = document.getElementById('bfs-root');
    const img = document.querySelector('.bfs-img');
    const readout = document.querySelector('.bfs-readout');
    const slider = document.querySelector('.bfs-slider');
    return {
      selectedIndex: root ? root.getAttribute('data-selected-index') : null,
      selectedPointId: root ? root.getAttribute('data-selected-point-id') : null,
      imgSrc: img ? img.getAttribute('src') : null,
      readout: readout ? readout.textContent : null,
      sliderType: slider ? slider.getAttribute('type') : null,
      sliderWritingMode: slider ? getComputedStyle(slider).writingMode : null
    };
  });
  const scrub = (cs) => page.evaluate((v) => {
    const s = document.querySelector('.bfs-slider');
    s.value = String(v);
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }, cs);
  const arrow = (key) => page.evaluate((k) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  }, key);

  // structural
  const s0 = await state();
  check('slider is a range input', s0.sliderType === 'range', s0.sliderType);
  check('slider is vertical (writing-mode)', /vertical/.test(s0.sliderWritingMode || ''), s0.sliderWritingMode);
  check('initial selection = frame 0', s0.selectedIndex === '0' && s0.selectedPointId === 'frame-0000', JSON.stringify(s0));
  check('initial frame = image A', s0.imgSrc === IMG.a);
  check('initial readout shows 1/3 + metric', /cpuUsagePercent/.test(s0.readout) && /1\/3/.test(s0.readout), s0.readout);

  // scrub to 20 -> nearest-preceding frame-start = frame 1 (cs12)
  await scrub(20);
  const s20 = await state();
  check('scrub 20 -> frame 1 (nearest-preceding)', s20.selectedIndex === '1' && s20.selectedPointId === 'frame-0012', JSON.stringify(s20));
  check('scrub 20 -> frame pane shows image B', s20.imgSrc === IMG.b);
  check('scrub 20 -> readout 2/3 @ .12', /2\/3/.test(s20.readout) && /00:00:00\.12/.test(s20.readout), s20.readout);

  // scrub to 30 -> frame 2
  await scrub(30);
  const s30 = await state();
  check('scrub 30 -> frame 2', s30.selectedIndex === '2' && s30.imgSrc === IMG.c, JSON.stringify(s30));

  // scrub to 5 -> back to frame 0 (cs0 precedes 5, cs12 does not)
  await scrub(5);
  const s5 = await state();
  check('scrub 5 -> frame 0 (preceding)', s5.selectedIndex === '0' && s5.imgSrc === IMG.a, JSON.stringify(s5));

  // arrow paging: Up = later, Down = earlier
  await arrow('ArrowUp');
  const up1 = await state();
  check('ArrowUp -> frame 1', up1.selectedIndex === '1' && up1.imgSrc === IMG.b, JSON.stringify(up1));
  await arrow('ArrowUp');
  const up2 = await state();
  check('ArrowUp again -> frame 2', up2.selectedIndex === '2' && up2.imgSrc === IMG.c, JSON.stringify(up2));
  await arrow('ArrowDown');
  const dn1 = await state();
  check('ArrowDown -> frame 1', dn1.selectedIndex === '1' && dn1.imgSrc === IMG.b, JSON.stringify(dn1));

  check('no uncaught page errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  await browser.close();

  console.log('');
  if (failures > 0) {
    console.error('scrubberInteraction: ' + failures + ' check(s) FAILED');
    process.exit(1);
  }
  console.log('scrubberInteraction: all checks passed (headless Chromium)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
