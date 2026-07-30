// vnc-source.mjs — the SHARED, plane-neutral RFB/VNC streaming core of the capture-ring backbone
// (task mprr-capture-ring-backbone). Extracted from WIN's vmware-vnc-source.mjs (PR #180): every primitive
// here is generic RFB — nothing hypervisor-specific — so BOTH planes stream through the SAME implementation
// and therefore produce BYTE-IDENTICAL capture-ring descriptors cross-plane (the whole point of the shared
// ring). vmware-vnc-source.mjs (WIN, VMware RemoteDisplay.vnc) and vbox-vnc-source.mjs (LINUX, VirtualBox VNC)
// are thin plane-specific wrappers over createVncSource below; the only per-plane difference is how the
// hypervisor exposes the VNC TCP port (host-side 127.0.0.1:590x), which is just the injected `connect`.
//
// It runs the RFB handshake ONCE, then maintains the full framebuffer across INCREMENTAL FramebufferUpdate
// messages, and — at a governed cadence (~12fps) — samples the live framebuffer, fingerprints it (dhash-64),
// and emits the AGREED capture-ring frame descriptor
//   { timingTicks64: bigint, frameIndex: number, dhash64: string(16-hex), milestoneId: number, settled: 0|1 }
// to an injected sink `onFrame`. It is DECOUPLED from the ring adapter by that sink: wiring is simply
//   onFrame = (d) => writeCaptureFrame(ring, { ...d, dhashHex: d.dhash64 })   (capture-ring.mjs)
// This source keeps dhash64 as the 16-hex form; the adapter converts hex -> u64 via dhashHexToBits.
//
// None-auth negotiation + forced 32bpp [R,G,B,pad] pixel format + Raw encoding, a continuous incremental pump.
// All I/O deps are injected (connect, clock, scheduler) so the streaming + cadence are unit-testable with a
// scripted fake socket + a fake clock — no VM, no real VNC.

import { dhash64FromRgba } from '../manual-procedure-record/fingerprint.mjs';

const TICKS_PER_MS = 10_000; // 100ns ticks per millisecond (mprr timing unit)

// --- RFB VNC authentication (security type 2): a self-contained DES so the shared core needs NO OpenSSL legacy
//     provider (Node 22 / OpenSSL 3 moved des-ecb out of the default provider -> ERR_OSSL_EVP_UNSUPPORTED).
//     VirtualBox's VNC VRDE ALWAYS requires VNC auth; VMware None-auth never reaches this path. ---
const DES_IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7];
const DES_FP = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25];
const DES_E = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,16,17,18,19,20,21,20,21,22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1];
const DES_P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];
const DES_PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
const DES_PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
const DES_SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
const DES_S = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];

function desBytesToBits(buf, off) {
  const bits = new Uint8Array(64);
  for (let i = 0; i < 8; i += 1) for (let j = 0; j < 8; j += 1) bits[i * 8 + j] = (buf[off + i] >> (7 - j)) & 1;
  return bits;
}
function desBitsToBytes(bits) {
  const out = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) { let b = 0; for (let j = 0; j < 8; j += 1) b = (b << 1) | bits[i * 8 + j]; out[i] = b; }
  return out;
}
function desPermute(bits, table) {
  const out = new Uint8Array(table.length);
  for (let i = 0; i < table.length; i += 1) out[i] = bits[table[i] - 1];
  return out;
}
function desRotl(bits, n) {
  const out = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i += 1) out[i] = bits[(i + n) % bits.length];
  return out;
}
function desKeySchedule(keyBits) {
  const pc1 = desPermute(keyBits, DES_PC1); // 56 bits
  let c = pc1.slice(0, 28); let d = pc1.slice(28, 56);
  const subkeys = [];
  for (let r = 0; r < 16; r += 1) {
    c = desRotl(c, DES_SHIFTS[r]); d = desRotl(d, DES_SHIFTS[r]);
    const cd = new Uint8Array(56); cd.set(c, 0); cd.set(d, 28);
    subkeys.push(desPermute(cd, DES_PC2)); // 48 bits
  }
  return subkeys;
}
function desFeistel(r32, subkey48) {
  const exp = desPermute(r32, DES_E); // 48 bits
  const x = new Uint8Array(48);
  for (let i = 0; i < 48; i += 1) x[i] = exp[i] ^ subkey48[i];
  const sOut = new Uint8Array(32);
  for (let s = 0; s < 8; s += 1) {
    const o = s * 6;
    const row = (x[o] << 1) | x[o + 5];
    const col = (x[o + 1] << 3) | (x[o + 2] << 2) | (x[o + 3] << 1) | x[o + 4];
    const v = DES_S[s][row * 16 + col];
    for (let j = 0; j < 4; j += 1) sOut[s * 4 + j] = (v >> (3 - j)) & 1;
  }
  return desPermute(sOut, DES_P); // 32 bits
}
function desEncryptBlock(buf, off, subkeys) {
  const bits = desPermute(desBytesToBits(buf, off), DES_IP);
  let l = bits.slice(0, 32); let r = bits.slice(32, 64);
  for (let round = 0; round < 16; round += 1) {
    const f = desFeistel(r, subkeys[round]);
    const nr = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) nr[i] = l[i] ^ f[i];
    l = r; r = nr;
  }
  const rl = new Uint8Array(64); rl.set(r, 0); rl.set(l, 32); // pre-output = R16 L16
  return desBitsToBytes(desPermute(rl, DES_FP));
}

