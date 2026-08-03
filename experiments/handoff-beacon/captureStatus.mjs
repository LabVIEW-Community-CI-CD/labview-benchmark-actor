// captureStatus.mjs -- the Handoff Beacon capture-status payload (LBA-REQ-055, ADR-0035).
//
// A capture-status@1 beacon is the machine-readable lifecycle of a LabVIEW-launch capture that the AGENT polls
// (host-side, via the reviewer VM) so a human-in-the-loop step -- "run a VI, then Stop the capture" -- becomes a
// signal the agent can await + act on, instead of guessing or re-asking. The extension writes it at capture
// START (state:'capturing') and STOP (state:'stopped' with the rich payload, or 'failed' on assembly error).
//
// PURE + deterministic (Node built-ins only) so it is unit-testable + gated, and stageable into the extension's
// media/ dir. The rich stop payload lets the agent JUMP straight to the evidence (the peak-write frame) rather
// than scrubbing: wroteToDisk (thresholded), the peak write MB/s + the frame index where it peaked, and a
// per-physical-disk write/read peak breakdown.

export const CAPTURE_STATUS_SCHEMA = 'labview-benchmark-actor/capture-status@1';
export const CAPTURE_STATES = Object.freeze(['capturing', 'stopped', 'failed']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round3 = (v) => Math.round(v * 1000) / 1000;

/** Start beacon: written when a capture begins, so the agent knows one is in flight. */
export function buildCapturingStatus(opts = {}) {
  return {
    schema: CAPTURE_STATUS_SCHEMA,
    state: 'capturing',
    runDir: opts.runDir != null ? String(opts.runDir) : null,
    startedAt: opts.startedAt != null ? String(opts.startedAt) : null,
  };
}

/** Failure beacon: written when the capture stopped but assembly failed (so the agent never waits forever). */
export function buildFailedStatus(opts = {}) {
  return {
    schema: CAPTURE_STATUS_SCHEMA,
    state: 'failed',
    runDir: opts.runDir != null ? String(opts.runDir) : null,
    startedAt: opts.startedAt != null ? String(opts.startedAt) : null,
    stoppedAt: opts.stoppedAt != null ? String(opts.stoppedAt) : null,
    error: String(opts.error != null ? opts.error : 'unknown'),
  };
}

/**
 * Stop beacon: the rich, machine-readable result of a completed capture.
 * @param {object} record an assembled launch-capture@1 record (frames[] with tMs + index, startMs, diskNames).
 * @param {Array<{ms:number, disks?:Array<{name:string,writeMBs?:number,readMBs?:number}>}>} resourceSamples raw samples.
 * @param {object} [opts] { runDir, startedAt, stoppedAt, writeThresholdMBs=1, writeMinSamples=3 }.
 * @returns {object} capture-status@1 (state:'stopped') with wroteToDisk + peak + perDisk.
 */
export function buildCaptureStatus(record, resourceSamples, opts = {}) {
  const rec = record && typeof record === 'object' ? record : {};
  const frames = Array.isArray(rec.frames) ? rec.frames : [];
  const samples = Array.isArray(resourceSamples) ? resourceSamples : [];
  const writeThresholdMBs = num(opts.writeThresholdMBs) != null ? opts.writeThresholdMBs : 1;
  const writeMinSamples = Number.isInteger(opts.writeMinSamples) ? opts.writeMinSamples : 3;
  const startMs = num(rec.startMs) != null ? rec.startMs : (frames[0] && num(frames[0].ms) != null ? frames[0].ms : 0);

  const perDiskMap = new Map(); // name -> { peakWriteMBs, peakReadMBs }
  let peakWriteMBs = 0;
  let peakWriteDisk = null;
  let peakWriteMs = null;
  let writeSamples = 0;

  for (const s of samples) {
    if (!s || !Array.isArray(s.disks)) continue;
    let sampleMaxWrite = 0;
    for (const d of s.disks) {
      if (!d || d.name == null) continue;
      const name = String(d.name);
      const w = num(d.writeMBs) != null ? d.writeMBs : 0;
      const r = num(d.readMBs) != null ? d.readMBs : 0;
      const cur = perDiskMap.get(name) || { peakWriteMBs: 0, peakReadMBs: 0 };
      if (w > cur.peakWriteMBs) cur.peakWriteMBs = w;
      if (r > cur.peakReadMBs) cur.peakReadMBs = r;
      perDiskMap.set(name, cur);
      if (w > sampleMaxWrite) sampleMaxWrite = w;
      if (w > peakWriteMBs) { peakWriteMBs = w; peakWriteDisk = name; peakWriteMs = num(s.ms); }
    }
    if (sampleMaxWrite > writeThresholdMBs) writeSamples += 1;
  }

  // Map the peak-write sample time to the nearest captured frame (so the agent can jump straight there).
  let peakFrameIndex = null;
  if (peakWriteMs != null && frames.length) {
    const peakRel = peakWriteMs - startMs;
    let best = null;
    let bestD = Infinity;
    for (const f of frames) {
      const d = Math.abs((num(f.tMs) != null ? f.tMs : 0) - peakRel);
      if (d < bestD) { bestD = d; best = num(f.index) != null ? f.index : 0; }
    }
    peakFrameIndex = best;
  }

  const perDisk = [...perDiskMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, v]) => ({ name, peakWriteMBs: round3(v.peakWriteMBs), peakReadMBs: round3(v.peakReadMBs) }));

  return {
    schema: CAPTURE_STATUS_SCHEMA,
    state: 'stopped',
    runDir: opts.runDir != null ? String(opts.runDir) : null,
    startedAt: opts.startedAt != null ? String(opts.startedAt) : null,
    stoppedAt: opts.stoppedAt != null ? String(opts.stoppedAt) : null,
    frameCount: num(rec.frameCount) != null ? rec.frameCount : frames.length,
    durationMs: num(rec.durationMs) != null ? rec.durationMs : 0,
    samples: samples.length,
    wroteToDisk: writeSamples >= writeMinSamples,
    writeSamples,
    peak: { writeMBs: round3(peakWriteMBs), frameIndex: peakFrameIndex, disk: peakWriteDisk },
    perDisk,
    diskNames: Array.isArray(rec.diskNames) ? rec.diskNames.slice() : perDisk.map((d) => d.name),
    captureJsonReady: true,
  };
}

/** Fail-closed shape check for a beacon before a consumer trusts it. */
export function validateCaptureStatus(status) {
  const errors = [];
  const s = status && typeof status === 'object' ? status : {};
  if (s.schema !== CAPTURE_STATUS_SCHEMA) errors.push(`schema must be ${CAPTURE_STATUS_SCHEMA}`);
  if (!CAPTURE_STATES.includes(s.state)) errors.push(`state must be one of ${CAPTURE_STATES.join('|')}`);
  if (s.state === 'stopped') {
    if (typeof s.wroteToDisk !== 'boolean') errors.push('stopped beacon needs a boolean wroteToDisk');
    if (!s.peak || typeof s.peak !== 'object') errors.push('stopped beacon needs a peak object');
    if (!Array.isArray(s.perDisk)) errors.push('stopped beacon needs a perDisk array');
  }
  if (s.state === 'failed' && typeof s.error !== 'string') errors.push('failed beacon needs an error string');
  return { ok: errors.length === 0, errors };
}
