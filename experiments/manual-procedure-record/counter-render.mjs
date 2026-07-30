// counter-render.mjs — the VIEWER's monotonic-counter anchor for the manual-procedure record.
//
// Renders a monotonic session counter as PLAIN 3x5 digits — the EXACT glyphs known-digit-reader.mjs
// templates — so a captured frame's on-screen counter reads back byte-exact (a deterministic anchor, not
// fuzzy OCR; see experiments/ocr-primitive-proof #3). Two outputs:
//   - counterBitmap(n) : the abstract {rows} bitmap the reader consumes (layout-identical to the reader).
//   - counterSvg(n)    : crisp-pixel SVG for the viewer to display + the capture to read.
// Plus a tiny monotonic-counter STATE machine (value + caseId markers + emitted series) = the anchor +
// the cross-iteration pairing keys.
//
// SELF-CONTAINED (glyphs inlined) so it can be staged into media/ like viewerCursor.mjs and imported by
// media/viewer.js verbatim. verify-counter.mjs asserts these glyphs are IDENTICAL to the reader's (a drift
// guard), so the render side and the read side can never diverge.

// 3x5 glyphs — MUST equal known-digit-reader.mjs GLYPHS (verify-counter.mjs enforces byte-for-byte).
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
export const GAP = 1;

// --- monotonic-counter state machine (the deterministic session anchor + case markers) --------------
export function createCounter(startValue = 0) {
  return { value: startValue, caseId: null, series: [] };
}
/** Advance the counter one step and record {counter, caseId} for this frame. Returns the new value. */
export function tick(counter) {
  counter.value += 1;
  counter.series.push({ counter: counter.value, caseId: counter.caseId });
  return counter.value;
}
/** Mark a reviewer-case boundary (e.g. 'TC-03'); subsequent ticks carry this caseId. */
export function setCase(counter, caseId) {
  counter.caseId = caseId;
  return counter;
}
/** The emitted {counter, caseId} series — the correlation ground truth + the cross-iteration pairing keys. */
export function emitted(counter) {
  return counter.series.slice();
}

// --- render: abstract bitmap (reader-consumable) + crisp SVG (viewer-visible) ------------------------
/** {rows} bitmap of the value's plain digits — layout-identical to known-digit-reader.renderCounter. */
export function counterBitmap(value, minDigits = 0) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`counterBitmap: non-negative integer required, got ${value}`);
  const s = String(value).padStart(minDigits, '0');
  const rows = Array.from({ length: GLYPH_H }, () => '');
  for (let i = 0; i < s.length; i++) {
    const g = GLYPHS[s[i]];
    for (let r = 0; r < GLYPH_H; r++) rows[r] += (i > 0 ? '0'.repeat(GAP) : '') + g[r];
  }
  return { width: rows[0]?.length ?? 0, height: GLYPH_H, rows };
}

/**
 * Crisp-pixel SVG string of the counter for the viewer to display + the capture to read. Each glyph pixel
 * is a solid `cellPx` square; `shape-rendering="crispEdges"` keeps edges hard so the thresholded read is
 * deterministic. Plain, high-contrast, NON-bold digits (the byte-exact case from ocr-primitive-proof #3).
 */
export function counterSvg(value, opts = {}) {
  const { minDigits = 6, cellPx = 6, on = '#000000', off = '#ffffff', pad = 4 } = opts;
  const s = String(value).padStart(minDigits, '0');
  const cols = s.length * GLYPH_W + (s.length - 1) * GAP;
  const w = cols * cellPx + 2 * pad;
  const h = GLYPH_H * cellPx + 2 * pad;
  let rects = '';
  for (let i = 0; i < s.length; i++) {
    const g = GLYPHS[s[i]];
    const colBase = i * (GLYPH_W + GAP);
    for (let r = 0; r < GLYPH_H; r++) {
      for (let c = 0; c < GLYPH_W; c++) {
        if (g[r][c] === '1') {
          const x = pad + (colBase + c) * cellPx;
          const y = pad + r * cellPx;
          rects += `<rect x="${x}" y="${y}" width="${cellPx}" height="${cellPx}"/>`;
        }
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges"><rect width="${w}" height="${h}" fill="${off}"/><g fill="${on}">${rects}</g></svg>`;
}

/** Total lit pixels for a value at minDigits — used by the SVG structural self-test. */
export function litPixelCount(value, minDigits = 0) {
  const s = String(value).padStart(minDigits, '0');
  let n = 0;
  for (const ch of s) for (const row of GLYPHS[ch]) for (const c of row) if (c === '1') n += 1;
  return n;
}
