// Shared, pinned perceptual-fingerprint primitive for `manual-procedure-record-v1` (dhash-64).
//
// SINGLE SOURCE OF TRUTH: the LINUX correlate-seal producer AND the WIN cross-iteration frame-diff
// both import THIS module, so "same fingerprintAlgo" is guaranteed bit-identical BY CONSTRUCTION,
// not by two independently-written specs agreeing. dhash-64 is integer-only (no floating-point DCT
// or median), so the fingerprint is deterministic across Node versions / OS / plane — the property a
// MUST-match cross-plane artifact requires (why dhash-64 over phash-dct-64; see PR #147 discussion).
//
// dhash-64 spec (PINNED — changing any step is a fingerprintSpecVersion bump):
//   1. Input: raw decoded pixels as RGBA (Uint8Array | number[], length >= width*height*4), row-major,
//      8 bits/channel. PNG decode is LOSSLESS, so identical PNG bytes => identical RGBA => identical hash.
//   2. Downscale to 9x8 by NEAREST-NEIGHBOR (integer source-index map; no interpolation/averaging).
//   3. Grayscale by INTEGER Rec.601 luma:  g = (77*R + 150*G + 29*B) >> 8   (77 + 150 + 29 = 256).
//   4. Row-major difference hash: for each of the 8 rows, 8 comparisons `g[x] > g[x+1]` -> 1 bit (64 bits).
//   5. Pack the 64 bits MSB-first into 16 lowercase hex chars.

export const FINGERPRINT_ALGO = 'dhash-64';
export const FINGERPRINT_SPEC_VERSION = 1;

const OUT_W = 9; // 9 columns -> 8 horizontal comparisons per row
const OUT_H = 8; // 8 rows -> 8*8 = 64 bits

/**
 * Compute the pinned dhash-64 fingerprint of a raw RGBA frame.
 * @param {Uint8Array|number[]} rgba row-major RGBA, length >= width*height*4
 * @param {number} width source width in pixels
 * @param {number} height source height in pixels
 * @returns {string} 16 lowercase hex chars (64 bits)
 */
export function dhash64FromRgba(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('dhash64FromRgba: positive integer width/height required');
  }
  if (rgba.length < width * height * 4) {
    throw new Error(`dhash64FromRgba: rgba too small (${rgba.length} < ${width * height * 4})`);
  }
  const gray = new Int32Array(OUT_W * OUT_H);
  for (let oy = 0; oy < OUT_H; oy += 1) {
    const sy = Math.floor((oy * height) / OUT_H);
    for (let ox = 0; ox < OUT_W; ox += 1) {
      const sx = Math.floor((ox * width) / OUT_W);
      const p = (sy * width + sx) * 4;
      gray[oy * OUT_W + ox] = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2]) >> 8;
    }
  }
  const bits = new Array(64);
  let bi = 0;
  for (let oy = 0; oy < OUT_H; oy += 1) {
    for (let ox = 0; ox < OUT_W - 1; ox += 1) {
      const a = gray[oy * OUT_W + ox];
      const b = gray[oy * OUT_W + ox + 1];
      bits[bi] = a > b ? 1 : 0;
      bi += 1;
    }
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    const nib = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
    hex += nib.toString(16);
  }
  return hex;
}

/**
 * Hamming distance between two equal-length lowercase-hex fingerprints (the visual-delta MAGNITUDE
 * the cross-iteration frame-diff consumes). 0 = pixel-identical downsample; higher = larger visual delta.
 * @param {string} a hex fingerprint
 * @param {string} b hex fingerprint
 * @returns {number} number of differing bits
 */
export function hammingHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    throw new Error('hammingHex: two equal-length hex strings required');
  }
  let d = 0;
  for (let i = 0; i < a.length; i += 1) {
    const na = parseInt(a[i], 16);
    const nb = parseInt(b[i], 16);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      throw new Error(`hammingHex: non-hex nibble at ${i}`);
    }
    let x = na ^ nb;
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}
