// correlate-seal.mjs — the LINUX producer of `manual-procedure-record-v1`.
//
// Ties the two primitives together into a sealed record:
//   - known-digit-reader.readCounter  -> the deterministic counter read (correlate/anchor side)
//   - fingerprint.dhash64FromRgba     -> the per-frame perceptual fingerprint (visual-delta side)
// For each captured frame it reads the on-screen counter, computes the shared dhash-64 fingerprint,
// and a SHA-256 integrity hash of the raw pixels. It CORRELATES the read counters against the viewer's
// emitted (expected) series; only if every frame matches (mismatches === 0) does it SEAL — discarding
// the raw pixels and emitting the record (anchor + per-frame {counter, caseId, fingerprint, integrityHash}
// + seal). A non-correlating session throws and is NOT sealed (determinism: a record you can't verify is
// not a record). WIN's frame-diff.mjs consumes the sealed records this produces.
//
// A "captured frame" is:
//   { counterBitmap: { rows: string[] },  // thresholded viewer-counter region -> known-digit reader
//     rgba: Uint8Array|number[], width, height,  // full frame pixels -> fingerprint + integrity hash
//     caseId: string, expectedCounter: number, settled?: boolean }

import { createHash } from 'node:crypto';
import { readCounter } from './known-digit-reader.mjs';
import { dhash64FromRgba, FINGERPRINT_ALGO, FINGERPRINT_SPEC_VERSION } from './fingerprint.mjs';

const MAX_SAMPLES = 64; // bound the correlation-proof samples kept in the sealed record

function sha256Bytes(bytesLike) {
  const buf = bytesLike instanceof Uint8Array ? Buffer.from(bytesLike) : Buffer.from(Uint8Array.from(bytesLike));
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Correlate a captured session's counters and, iff every frame matches, seal it into a
 * manual-procedure-record-v1. Throws (never seals) on the first unreadable or non-matching counter.
 * @param {{iteration:string, sessionId:string, procedure:{id:string,cases:string[]}, frames:Array, sealedAt?:string}} session
 * @returns {object} a manual-procedure-record-v1
 */
export function correlateAndSeal(session) {
  if (!session || !Array.isArray(session.frames) || session.frames.length === 0) {
    throw new Error('correlate-seal: session.frames must be a non-empty array');
  }
  for (const key of ['iteration', 'sessionId', 'procedure']) {
    if (!session[key]) throw new Error(`correlate-seal: session.${key} is required`);
  }

  const outFrames = [];
  const samples = [];
  let mismatches = 0;

  session.frames.forEach((f, i) => {
    if (!f.caseId) throw new Error(`correlate-seal: frame ${i} has no caseId`);
    if (!Number.isInteger(f.expectedCounter)) throw new Error(`correlate-seal: frame ${i} has no integer expectedCounter`);
    const read = readCounter(f.counterBitmap); // deterministic; throws on an unreadable glyph
    if (read !== f.expectedCounter) mismatches += 1;
    if (samples.length < MAX_SAMPLES) samples.push({ frameIndex: i, expected: f.expectedCounter, read });

    const frameOut = {
      index: i,
      counter: read,
      caseId: f.caseId,
      perceptualFingerprint: dhash64FromRgba(f.rgba, f.width, f.height),
      integrityHash: sha256Bytes(f.rgba),
    };
    if (f.settled === true) frameOut.settled = true;
    outFrames.push(frameOut);
  });

  // Determinism: seal ONLY a session whose on-screen counter correlated to the emitted series.
  if (mismatches !== 0) {
    throw new Error(`correlate-seal: ${mismatches} counter mismatch(es) — NOT sealed (determinism requires mismatches===0)`);
  }

  const counters = outFrames.map((f) => f.counter);
  const recordHash = createHash('sha256');
  for (const fr of outFrames) recordHash.update(`${fr.index}|${fr.counter}|${fr.perceptualFingerprint}|${fr.integrityHash}\n`);

  return {
    schema: 'labview-benchmark-actor/manual-procedure-record-v1',
    iteration: session.iteration,
    sessionId: session.sessionId,
    sealedAt: session.sealedAt ?? new Date().toISOString(),
    procedure: session.procedure,
    fingerprintAlgo: FINGERPRINT_ALGO,
    fingerprintSpecVersion: FINGERPRINT_SPEC_VERSION,
    anchor: {
      source: 'viewer-monotonic-counter',
      counterStart: counters[0],
      counterEnd: counters[counters.length - 1],
      correlation: { readMethod: 'known-digit-template', matched: true, mismatches: 0, samples },
    },
    frames: outFrames, // raw pixels intentionally absent — only fingerprint + integrity hash remain
    seal: { rawDiscarded: true, frameCount: outFrames.length, recordHash: recordHash.digest('hex') },
  };
}
