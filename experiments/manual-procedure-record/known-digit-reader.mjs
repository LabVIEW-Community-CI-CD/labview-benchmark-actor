// known-digit-reader.mjs — deterministic, Linux-native known-digit reader for the
// manual-procedure deterministic record (experiments/manual-procedure-record).
//
// The stopwatch anchor is a MONOTONIC COUNTER the extension viewer renders as plain
// digits WE control. Reading it is therefore an EXACT template match against a fixed
// glyph set — not fuzzy OCR. This deliberately avoids `Windows.Media.Ocr` (Windows-only,
// and per experiments/ocr-primitive-proof finding #3 it drops/misreads a colon stopwatch,
// while a plain digit stream read byte-exact). This primitive is pure + dependency-free:
// it operates on a thresholded 0/1 bitmap (rows of '0'/'1' strings). Decoding a captured
// PNG to that bitmap (grayscale + threshold + locate the counter band) is a thin adapter,
// left to the capture side; here we prove the read is 100% deterministic.
//
// A digit glyph is 3 wide x 5 tall; digits are separated by a 1-column '0' gap, so a
// d-digit counter renders to width 4d-1.

// Fixed 3x5 glyphs for 0-9. Any pairwise-distinct set works (we own render + read); a
// load-time check below fails closed if two ever collide.
export const GLYPHS = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

export const GLYPH_W = 3;
export const GLYPH_H = 5;
const GAP = 1;

// Fail closed at load if any two glyphs are identical (would make a read ambiguous).
(function assertDistinctGlyphs() {
  const seen = new Map();
  for (const [ch, g] of Object.entries(GLYPHS)) {
    if (g.length !== GLYPH_H || g.some((r) => r.length !== GLYPH_W || /[^01]/.test(r))) {
      throw new Error(`known-digit-reader: glyph '${ch}' is not a ${GLYPH_W}x${GLYPH_H} 0/1 matrix`);
    }
    const key = g.join('|');
    if (seen.has(key)) throw new Error(`known-digit-reader: glyphs '${seen.get(key)}' and '${ch}' collide`);
    seen.set(key, ch);
  }
})();

/**
 * Render a non-negative integer to a { width, height, rows } bitmap of plain digits.
 * @param {number} n non-negative integer
 * @param {number} [minDigits=0] zero-pad to at least this many digits
 */
export function renderCounter(n, minDigits = 0) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`renderCounter: n must be a non-negative integer, got ${n}`);
  const s = String(n).padStart(minDigits, '0');
  const rows = Array.from({ length: GLYPH_H }, () => '');
  for (let i = 0; i < s.length; i++) {
    const g = GLYPHS[s[i]];
    for (let r = 0; r < GLYPH_H; r++) {
      rows[r] += (i > 0 ? '0'.repeat(GAP) : '') + g[r];
    }
  }
  return { width: rows[0]?.length ?? 0, height: GLYPH_H, rows };
}

function matchCell(cell) {
  const key = cell.join('|');
  for (const [ch, g] of Object.entries(GLYPHS)) {
    if (g.join('|') === key) return ch;
  }
  return null;
}

/**
 * Read a { rows } bitmap back to the integer it encodes. Throws (never guesses) if a
 * cell matches no glyph or the geometry is wrong — determinism means a bad read FAILS.
 * @param {{rows: string[]}} bitmap
 */
export function readCounter(bitmap) {
  const rows = bitmap && bitmap.rows;
  if (!Array.isArray(rows) || rows.length !== GLYPH_H) {
    throw new Error(`readCounter: expected ${GLYPH_H} rows, got ${rows ? rows.length : 'none'}`);
  }
  const w = rows[0].length;
  if (rows.some((r) => r.length !== w)) throw new Error('readCounter: ragged bitmap rows');
  // width = d*GLYPH_W + (d-1)*GAP  ->  d = (w + GAP) / (GLYPH_W + GAP)
  const stride = GLYPH_W + GAP;
  if ((w + GAP) % stride !== 0) throw new Error(`readCounter: width ${w} is not a valid ${GLYPH_W}x${GLYPH_H}+gap digit strip`);
  const d = (w + GAP) / stride;
  let out = '';
  for (let i = 0; i < d; i++) {
    const start = i * stride;
    const cell = rows.map((r) => r.slice(start, start + GLYPH_W));
    const ch = matchCell(cell);
    if (ch === null) throw new Error(`readCounter: no glyph match at digit ${i} (cell ${cell.join('|')})`);
    out += ch;
  }
  return parseInt(out, 10);
}