/** Reverse the 8 bits of a byte — the historical VNC-auth key quirk (RFB DES uses bit-reversed key bytes). */
function reverseBits(b) {
  let r = 0;
  for (let i = 0; i < 8; i += 1) r |= ((b >> i) & 1) << (7 - i);
  return r & 0xff;
}

/**
 * RFB VNC authentication (security type 2): DES-ECB encrypt the server's 16-byte challenge with the password
 * (latin1, truncated/zero-padded to 8 bytes, each byte BIT-REVERSED) as the key. Returns the 16-byte response.
 * Exported for a known-answer self-test.
 */
export function vncAuthResponse(challenge, password) {
  const key = Buffer.alloc(8, 0);
  const pw = Buffer.from(String(password), 'latin1');
  for (let i = 0; i < 8 && i < pw.length; i += 1) key[i] = reverseBits(pw[i]);
  const subkeys = desKeySchedule(desBytesToBits(key, 0));
  const out = Buffer.alloc(16);
  desEncryptBlock(challenge, 0, subkeys).copy(out, 0);
  desEncryptBlock(challenge, 8, subkeys).copy(out, 8);
  return out;
}

/** Buffered exact-length reader over a socket. read(n) resolves a Buffer of exactly n bytes (rejects on EOF). */
function makeReader(sock) {
  let buf = Buffer.alloc(0);
  let waiter = null;
  let error = null;
  let ended = false;
  const pump = () => {
    if (waiter && buf.length >= waiter.n) {
      const { n, resolve } = waiter; waiter = null;
      const out = buf.subarray(0, n); buf = buf.subarray(n);
      resolve(out); return;
    }
    if (waiter && (error || ended)) {
      const { reject } = waiter; waiter = null;
      reject(error ?? new Error('RFB: connection closed mid-stream'));
    }
  };
  sock.on('data', (d) => { buf = buf.length ? Buffer.concat([buf, d]) : d; pump(); });
  sock.on('error', (e) => { error = e; pump(); });
  sock.on('end', () => { ended = true; pump(); });
  sock.on('close', () => { ended = true; pump(); });
  return (n) => new Promise((resolve, reject) => {
    if (n === 0) return resolve(Buffer.alloc(0));
    waiter = { n, resolve, reject };
    pump();
  });
}

