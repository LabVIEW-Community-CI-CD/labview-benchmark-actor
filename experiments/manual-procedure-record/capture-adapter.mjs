// capture-adapter.mjs — the "thin adapter" the known-digit-reader header defers to the capture side:
// turn a CAPTURED PNG frame into the { counterBitmap, rgba, width, height, caseId, expectedCounter } frame
// that correlate-seal.mjs consumes. This is the last seam of the manual-procedure-record method — it lets
// the producer run on REAL golden-box screenshots (not just synthetic records).
//
//   decodePng(buf)                        -> { width, height, rgba }   (pure Node, node:zlib; lossless)
//   sampleCounterBitmap(rgba,w,h,region)  -> { rows }                  (viewer-counter band -> reader bitmap)
//   readCounterFromPng(png, region)       -> number                    (decode + sample + known-digit read)
//   frameFromCapture({...})               -> a correlate-seal frame
//   encodePng(rgba,w,h)                   -> Buffer                     (RGBA PNG; symmetric, for harnesses)
//
// Scope is deliberately the capture case: 8-bit truecolor RGB/RGBA, non-interlaced (what a screenshot tool
// emits). Anything else fails closed. PNG decode is LOSSLESS, so identical PNG bytes => identical RGBA =>
// identical dhash-64 (fingerprint.mjs) — the cross-plane determinism the record depends on.

import zlib from 'node:zlib';
import { GLYPH_W, GLYPH_H, readCounter } from './known-digit-reader.mjs';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode an 8-bit truecolor (RGB/RGBA), non-interlaced PNG to { width, height, rgba(Uint8Array RGBA) }. */
export function decodePng(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('decodePng: not a PNG (bad signature)');

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawIHDR = false;
  const idat = [];

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const data = buf.subarray(dataStart, dataStart + len);
    pos = dataStart + len + 4; // + 4-byte CRC (not verified; a screenshot tool's CRC is authoritative)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      sawIHDR = true;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!sawIHDR) throw new Error('decodePng: missing IHDR');
  if (bitDepth !== 8) throw new Error(`decodePng: only 8-bit depth supported (got ${bitDepth})`);
  if (colorType !== 2 && colorType !== 6) throw new Error(`decodePng: only truecolor RGB(2)/RGBA(6) supported (got ${colorType})`);
  if (interlace !== 0) throw new Error('decodePng: interlaced PNG not supported');

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw new Error('decodePng: truncated image data');

  // Reverse the per-scanline PNG filter (None/Sub/Up/Average/Paeth) into a contiguous recon buffer.
  const recon = Buffer.alloc(height * stride);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const inRow = y * (stride + 1) + 1;
    const outRow = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[inRow + x];
      const a = x >= bpp ? recon[outRow + x - bpp] : 0;
      const b = y > 0 ? recon[outRow - stride + x] : 0;
      const c = x >= bpp && y > 0 ? recon[outRow - stride + x - bpp] : 0;
      let val;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: val = rawByte + paeth(a, b, c); break;
        default: throw new Error(`decodePng: unknown filter ${filter} on row ${y}`);
      }
      recon[outRow + x] = val & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = y * stride + x * channels;
      const di = (y * width + x) * 4;
      rgba[di] = recon[si];
      rgba[di + 1] = recon[si + 1];
      rgba[di + 2] = recon[si + 2];
      rgba[di + 3] = channels === 4 ? recon[si + 3] : 255;
    }
  }
  return { width, height, rgba };
}

/**
 * Sample the on-screen viewer-counter band into the reader's { rows } bitmap. The overlay renders each glyph
 * pixel as a solid `cellPx` square (counter-render.counterSvg, crispEdges), so sampling each cell's CENTER is
 * exact. `region` = { x, y, cellPx, minDigits (digits rendered), threshold=128, gap=1 } — the geometry the
 * host used to place the overlay. A dark cell (luma < threshold) is a lit glyph pixel ('1').
 */
export function sampleCounterBitmap(rgba, width, height, region) {
  const { x, y, cellPx, threshold = 128, gap = 1 } = region;
  const digits = region.digits ?? region.minDigits;
  if (![x, y, cellPx].every((n) => Number.isInteger(n)) || cellPx < 1) {
    throw new Error('sampleCounterBitmap: region {x,y,cellPx} must be integers with cellPx>=1');
  }
  if (!Number.isInteger(digits) || digits < 1) throw new Error('sampleCounterBitmap: region.minDigits/digits required');

  const cols = digits * GLYPH_W + (digits - 1) * gap;
  const rows = [];
  for (let r = 0; r < GLYPH_H; r++) {
    let row = '';
    for (let c = 0; c < cols; c++) {
      const px = x + c * cellPx + (cellPx >> 1);
      const py = y + r * cellPx + (cellPx >> 1);
      if (px < 0 || py < 0 || px >= width || py >= height) throw new Error('sampleCounterBitmap: counter band out of bounds');
      const di = (py * width + px) * 4;
      const luma = (77 * rgba[di] + 150 * rgba[di + 1] + 29 * rgba[di + 2]) >> 8;
      row += luma < threshold ? '1' : '0';
    }
    rows.push(row);
  }
  return { rows };
}

/** Convenience: decode a captured PNG + read the counter in one call. */
export function readCounterFromPng(png, region) {
  const { width, height, rgba } = decodePng(png);
  return readCounter(sampleCounterBitmap(rgba, width, height, region));
}

/**
 * Turn one captured frame into a correlate-seal frame. `expectedCounter` is the viewer's EMITTED value for
 * this frame (the host logs media/viewer.js's `{ counter, caseId }` postMessage at capture time); the record
 * seals only if the counter READ from these pixels matches it.
 */
export function frameFromCapture({ png, caseId, expectedCounter, region, settled }) {
  if (!caseId) throw new Error('frameFromCapture: caseId required');
  if (!Number.isInteger(expectedCounter)) throw new Error('frameFromCapture: integer expectedCounter required');
  const { width, height, rgba } = decodePng(png);
  const counterBitmap = sampleCounterBitmap(rgba, width, height, region);
  const frame = { counterBitmap, rgba, width, height, caseId, expectedCounter };
  if (settled === true) frame.settled = true;
  return frame;
}

// --- symmetric RGBA PNG encoder (for harnesses / synthesizing captures; NOT on the record path) ----------
function crc32(buf) {
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode an RGBA Uint8Array to an 8-bit RGBA (filter None) PNG Buffer. Round-trips with decodePng. */
export function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colorType RGBA
  const stride = width * 4;
  const rawrows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rawrows[y * (stride + 1)] = 0; // filter: None
    for (let x = 0; x < stride; x++) rawrows[y * (stride + 1) + 1 + x] = rgba[y * stride + x];
  }
  const idat = zlib.deflateSync(Buffer.from(rawrows));
  return Buffer.concat([PNG_SIG, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
