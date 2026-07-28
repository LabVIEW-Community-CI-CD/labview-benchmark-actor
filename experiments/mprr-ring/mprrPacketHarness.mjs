#!/usr/bin/env node
// mprr PACKET-HARNESS rate profiles, absorbed dependency-free (mprr packet-harness MPRR-REQ-115-119). The mprr
// harness drives the zero-copy ring under named rate profiles to prove the ring holds its invariants under
// different load shapes. This module generates DETERMINISTIC short-packet streams per profile and runs each
// through the absorbed ring (ingestShortPackets), so the ring/block/boundary/admission behavior is exercised
// across the spec's scenarios -- not just the single steady fixture. Deterministic: a profile + params always
// yields the same stream, so the harness result is comparable cross-plane.

import { ingestShortPackets, DEFAULT_BLOCK_DURATION_TICKS, TICKS_PER_MS } from './mprrRing.mjs';

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

export const MPRR_HARNESS_SCHEMA = 'labview-benchmark-actor/mprr-packet-harness@v1';
// The mprr packet-harness rate profiles (MPRR-REQ-115-119).
export const RATE_PROFILES = ['steady', 'burst', 'jittered', 'boundary-crossing', 'reclaim-pressure'];

/**
 * Generate a DETERMINISTIC short-packet stream `[{ timingTicks64, bytes }]` for a named rate profile.
 * `opts`: { count, frameIntervalTicks, baseBytes, blockDurationTicks }. All arithmetic is integer + seeded by
 * the packet index, so no randomness -- identical inputs yield an identical stream on any plane.
 */
export function generateProfile(name, opts = {}) {
  assert(RATE_PROFILES.includes(name), `unknown rate profile '${name}' (expected ${RATE_PROFILES.join('|')})`);
  const count = opts.count ?? 24;
  const interval = opts.frameIntervalTicks ?? 833_333; // ~12 fps default (mprr governed capture cadence)
  const baseBytes = opts.baseBytes ?? 120;
  const blockDurationTicks = Number(opts.blockDurationTicks ?? DEFAULT_BLOCK_DURATION_TICKS);
  const packets = [];
  let t = 0;
  for (let i = 0; i < count; i += 1) {
    let dt = interval;
    let bytes = baseBytes;
    switch (name) {
      case 'steady':
        break;
      case 'burst':
        // Every 6th frame is a tight, larger burst (short interval + 3x payload).
        if (i % 6 === 0 && i > 0) {
          dt = Math.max(1, Math.floor(interval / 4));
          bytes = baseBytes * 3;
        }
        break;
      case 'jittered':
        // Deterministic +/- jitter about the mean interval (index-seeded, always > 0).
        dt = interval + (((i * 97) % 1000) - 500) * 100;
        break;
      case 'boundary-crossing':
        // Space packets at 2/3 of a block so they straddle block boundaries irregularly (exercises the
        // current + reserved-next pinning on a crossing, MPRR-REQ-107).
        dt = Math.max(1, Math.floor((blockDurationTicks * 2) / 3));
        break;
      case 'reclaim-pressure':
        // Heavy per-frame payload to stress the rolling-3-block admission budget.
        bytes = baseBytes * 10;
        break;
      default:
        throw new Error(`unhandled profile ${name}`);
    }
    assert(dt > 0, `profile ${name} produced a non-positive interval`);
    packets.push({ timingTicks64: t, bytes });
    t += dt;
  }
  return packets;
}

/**
 * Run a profile through the absorbed ring and return a harness result: the generated stream's ingest summary
 * (blocks, boundary-variation, admission, authoritative) plus the profile identity. `capacityBytes` bounds the
 * ring so reclaim-pressure can be shown to fail admission on a small ring.
 */
export function runProfile(name, opts = {}) {
  const blockDurationTicks = opts.blockDurationTicks ?? DEFAULT_BLOCK_DURATION_TICKS;
  const packets = generateProfile(name, { ...opts, blockDurationTicks });
  const ingest = ingestShortPackets(packets, {
    blockDurationTicks,
    capacityBytes: opts.capacityBytes ?? 58_000,
  });
  return {
    schema: MPRR_HARNESS_SCHEMA,
    profile: name,
    packetCount: packets.length,
    totalBytes: ingest.totalBytes,
    blockCount: ingest.blockCount,
    worstBoundaryVariationPct: ingest.worstBoundaryVariationPct,
    admission: ingest.admission,
    authoritative: ingest.authoritative,
  };
}

export { TICKS_PER_MS };
