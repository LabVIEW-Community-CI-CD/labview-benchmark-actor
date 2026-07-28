#!/usr/bin/env node
// Project an mprr short-ring ingest result (ingestShortPackets) into the exact [{ t, v }] series the shipped
// benchmark viewer renders (media/viewer.js reads a `[{ t, v }]` block), plus a stable content hash. This is
// the SINGLE projection used by the viewer driver, the deterministic screenshot harness, AND the benchmark
// store driver, so all three agree byte-for-byte -- which is what makes the cross-plane comparison meaningful.
//
// Dependency-free (node:crypto is a Node builtin). The projection is a pure function of the ingest result, so
// identical packets -> identical series -> identical seriesHash on BOTH planes (the deterministic anchor the
// cross-plane screenshot comparison rests on, since cross-OS pixel-identity is not guaranteed).

import { createHash } from 'node:crypto';

const METRICS = {
  // Ring-buffer data volume over time (the "ring buffer data" the operator wants compared cross-plane).
  cumulativeBytes: (s) => s.cumulativeBytes,
  // Per-frame short-packet size.
  bytes: (s) => s.bytes,
  // Inter-arrival cadence (ms) -- surfaces timing jitter.
  intervalMs: (s) => s.intervalMs,
};

/**
 * Project ingest.series -> [{ t, v }] for the viewer. t = tMs (ms since run start), v = the chosen metric
 * (default cumulativeBytes). Deterministic and dependency-free.
 */
export function projectViewerSeries(ingest, opts = {}) {
  if (!ingest || !Array.isArray(ingest.series) || ingest.series.length === 0) {
    throw new Error('projectViewerSeries: ingest.series required (run ingestShortPackets first)');
  }
  const metric = opts.metric || 'cumulativeBytes';
  const pick = METRICS[metric];
  if (!pick) {
    throw new Error(`projectViewerSeries: unknown metric '${metric}' (expected ${Object.keys(METRICS).join('|')})`);
  }
  return ingest.series.map((s) => ({ t: s.tMs, v: pick(s) }));
}

/** Stable SHA-256 (hex) of a [{ t, v }] series -- the deterministic cross-plane anchor. */
export function seriesHash(series) {
  if (!Array.isArray(series)) {
    throw new Error('seriesHash: series must be an array');
  }
  return createHash('sha256').update(JSON.stringify(series)).digest('hex');
}

export const VIEWER_SERIES_METRICS = Object.keys(METRICS);
