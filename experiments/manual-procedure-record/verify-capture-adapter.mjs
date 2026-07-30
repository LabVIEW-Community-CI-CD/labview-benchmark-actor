// verify-capture-adapter.mjs — proves the capture->record seam on REAL PNG bytes (the last gap before an
// end-to-end golden-box record). Synthesizes captures the way media/viewer.js + counter-render render the
// on-screen counter (solid cellPx cells), encodes them to actual PNG, then runs them back through:
//   decode -> sample counter band -> known-digit read -> correlate+seal (producer) -> frame-diff (consumer).
// No external deps, no browser: pure Node PNG codec + the shipped primitives.

import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { counterBitmap as renderCounterBitmap } from './counter-render.mjs';
import { decodePng, encodePng, readCounterFromPng, frameFromCapture } from './capture-adapter.mjs';
import { correlateAndSeal } from './correlate-seal.mjs';
import { frameDiff } from './frame-diff.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`PASS  ${msg}`); }
  else { fail += 1; console.log(`FAIL  ${msg}`); }
};

// Synthesize a capture: the counter band at (pad,pad) + a content area below it (the "reviewed" surface we
// can visually mutate WITHOUT touching the counter). Mirrors counter-render.counterSvg's solid cellPx cells.
function synthCapture(value, { cellPx = 6, pad = 4, minDigits = 6, mark = false, contentH = 120 } = {}) {
  const bmp = renderCounterBitmap(value, minDigits);
  const cols = bmp.width;
  const counterH = bmp.height * cellPx + 2 * pad;
  const width = Math.max(cols * cellPx + 2 * pad, 96);
  const height = counterH + contentH;
  const rgba = new Uint8Array(width * height * 4).fill(255); // white, opaque
  // Optional visual delta in the CONTENT area (below the counter band): vertical STRIPES whose many edges
  // create the horizontal gradient dhash-64 encodes (a uniform fill would be invisible to a gradient hash) —
  // a stark stand-in for a meaningful golden-box visual change, clearing the default Hamming threshold.
  if (mark) {
    const stripeW = Math.max(2, Math.round(width / 9)); // ~1 stripe per dhash sample column -> max gradient flips
    for (let y = counterH + 4; y < height - 4; y++) {
      for (let x = 0; x < width; x++) {
        if (Math.floor(x / stripeW) % 2 === 0) {
          const di = (y * width + x) * 4;
          rgba[di] = 0; rgba[di + 1] = 0; rgba[di + 2] = 0; rgba[di + 3] = 255;
        }
      }
    }
  }
  for (let r = 0; r < bmp.height; r++) {
    for (let c = 0; c < cols; c++) {
      if (bmp.rows[r][c] !== '1') continue;
      for (let dy = 0; dy < cellPx; dy++) {
        for (let dx = 0; dx < cellPx; dx++) {
          const di = ((pad + r * cellPx + dy) * width + (pad + c * cellPx + dx)) * 4;
          rgba[di] = 0; rgba[di + 1] = 0; rgba[di + 2] = 0; rgba[di + 3] = 255;
        }
      }
    }
  }
  return { rgba, width, height, png: encodePng(rgba, width, height), region: { x: pad, y: pad, cellPx, minDigits } };
}

// --- test-only PNG encoder that applies ALL FIVE row filters (exercises decodePng's unfilter paths) -------
function paethF(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a; if (pb <= pc) return b; return c;
}
function crc32(buf) {
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePngRotatingFilters(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = width * 4; const bpp = 4;
  const out = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const ft = y % 5; // rotate None/Sub/Up/Average/Paeth so decode reverses every filter
    out[y * (stride + 1)] = ft;
    for (let x = 0; x < stride; x++) {
      const raw = rgba[y * stride + x];
      const a = x >= bpp ? rgba[y * stride + x - bpp] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? rgba[(y - 1) * stride + x - bpp] : 0;
      let f;
      switch (ft) {
        case 1: f = raw - a; break;
        case 2: f = raw - b; break;
        case 3: f = raw - ((a + b) >> 1); break;
        case 4: f = raw - paethF(a, b, c); break;
        default: f = raw;
      }
      out[y * (stride + 1) + 1 + x] = f & 0xff;
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out)), chunk('IEND', Buffer.alloc(0))]);
}

// T1: capture PNG -> decode -> sample -> known-digit read is byte-exact across a wide value range.
let allRead = true;
let firstBad = null;
const values = new Set([0, 1, 7, 10, 42, 99, 100, 4095, 65535, 123456, 999999]);
for (let v = 0; v <= 512; v++) values.add(v);
for (const v of values) {
  const cap = synthCapture(v);
  const read = readCounterFromPng(cap.png, cap.region);
  if (read !== v) { allRead = false; firstBad = `${read} != ${v}`; break; }
}
ok(allRead, `capture PNG -> decode -> counter read byte-exact (0..512 + big values)${firstBad ? ' got ' + firstBad : ''}`);