/** RFB handshake (None or VNC auth, force 32bpp true-colour [R,G,B,pad], Raw encoding). Returns {width,height}. */
async function rfbHandshake(read, write, password) {
  // 1) ProtocolVersion.
  const pv = await read(12);
  const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(pv.toString('latin1'));
  if (!m) throw new Error(`RFB: bad ProtocolVersion ${JSON.stringify(pv.toString('latin1'))}`);
  const major = Number(m[1]);
  const minor = Math.min(Number(m[2]), 8);
  write(Buffer.from(`RFB ${String(major).padStart(3, '0')}.${String(minor).padStart(3, '0')}\n`, 'latin1'));

  // 2) Security. Prefer None(1). If the server only offers VNC auth(2) — e.g. VirtualBox's VNC VRDE, which
  //    ALWAYS requires it — do the DES challenge-response with the provided password. 3.7+: count + list;
  //    3.3: the server dictates a single 4-byte type. VNC-auth always returns a SecurityResult; None returns
  //    one only on 3.8+.
  const doVncAuth = async () => {
    const challenge = await read(16);
    write(vncAuthResponse(challenge, password ?? ''));
    const result = (await read(4)).readUInt32BE(0);
    if (result !== 0) throw new Error('RFB: VNC authentication failed (check the VNC password)');
  };
  if (minor >= 7) {
    const count = (await read(1))[0];
    if (count === 0) { const rlen = (await read(4)).readUInt32BE(0); throw new Error(`RFB: server refused: ${(await read(rlen)).toString('utf8')}`); }
    const types = await read(count);
    if (types.includes(1)) {
      write(Buffer.from([1])); // None
      if (minor >= 8) { const result = (await read(4)).readUInt32BE(0); if (result !== 0) throw new Error('RFB: None SecurityResult failed'); }
    } else if (types.includes(2)) {
      write(Buffer.from([2])); // VNC authentication
      await doVncAuth();
    } else {
      throw new Error(`RFB: no supported security type (server offered ${[...types]}); need None(1) or VNC-auth(2)`);
    }
  } else {
    const type = (await read(4)).readUInt32BE(0);
    if (type === 1) {
      // None — RFB 3.3 sends no SecurityResult.
    } else if (type === 2) {
      await doVncAuth();
    } else {
      throw new Error(`RFB: unsupported 3.3 security type ${type}`);
    }
  }

  // 3) ClientInit(shared=1) -> ServerInit.
  write(Buffer.from([1]));
  const si = await read(24);
  const width = si.readUInt16BE(0);
  const height = si.readUInt16BE(2);
  const nameLen = si.readUInt32BE(20);
  if (nameLen) await read(nameLen);
  if (!width || !height) throw new Error(`RFB: degenerate framebuffer ${width}x${height}`);

  // 4) SetPixelFormat -> 32bpp true-colour, LE, bytes [R,G,B,pad].
  const spf = Buffer.alloc(20);
  spf[0] = 0; spf[4] = 32; spf[5] = 24; spf[6] = 0; spf[7] = 1;
  spf.writeUInt16BE(255, 8); spf.writeUInt16BE(255, 10); spf.writeUInt16BE(255, 12);
  spf[14] = 0; spf[15] = 8; spf[16] = 16;
  write(spf);

  // 5) SetEncodings -> Raw(0) only.
  const enc = Buffer.alloc(8);
  enc[0] = 2; enc.writeUInt16BE(1, 2); enc.writeUInt32BE(0, 4);
  write(enc);

  return { width, height };
}

/** Read ONE FramebufferUpdate (skipping Bell/ServerCutText/ColourMap) and apply its Raw rects to fb. */
async function readOneUpdate(read, fb, width) {
  for (;;) {
    const type = (await read(1))[0];
    if (type === 0) break;
    if (type === 2) continue; // Bell
    if (type === 3) { await read(3); const n = (await read(4)).readUInt32BE(0); if (n) await read(n); continue; } // ServerCutText
    if (type === 1) { await read(1); const n = (await read(4)).readUInt16BE(2); if (n) await read(n * 6); continue; } // SetColourMapEntries
    throw new Error(`RFB: unexpected server message type ${type}`);
  }
  await read(1); // padding
  const numRects = (await read(2)).readUInt16BE(0);
  for (let r = 0; r < numRects; r++) {
    const hdr = await read(12);
    const rx = hdr.readUInt16BE(0), ry = hdr.readUInt16BE(2), rw = hdr.readUInt16BE(4), rh = hdr.readUInt16BE(6);
    const encoding = hdr.readInt32BE(8);
    if (encoding !== 0) throw new Error(`RFB: unexpected encoding ${encoding} (requested Raw only)`);
    const px = await read(rw * rh * 4);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const s = (y * rw + x) * 4;
        const d = ((ry + y) * width + (rx + x)) * 4;
        fb[d] = px[s]; fb[d + 1] = px[s + 1]; fb[d + 2] = px[s + 2]; fb[d + 3] = 255;
      }
    }
  }
  return numRects;
}

/**
 * Connect + maintain a live framebuffer over incremental RFB updates. Returns immediately with a handle:
 *   ready: Promise<{width,height}> — resolves after the first (full) update lands
 *   current(): Uint8Array — the live RGBA framebuffer (mutated in place as updates apply)
 *   updateCount(): number — how many FramebufferUpdates have been applied
 *   close(): void — stop the pump + destroy the socket
 * onUpdate(fb, count) fires after each applied update (test/observability hook).
 */
