/**
 * LBA dashboard next-horizon (Discussion #2365, task lba-dashboard):
 * headless-Chromium proof that the SHIPPED mprr synchronized-review surface
 * (with WIN's merged vertical-slider-scrubs-timepoint nav mode, mprr develop
 * @ 42cc73b) actually scrubs on Linux. Unlike scrubberInteraction.playwright.cjs
 * (which proves OUR builder), this loads the REAL emitted surface index.html
 * over file:// (relative packet-derived-image refs resolve) and drives its
 * #scrub-slider, asserting the lower #packet-image tracks the nearest-preceding
 * frame -- the cross-repo closing proof that the shipped product carries the
 * working slider.
 *
 * Generate a surface first, then run with ephemeral Playwright (cached Chromium):
 *   node <mprr>/scripts/runReviewCaptureSuccessorShadowDashboardSynchronizedReviewSurface.js --output-dir /tmp/lba-merged/surface --json
 *   dir=$(mktemp -d); (cd "$dir" && npm init -y >/dev/null && npm i playwright >/dev/null && npx playwright install chromium >/dev/null)
 *   SURFACE_HTML=/tmp/lba-merged/surface/index.html NODE_PATH="$dir/node_modules" node experiments/dashboard-slider/mprrSurfaceScrub.playwright.cjs
 */

'use strict';

const fs = require('fs');
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

async function main() {
  const htmlPath = process.env.SURFACE_HTML || '/tmp/lba-merged/surface/index.html';
  if (!fs.existsSync(htmlPath)) {
    console.error('surface not found at ' + htmlPath + ' -- generate it first (see header).');
    process.exit(2);
  }
  const url = 'file://' + htmlPath;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(url, { waitUntil: 'load' });

  const snapshot = () => page.evaluate(() => {
    const slider = document.getElementById('scrub-slider');
    const img = document.getElementById('packet-image');
    return {
      type: slider ? slider.getAttribute('type') : null,
      writingMode: slider ? getComputedStyle(slider).writingMode : null,
      min: slider ? parseFloat(slider.min) : null,
      max: slider ? parseFloat(slider.max) : null,
      value: slider ? slider.value : null,
      img: img ? img.getAttribute('src') || '' : null
    };
  });
  const setSlider = (v) => page.evaluate((val) => {
    const s = document.getElementById('scrub-slider');
    s.value = String(val);
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);

  const init = await snapshot();
  check('shipped surface has #scrub-slider range input', init.type === 'range', init.type);
  check('scrub-slider is vertical', /vertical/.test(init.writingMode || ''), init.writingMode);
  check('client JS set slider max > min from points', init.max > init.min, 'min=' + init.min + ' max=' + init.max);
  check('lower pane shows a packet-derived frame', /packet-derived-images\//.test(init.img || ''), init.img);
  const firstImg = init.img;

  await setSlider(init.max);
  const atMax = await snapshot();
  check('scrub to max -> a later frame (nearest-preceding end)', Boolean(atMax.img) && atMax.img !== firstImg, 'first=' + firstImg + ' atMax=' + atMax.img);

  await setSlider(init.min);
  const atMin = await snapshot();
  check('scrub to min -> back to the first frame', atMin.img === firstImg, 'atMin=' + atMin.img);

  check('no uncaught page errors in the shipped surface', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  console.log('');
  if (failures > 0) {
    console.error('mprrSurfaceScrub: ' + failures + ' check(s) FAILED');
    process.exit(1);
  }
  console.log('mprrSurfaceScrub: all checks passed (shipped mprr surface, headless Chromium, file://)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