// T2: decodePng is lossless (encode -> decode identity).
{
  const cap = synthCapture(314159);
  const d = decodePng(cap.png);
  let same = d.width === cap.width && d.height === cap.height && d.rgba.length === cap.rgba.length;
  for (let i = 0; same && i < d.rgba.length; i++) if (d.rgba[i] !== cap.rgba[i]) same = false;
  ok(same, 'decodePng is lossless (encode -> decode identity rgba)');
}

// T2b: decodePng reverses ALL FIVE PNG row filters (not just filter-None from our own encoder).
{
  const cap = synthCapture(80231);
  const png = encodePngRotatingFilters(cap.rgba, cap.width, cap.height);
  const d = decodePng(png);
  let same = d.rgba.length === cap.rgba.length;
  for (let i = 0; same && i < d.rgba.length; i++) if (d.rgba[i] !== cap.rgba[i]) same = false;
  const read = readCounterFromPng(png, cap.region);
  ok(same && read === 80231, 'decodePng reverses all 5 filters (None/Sub/Up/Average/Paeth) + reads counter');
}

// Build a sealed record from captures via the producer.
function sessionFromCaptures(iteration, cases) {
  const frames = cases.map(({ caseId, counter, mark }) => {
    const cap = synthCapture(counter, mark ? { mark: true } : {});
    return frameFromCapture({ png: cap.png, caseId, expectedCounter: counter, region: cap.region, settled: true });
  });
  return { iteration, sessionId: `sess-${iteration}`, procedure: { id: 'REV-1', cases: cases.map((c) => c.caseId) }, frames, sealedAt: '2026-07-30T00:00:00Z' };
}

const casesV1 = [
  { caseId: 'TC-00', counter: 1001 },
  { caseId: 'TC-01', counter: 1042 },
  { caseId: 'TC-02', counter: 1099 },
];

// T3: the producer seals a capture-adapter-built session (counters read from PNGs correlate to expected).
let recV1;
try {
  recV1 = correlateAndSeal(sessionFromCaptures('rev-v1', casesV1));
  ok(recV1.seal.rawDiscarded === true && recV1.frames.length === 3 && recV1.anchor.correlation.mismatches === 0,
    'correlateAndSeal seals a capture-adapter session (raw discarded, correlation mismatches=0)');
} catch (e) {
  ok(false, `correlateAndSeal on captures threw: ${e.message}`);
}

// T4: correlation FAILS CLOSED when the on-screen counter does not match the emitted expected value.
{
  const cap = synthCapture(5);
  const bad = frameFromCapture({ png: cap.png, caseId: 'TC-00', expectedCounter: 6, region: cap.region, settled: true });
  let threw = false;
  try { correlateAndSeal({ iteration: 'bad', sessionId: 's', procedure: { id: 'P', cases: ['TC-00'] }, frames: [bad] }); }
  catch { threw = true; }
  ok(threw, 'correlateAndSeal fails closed when read counter != expected (no false seal)');
}

// T5: cross-iteration frame-diff — self-diff IDENTICAL; a content delta on TC-01 only (counter unchanged) -> VISUAL_DELTA.
if (recV1) {
  const casesV2 = [
    { caseId: 'TC-00', counter: 1001 },
    { caseId: 'TC-01', counter: 1042, mark: true }, // same counter, added content box -> visual delta only here
    { caseId: 'TC-02', counter: 1099 },
  ];
  const recV2 = correlateAndSeal(sessionFromCaptures('rev-v2', casesV2));
  const self = frameDiff(recV1, recV1);
  const cross = frameDiff(recV1, recV2);
  ok(self.verdict === 'IDENTICAL_WITHIN_THRESHOLD', 'frame-diff self-diff of a capture record = IDENTICAL');
  ok(cross.verdict === 'VISUAL_DELTA' && cross.changedCases.length === 1 && cross.changedCases[0] === 'TC-01',
    `frame-diff flags exactly the mutated case TC-01 (maxHamming ${cross.maxHamming})`);

  const here = dirname(fileURLToPath(import.meta.url));
  const receipt = {
    tool: 'verify-capture-adapter',
    at: new Date().toISOString(),
    pass, fail: fail, // filled below
    roundTripValues: '0..512 + {big}',
    e2e: {
      sealedFromRealPng: true,
      selfVerdict: self.verdict,
      crossVerdict: cross.verdict,
      changedCases: cross.changedCases,
      maxHamming: cross.maxHamming,
      recordHashV1: recV1.seal.recordHash,
      recordHashV2: recV2.seal.recordHash,
    },
  };
  receipt.pass = pass; receipt.fail = fail;
  writeFileSync(join(here, 'capture-adapter-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}

console.log(`\ncapture-adapter: ${pass}/${pass + fail}; verdict=${fail === 0 ? 'PASS' : 'FAIL'}`);
process.exit(fail === 0 ? 0 : 1);