export function createStreamingFramebuffer({ host, port, connect, onUpdate, password } = {}) {
  const sock = connect({ host, port });
  const read = makeReader(sock);
  const write = (b) => sock.write(b);
  let width = 0, height = 0, fb = null, closed = false, updates = 0;
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

  const requestUpdate = (incremental) => {
    const fur = Buffer.alloc(10);
    fur[0] = 3; fur[1] = incremental ? 1 : 0;
    fur.writeUInt16BE(0, 2); fur.writeUInt16BE(0, 4);
    fur.writeUInt16BE(width, 6); fur.writeUInt16BE(height, 8);
    write(fur);
  };

  (async () => {
    try {
      ({ width, height } = await rfbHandshake(read, write, password));
      fb = new Uint8Array(width * height * 4);
      requestUpdate(false); // full screen
      await readOneUpdate(read, fb, width);
      updates += 1;
      readyResolve({ width, height });
      onUpdate?.(fb, updates);
      while (!closed) {
        requestUpdate(true); // incremental
        await readOneUpdate(read, fb, width);
        updates += 1;
        onUpdate?.(fb, updates);
      }
    } catch (err) {
      if (!closed) readyReject(err);
    }
  })();

  return {
    ready,
    current: () => fb,
    dims: () => ({ width, height }),
    updateCount: () => updates,
    close: () => { closed = true; try { sock.destroy?.(); } catch { /* ignore */ } },
  };
}

/** Fingerprint the live framebuffer into the agreed capture-ring descriptor (dhash64 stays 16-hex here). */
export function sampleDescriptor(fb, width, height, { frameIndex, t0Ms, nowMs, milestoneId = 0, settled = 0 }) {
  return {
    timingTicks64: BigInt(Math.round((nowMs - t0Ms) * TICKS_PER_MS)),
    frameIndex,
    dhash64: dhash64FromRgba(fb, width, height),
    milestoneId,
    settled: settled ? 1 : 0,
  };
}

/**
 * A governed-cadence sampler over a live framebuffer. Each tick(nowMs) samples the framebuffer into a
 * descriptor and hands it to onFrame; the scheduler is injected (real run = setInterval), so the cadence is
 * fully unit-testable with a fake clock. Returns { tick, frameIndex }.
 */
export function makeSampler({ stream, milestoneOf = () => 0, onFrame }) {
  let frameIndex = 0;
  let t0Ms = null;
  return {
    tick(nowMs) {
      const fb = stream.current();
      if (!fb) return null; // not ready yet
      if (t0Ms === null) t0Ms = nowMs;
      const { width, height } = stream.dims();
      const desc = sampleDescriptor(fb, width, height, { frameIndex: frameIndex++, t0Ms, nowMs, milestoneId: milestoneOf(nowMs) });
      onFrame?.(desc);
      return desc;
    },
    get frameIndex() { return frameIndex; },
  };
}

/**
 * Full streaming source: connect + maintain the framebuffer + emit descriptors at ~fps until durationMs.
 * Real-run defaults use setInterval + a monotonic clock; both are injectable for tests. Plane-neutral — the
 * VMware/VBox wrappers just pre-fill host/port/connect defaults for their hypervisor's VNC exposure.
 */
export function createVncSource({
  host, port, connect, fps = 12, durationMs = 45000, password,
  clock = () => Number(process.hrtime.bigint() / 1_000_000n),
  setTimer = setInterval, clearTimer = clearInterval,
  milestoneOf = () => 0, onFrame,
} = {}) {
  const stream = createStreamingFramebuffer({ host, port, connect, password });
  const sampler = makeSampler({ stream, milestoneOf, onFrame });
  let timer = null;
  let startMs = null;
  const done = stream.ready.then(() => new Promise((resolve) => {
    startMs = clock();
    const periodMs = Math.max(1, Math.round(1000 / fps));
    timer = setTimer(() => {
      const nowMs = clock();
      sampler.tick(nowMs);
      if (nowMs - startMs >= durationMs) { stop(); resolve({ frames: sampler.frameIndex }); }
    }, periodMs);
    // NOTE: the cadence timer is intentionally NOT unref'd — it is the foreground driver of the capture and
    // must keep the event loop alive until durationMs; stop() clears it (and closes the socket) at the end.
  }));
  function stop() { if (timer) { clearTimer(timer); timer = null; } stream.close(); }
  return { ready: stream.ready, done, stop, dims: () => stream.dims(), updateCount: () => stream.updateCount() };
}
