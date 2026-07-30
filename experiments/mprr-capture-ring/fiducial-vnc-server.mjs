// fiducial-vnc-server.mjs — a minimal RFB (VNC) SERVER that serves a HOST-CONTROLLED "stopwatch" fiducial: a
// small framebuffer whose pixel pattern encodes a monotonically advancing `tick`, so each tick has a DISTINCT
// dhash-64. It is the ground-truth peer for the capture ring (the mirror of the client in vnc-source.mjs): the
// host process advances the fiducial (like mprr's stopwatch/fiducial), the VNC streaming client records it over
// a REAL localhost socket, and a self-test asserts the captured dhash sequence + timing match the KNOWN fiducial
// timeline. This is the loopback "record a host-controlled surface via VNC" — a real server<->client round-trip
// (not a scripted fake), and the seed for correlating host<->guest timing visually.

import net from 'node:net';
import { dhash64FromRgba } from '../manual-procedure-record/fingerprint.mjs';
import { vncAuthResponse } from './vnc-source.mjs';

export const FIDUCIAL_W = 64;
export const FIDUCIAL_H = 64;
const BANDS = 8;

/**
 * Render the fiducial framebuffer for `tick` as RGBA [R,G,B,pad] (the pixel format the capture client forces).
 * A fixed lit CENTER band is always present (a reliable dark->lit->dark central edge), so NO frame is uniform
 * (dhash is never the all-zero "no-frame" sentinel — an edge-only anchor washes out of the 9-column dhash); the
 * remaining 7 bands encode the low 7 bits of tick as vertical BINARY BANDS, so every tick is visually distinct
 * => distinct dhash-64. Deterministic + pure.
 */
export function fiducialFrame(tick, w = FIDUCIAL_W, h = FIDUCIAL_H) {
  const rgba = new Uint8Array(w * h * 4);
  const bandW = Math.max(1, Math.floor(w / BANDS));
  const anchor = Math.floor(BANDS / 2); // fixed lit CENTER band (always on)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const b = Math.min(BANDS - 1, Math.floor(x / bandW));
      const bit = b < anchor ? b : b - 1; // the 7 non-anchor bands carry bits 0..6
      const on = b === anchor ? 1 : (tick >> bit) & 1;
      const v = on ? 230 : 20;
      const o = (y * w + x) * 4;
      rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/** dhash-64 (16-hex) of the fiducial for a tick — the ground-truth fingerprint a faithful capture must reproduce. */
export function fiducialDhash(tick, w = FIDUCIAL_W, h = FIDUCIAL_H) {
  return dhash64FromRgba(fiducialFrame(tick, w, h), w, h);
}

/** Encode a full-screen Raw FramebufferUpdate for the given RGBA framebuffer (mirror of the client's decoder). */
function encodeRawUpdate(rgba, w, h) {
  const head = Buffer.alloc(16);
  head[0] = 0; head[1] = 0; head.writeUInt16BE(1, 2);               // FramebufferUpdate, pad, numRects=1
  head.writeUInt16BE(0, 4); head.writeUInt16BE(0, 6); head.writeUInt16BE(w, 8); head.writeUInt16BE(h, 10);
  head.writeInt32BE(0, 12);                                          // encoding Raw
  return Buffer.concat([head, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)]);
}

/**
 * Start a fiducial RFB server. Resolves to { host, port, tick(), setTick(n), close() }. setTick(n) advances the
 * fiducial and, if the connected client has an outstanding FramebufferUpdateRequest, immediately pushes the new
 * frame — the standard RFB "answer a pending request when content changes" behaviour, driven by the host.
 */
export function createFiducialServer({ width = FIDUCIAL_W, height = FIDUCIAL_H, host = '127.0.0.1', port = 0, password } = {}) {
  let tick = 0;
  let pendingReq = false;
  let sentTick = -1;
  let sock = null;

  const flush = () => {
    if (sock && pendingReq && tick !== sentTick) {
      sock.write(encodeRawUpdate(fiducialFrame(tick, width, height), width, height));
      sentTick = tick; pendingReq = false;
    }
  };

  const server = net.createServer((s) => {
    sock = s;
    let buf = Buffer.alloc(0); let want = null;
    const pump = () => { if (want && buf.length >= want.n) { const { n, res } = want; want = null; const o = buf.subarray(0, n); buf = buf.subarray(n); res(o); } };
    const read = (n) => new Promise((res) => { want = { n, res }; pump(); });
    s.on('data', (d) => { buf = buf.length ? Buffer.concat([buf, d]) : d; pump(); });
    s.on('error', () => {}); s.on('close', () => { sock = null; sentTick = -1; pendingReq = false; });

    (async () => {
      s.write(Buffer.from('RFB 003.008\n', 'latin1'));
      await read(12);                       // client ProtocolVersion
      if (password) {
        s.write(Buffer.from([1, 2]));       // security: count=1, type VNC-auth(2) — mirrors VirtualBox's VNC VRDE
        await read(1);                      // client chooses VNC-auth
        const challenge = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]); // fixed test challenge
        s.write(challenge);
        const response = await read(16);
        if (!response.equals(vncAuthResponse(challenge, password))) { s.write(Buffer.from([0, 0, 0, 1])); s.destroy(); return; }
        s.write(Buffer.from([0, 0, 0, 0]));  // SecurityResult = OK
      } else {
        s.write(Buffer.from([1, 1]));       // security: count=1, type None(1)
        await read(1);                      // client chooses None
        s.write(Buffer.from([0, 0, 0, 0])); // SecurityResult = OK
      }
      await read(1);                        // ClientInit (shared)
      const si = Buffer.alloc(24);
      si.writeUInt16BE(width, 0); si.writeUInt16BE(height, 2);
      si[4] = 32; si[5] = 24; si[6] = 0; si[7] = 1;                          // 32bpp true-colour
      si.writeUInt16BE(255, 8); si.writeUInt16BE(255, 10); si.writeUInt16BE(255, 12);
      si[14] = 0; si[15] = 8; si[16] = 16;                                   // shifts -> [R,G,B,pad]
      si.writeUInt32BE(0, 20);                                               // nameLen = 0
      s.write(si);
      for (;;) {
        const type = (await read(1))[0];
        if (type === 0) { await read(19); continue; }                                    // SetPixelFormat
        if (type === 2) { const n = (await read(3)).readUInt16BE(1); await read(n * 4); continue; } // SetEncodings
        if (type === 3) { await read(9); pendingReq = true; flush(); continue; }         // FramebufferUpdateRequest
        if (type === 4) { await read(7); continue; }                                     // KeyEvent
        if (type === 5) { await read(5); continue; }                                     // PointerEvent
        if (type === 6) { const r = await read(7); await read(r.readUInt32BE(3)); continue; } // ClientCutText
        break;
      }
    })().catch(() => {});
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        host,
        port: server.address().port,
        tick: () => tick,
        setTick: (n) => { tick = n; flush(); },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
