#!/usr/bin/env node
// mprr DUAL-PACKET correlation + DEGRADATION model, absorbed dependency-free (mprr
// mprr-dual-packet-correlation-receipt-v1 + MPRR-REQ-094/110/111). Each capture frame has a SHORT packet (the
// timing slot, ALWAYS present) and an optional LONG packet (the payload), paired by frameIndex. The degradation
// POLICY preserves SHORT-packet continuity BEFORE long-packet completeness: every short is admitted
// (protected); a long is admitted only while it fits WITHOUT threatening pinned short bytes, else it is DEFERRED
// (incomplete / missing-long-payload) -- a long is never allowed to drop or overwrite a short. If the shorts
// alone exceed capacity the model FAILS CLOSED at the short-protection boundary (never silently overwrites a
// pinned short). Deterministic: identical frames -> identical correlation receipt on both planes.

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

export const MPRR_DUAL_PACKET_SCHEMA = 'labview-benchmark-actor/mprr-dual-packet@v1';

/**
 * Correlate a dual-stream capture under the degradation policy. `frames` is `[{ frameIndex, shortBytes,
 * longBytes }]` (longBytes 0/absent = no long payload produced for that frame). `opts.capacityBytes` bounds the
 * short + admitted-long budget (default Infinity = no pressure). Returns a correlation receipt: per-frame
 * outcome (`authoritative` when its long is present + admitted, else `failed`) + driftClass
 * (`none` | `missing-long-payload`), and `authoritative` overall iff EVERY frame is authoritative. When the
 * shorts alone exceed capacity it fails closed with `outcome: short-protection-blocked`.
 */
export function correlateDualStream(frames, opts = {}) {
  assert(Array.isArray(frames) && frames.length > 0, 'frames required (non-empty)');
  const capacityBytes = opts.capacityBytes ?? Infinity;

  // 1. SHORT continuity is protected: shorts are ALWAYS admitted. Shorts alone over capacity => fail closed.
  let shortTotal = 0;
  for (let i = 0; i < frames.length; i += 1) {
    const sb = Number(frames[i].shortBytes) | 0;
    assert(sb > 0, `frame[${i}].shortBytes must be > 0 (the short packet is always present)`);
    assert(frames[i].frameIndex !== undefined, `frame[${i}] needs a frameIndex`);
    shortTotal += sb;
  }
  if (shortTotal > capacityBytes) {
    return {
      schema: MPRR_DUAL_PACKET_SCHEMA,
      authoritative: false,
      outcome: 'short-protection-blocked',
      shortTotal,
      admittedLong: 0,
      capacityBytes,
      frameCount: frames.length,
      authoritativeFrames: 0,
      frames: [],
    };
  }

  // 2. LONGs are admitted greedily while (shortTotal + admittedLong + thisLong) <= capacity; else DEFERRED
  //    (incomplete) -- the long yields to the pinned shorts, never the other way around.
  let admittedLong = 0;
  const correlations = frames.map((f) => {
    const shortBytes = Number(f.shortBytes) | 0;
    const longBytes = Number(f.longBytes) | 0;
    let outcome;
    let driftClass;
    if (longBytes <= 0) {
      outcome = 'failed';
      driftClass = 'missing-long-payload';
    } else if (shortTotal + admittedLong + longBytes <= capacityBytes) {
      admittedLong += longBytes;
      outcome = 'authoritative';
      driftClass = 'none';
    } else {
      outcome = 'failed';
      driftClass = 'missing-long-payload';
    }
    return { frameIndex: f.frameIndex, shortBytes, longBytes, outcome, driftClass };
  });

  const authoritativeFrames = correlations.filter((c) => c.outcome === 'authoritative').length;
  const authoritative = authoritativeFrames === correlations.length;
  return {
    schema: MPRR_DUAL_PACKET_SCHEMA,
    authoritative,
    outcome: authoritative ? 'authoritative' : 'degraded-long-deferred',
    shortTotal,
    admittedLong,
    capacityBytes,
    frameCount: frames.length,
    authoritativeFrames,
    frames: correlations,
  };
}
