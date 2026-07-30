// Self-test for the pinned dhash-64 fingerprint primitive (fingerprint.mjs).
// Dependency-free + deterministic (synthetic RGBA frames): proves the properties the cross-plane
// frame-diff relies on. Exits 0 on pass, 1 on failure.
//   node experiments/manual-procedure-record/fingerprint.selftest.mjs

import { dhash64FromRgba, hammingHex, FINGERPRINT_ALGO, FINGERPRINT_SPEC_VERSION } from './fingerprint.mjs';

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    console.error(`FAIL  ${name}`);
    failures += 1;
  }
}

// Build a width*height RGBA frame from a pixel function (x,y) -> [r,g,b].
function frame(width, height, fn) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = fn(x, y);
      const p = (y * width + x) * 4;
      rgba[p] = r & 255;
      rgba[p + 1] = g & 255;
      rgba[p + 2] = b & 255;
      rgba[p + 3] = 255;
    }
  }
  return { rgba, width, height };
}

const W = 160;
const H = 120;
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// A mid-range structured pattern with real HORIZONTAL variation (dhash is a horizontal difference
// hash, so a monotonic gradient would degenerate to an all-0 hash — this pattern does not).
// Range 80..175 so a +40 brightness shift never clamps/wraps (keeps the brightness-robustness test honest).
const base = frame(W, H, (x, y) => {
  const v = 80 + ((x * 131 + y * 57) % 96);
  return [v, v, v];
});
// Same pattern, brightness +40 (a gamma/exposure shift the VMware capture might introduce).
const bright = frame(W, H, (x, y) => {
  const v = clamp(80 + ((x * 131 + y * 57) % 96) + 40);
  return [v, v, v];
});
// Same pattern with a black rectangle painted in the middle third (a STRUCTURAL / UI change).
const rect = frame(W, H, (x, y) => {
  if (x > W / 3 && x < (2 * W) / 3 && y > H / 3 && y < (2 * H) / 3) return [0, 0, 0];
  const v = 80 + ((x * 131 + y * 57) % 96);
  return [v, v, v];
});
// A different structure entirely (different spatial frequencies).
const different = frame(W, H, (x, y) => {
  const v = 80 + ((x * 211 + y * 29) % 96);
  return [v, v, v];
});

const hBase = dhash64FromRgba(base.rgba, W, H);
const hBase2 = dhash64FromRgba(base.rgba, W, H);
const hBright = dhash64FromRgba(bright.rgba, W, H);
const hRect = dhash64FromRgba(rect.rgba, W, H);
const hDiff = dhash64FromRgba(different.rgba, W, H);

check('algo id is dhash-64', FINGERPRINT_ALGO === 'dhash-64');
check('spec version is an integer', Number.isInteger(FINGERPRINT_SPEC_VERSION));
check('fingerprint is 16 lowercase hex chars', /^[0-9a-f]{16}$/.test(hBase));
check('fingerprint is non-degenerate (not all one nibble)', !/^(.)\1{15}$/.test(hBase));
check('deterministic: same input -> identical fingerprint', hBase === hBase2);
check('identical frames -> Hamming 0', hammingHex(hBase, hBase) === 0);

const dBright = hammingHex(hBase, hBright);
const dRect = hammingHex(hBase, hRect);
const dDiff = hammingHex(hBase, hDiff);
console.log(`      distances: brightness=${dBright} rectangle=${dRect} differentStructure=${dDiff}`);

check('brightness shift is robust (small Hamming)', dBright <= 6);
check('structural rectangle change is detected (Hamming > 0)', dRect > 0);
check('a different structure reads as a bigger delta than brightness', dDiff > dBright);
check('hammingHex rejects length mismatch', (() => {
  try { hammingHex('abcd', 'abcdef'); return false; } catch { return true; }
})());
check('hammingHex rejects non-hex', (() => {
  try { hammingHex('zzzzzzzzzzzzzzzz', hBase); return false; } catch { return true; }
})());

if (failures > 0) {
  console.error(`\nfingerprint.selftest: ${failures} FAILED`);
  process.exit(1);
}
console.log('\nfingerprint.selftest: all checks passed (dhash-64 deterministic + robust + sensitive).');
