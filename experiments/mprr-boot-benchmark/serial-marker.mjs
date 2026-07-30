// serial-marker.mjs — the shared LBABENCH serial-marker CONTRACT + parser (the live frame-pin channel).
//
// The guest emits ONE line per milestone to /dev/ttyS0 (only when the recorder has attached a serial sink,
// so it is a no-op off-bench):
//
//     LBABENCH <caseId> mono=<seconds.fraction>
//
//   e.g.  LBABENCH LBABUS-BUILT mono=21.234567
//
// <caseId> is a boot milestone; mono= is the guest's /proc/uptime (CLOCK_MONOTONIC since boot, seconds) at
// emit. The recorder tails the host serial file, and for each parsed line pins the milestone to the frame
// closest in HOST time. The mono= value is NOT the authoritative timing (journald short-monotonic is) — it is
// the CROSS-CHECK (skewMs) that catches a misaligned pin. Emitting + parsing share this one format so the
// LINUX and WIN planes stay wire-compatible.

export const MARKER_PREFIX = 'LBABENCH';
export const MILESTONES = ['BOOT-START', 'LBABUS-BUILD-START', 'LBABUS-BUILT', 'MESH-OK'];

const LINE_RE = /(?:^|\s)LBABENCH\s+([A-Z][A-Z0-9-]*)\s+mono=(\d+(?:\.\d+)?)(?:\s|$)/;

/** Format a marker line (the exact wire shape the guest emit helper writes). monoSeconds = /proc/uptime. */
export function formatSerialMarker(caseId, monoSeconds) {
  if (!caseId || !/^[A-Z][A-Z0-9-]*$/.test(caseId)) throw new Error(`formatSerialMarker: bad caseId '${caseId}'`);
  if (!Number.isFinite(monoSeconds) || monoSeconds < 0) throw new Error('formatSerialMarker: monoSeconds must be >= 0');
  return `${MARKER_PREFIX} ${caseId} mono=${monoSeconds.toFixed(6)}`;
}

/** Parse one line -> { caseId, serialMonotonicMs } or null if it is not an LBABENCH marker. */
export function parseSerialMarkerLine(line) {
  if (typeof line !== 'string') return null;
  const m = line.match(LINE_RE);
  if (!m) return null;
  return { caseId: m[1], serialMonotonicMs: Math.round(Number.parseFloat(m[2]) * 1000) };
}

/**
 * Parse a whole serial log; returns the FIRST marker seen per caseId (a milestone fires once), in file order.
 * @param {string} text serial-file contents
 * @returns {Array<{caseId:string, serialMonotonicMs:number}>}
 */
export function parseSerialLog(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const marker = parseSerialMarkerLine(line);
    if (marker && !seen.has(marker.caseId)) {
      seen.add(marker.caseId);
      out.push(marker);
    }
  }
  return out;
}
