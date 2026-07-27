/**
 * LBA dashboard next-horizon (Discussion #2365, task lba-dashboard):
 * maps an mprr "successor-shadow-dashboard-synchronized-review-state-v1" state
 * object into the BenchmarkFrameScrubberModel consumed by
 * buildBenchmarkFrameScrubberHtml. This is the vi-history-suite-side binding:
 * it turns the mprr surface's emitted points[] + packet-derived-images into the
 * upper-benchmark / lower-frame scrubber model, deriving each point's benchmark
 * instant (centiseconds, relative to the earliest frame-start) from
 * benchmarkPacketTimestamp and its metric from metrics[graphMetricField].
 *
 * The image resolver is injectable so tests can substitute deterministic bytes
 * and production can read the real packet-derived PNG as a data: URI.
 */

import { readFileSync } from 'node:fs';

/** Reads a PNG file as a `data:image/png;base64,...` URI. */
export function pngFileToDataUri(pngPath) {
  const bytes = readFileSync(pngPath);
  return 'data:image/png;base64,' + bytes.toString('base64');
}

/** Formats an ISO instant as `hh:mm:ss.cc` (UTC, centisecond precision). */
export function formatBenchmarkLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return String(iso);
  }
  const pad = (n, w) => String(n).padStart(w, '0');
  return (
    pad(d.getUTCHours(), 2) +
    ':' +
    pad(d.getUTCMinutes(), 2) +
    ':' +
    pad(d.getUTCSeconds(), 2) +
    '.' +
    pad(Math.floor(d.getUTCMilliseconds() / 10), 2)
  );
}

/**
 * Builds a BenchmarkFrameScrubberModel from an mprr synchronized-review state.
 *
 * @param {object} state parsed successor-shadow-dashboard-synchronized-review-state-v1
 * @param {object} [options]
 * @param {(point:object)=>string} [options.imageResolver] point -> image data URI (default reads packetDerivedImagePath)
 * @returns {object} BenchmarkFrameScrubberModel
 */
export function buildScrubberModelFromSynchronizedReviewState(state, options = {}) {
  if (!state || !Array.isArray(state.points) || state.points.length === 0) {
    throw new Error('synchronized-review state has no points[]');
  }
  const graphMetricField = state.graphMetricField || 'metric';
  const imageResolver =
    options.imageResolver || ((p) => pngFileToDataUri(p.packetDerivedImagePath));

  const baseMs = Math.min(
    ...state.points.map((p) => Date.parse(p.benchmarkPacketTimestamp))
  );

  const points = state.points.map((p) => {
    const ms = Date.parse(p.benchmarkPacketTimestamp);
    const centiseconds = Number.isNaN(ms) ? 0 : Math.round((ms - baseMs) / 10);
    const metricValue =
      p.metrics && typeof p.metrics[graphMetricField] === 'number'
        ? p.metrics[graphMetricField]
        : typeof p.metricValue === 'number'
          ? p.metricValue
          : 0;
    return {
      pointId: p.pointId,
      label: formatBenchmarkLabel(p.benchmarkPacketTimestamp),
      centiseconds,
      metricValue,
      image: imageResolver(p),
      // Each synchronized point carries a benchmarkPacketTimestamp that IS its
      // frame-start, so every point is a nearest-preceding snap target.
      isFrameStart: true
    };
  });

  const selectedIndex = Math.max(
    0,
    state.points.findIndex((p) => p.pointId === state.selectedPointId)
  );

  return {
    title: state.shellTitle || 'Benchmark Frame Scrubber',
    metricLabel: graphMetricField,
    selectedIndex,
    points
  };
}
