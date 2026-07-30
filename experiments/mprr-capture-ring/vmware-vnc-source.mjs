// vmware-vnc-source.mjs — the WIN half of the capture-ring split (task mprr-capture-ring-backbone).
//
// A STREAMING VMware RemoteDisplay.vnc source: it runs the RFB handshake ONCE, then maintains the full
// framebuffer across INCREMENTAL FramebufferUpdate messages, and — at a governed cadence (~12fps) — samples
// the live framebuffer, fingerprints it (dhash-64), and emits the AGREED capture-ring frame descriptor
//   { timingTicks64: bigint, frameIndex: number, dhash64: string(16-hex), milestoneId: number, settled: 0|1 }
// to an injected sink `onFrame`. It is DECOUPLED from LINUX's ring adapter by that sink: wiring is simply
//   onFrame = (d) => ring.writeCaptureFrame(ring, { ...d, dhash64: dhashHexToBits(d.dhash64) })
// once experiments/mprr-capture-ring/capture-ring.mjs lands (dhashHexToBits = LINUX's fingerprint.mjs helper;
// this source keeps dhash64 as the 16-hex form so it has no dependency on that not-yet-landed helper).
//
// Extends the proven single-shot RFB client (capture-backend-vmware.mjs grabVncFramebuffer): same None-auth
// negotiation + forced 32bpp [R,G,B,pad] pixel format + Raw encoding, but a continuous incremental pump.
// All I/O deps are injected (connect, clock, scheduler) so the streaming + cadence are unit-testable with a
// scripted fake socket + a fake clock — no VM, no real VNC.

import { dhash64FromRgba } from '../manual-procedure-record/fingerprint.mjs';

const TICKS_PER_MS = 10_000; // 100ns ticks per millisecond (mprr timing unit)

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

/** RFB handshake (None auth, force 32bpp true-colour [R,G,B,pad], Raw encoding). Returns {width,height}. */
async function rfbHandshake(read, write) {
  // 1) ProtocolVersion.
  const pv = await read(12);
  const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(pv.toString('latin1'));
  if (!m) throw new Error(`RFB: bad ProtocolVersion ${JSON.stringify(pv.toString('latin1'))}`);
  const major = Number(m[1]);
  const minor = Math.min(Number(m[2]), 8);
  write(Buffer.from(`RFB ${String(major).padStart(3, '0')}.${String(minor).padStart(3, '0')}\n`, 'latin1'));

  // 2) Security — 3.7+: count + list, pick None(1); 3.3: server dictates one 4-byte type.
  if (minor >= 7) {
    const count = (await read(1))[0];
    if (count === 0) { const rlen = (await read(4)).readUInt32BE(0); throw new Error(`RFB: server refused: ${(await read(rlen)).toString('utf8')}`); }
    const types = await read(count);
    if (!types.includes(1)) throw new Error(`RFB: server requires auth (types ${[...types]}); use password-less VNC`);
    write(Buffer.from([1]));
    if (minor >= 8) { const result = (await read(4)).readUInt32BE(0); if (result !== 0) throw new Error('RFB: None SecurityResult failed'); }
  } else {
    const type = (await read(4)).readUInt32BE(0);
    if (type !== 1) throw new Error(`RFB: 3.3 server requires auth type ${type}; use password-less VNC`);
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
export function createStreamingFramebuffer({ host, port, connect, onUpdate } = {}) {
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
      ({ width, height } = await rfbHandshake(read, write));
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
 * Real-run defaults use setInterval + a monotonic clock; both are injectable for tests.
 */
export function createVmwareVncSource({
  host, port, connect, fps = 12, durationMs = 45000,
  clock = () => Number(process.hrtime.bigint() / 1_000_000n),
  setTimer = setInterval, clearTimer = clearInterval,
  milestoneOf = () => 0, onFrame,
} = {}) {
  const stream = createStreamingFramebuffer({ host, port, connect });
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
