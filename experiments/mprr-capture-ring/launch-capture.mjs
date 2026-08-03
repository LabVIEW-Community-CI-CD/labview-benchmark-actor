// launch-capture.mjs — assemble a VM-local LabVIEW-launch capture into the mprr DUAL-PACKET model.
//
// The capture command (in the extension host, inside the VM) records the screen at 12 fps (ffmpeg gdigrab ->
// PNG frames on VM-local disk = the LONG-packet payloads) while sampling CPU/RAM/disk. This PURE assembler
// turns those raw frames + resource samples into a launch-capture@1 record:
//   - a per-frame SHORT packet: timing (100 ns timingTicks64 @ 12 fps) + the CPU/RAM/disk metrics (always present),
//   - a per-frame LONG packet: the screenshot (the mprr long-packet payload, stored VM-local as a file),
// correlated by frameIndex through correlateDualStream (short continuity protected before long completeness).
// LBA-REQ-003/005/009/011: the actor VM captures its own benchmark, stores it VM-local in the mprr ring, and
// the frame correlator reads it. Deterministic + dependency-free: same inputs -> same record.
//
// correlateDualStream is INLINED here (not imported) so this module is self-contained and stageable into the
// extension's media/ dir; verify-launch-capture.mjs drift-guards it against the canonical mprrDualPacket.mjs.

export const LAUNCH_CAPTURE_SCHEMA = 'labview-benchmark-actor/launch-capture@1';

const MPRR_DUAL_PACKET_SCHEMA = 'labview-benchmark-actor/mprr-dual-packet@v1';

/** Inlined twin of mprr-ring/mprrDualPacket.mjs correlateDualStream (drift-guarded). Short continuity is
 *  protected before long-packet completeness; fails closed if the shorts alone exceed capacity. */
function correlateDualStream(frames, opts = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('frames required (non-empty)');
  }
  const capacityBytes = opts.capacityBytes ?? Infinity;
  let shortTotal = 0;
  for (let i = 0; i < frames.length; i += 1) {
    const sb = Number(frames[i].shortBytes) | 0;
    if (!(sb > 0)) throw new Error(`frame[${i}].shortBytes must be > 0`);
    if (frames[i].frameIndex === undefined) throw new Error(`frame[${i}] needs a frameIndex`);
    shortTotal += sb;
  }
  if (shortTotal > capacityBytes) {
    return { schema: MPRR_DUAL_PACKET_SCHEMA, authoritative: false, outcome: 'short-protection-blocked', shortTotal, admittedLong: 0, capacityBytes, frameCount: frames.length, authoritativeFrames: 0, frames: [] };
  }
  let admittedLong = 0;
  const correlations = frames.map((f) => {
    const shortBytes = Number(f.shortBytes) | 0;
    const longBytes = Number(f.longBytes) | 0;
    let outcome;
    let driftClass;
    if (longBytes <= 0) { outcome = 'failed'; driftClass = 'missing-long-payload'; }
    else if (shortTotal + admittedLong + longBytes <= capacityBytes) { admittedLong += longBytes; outcome = 'authoritative'; driftClass = 'none'; }
    else { outcome = 'failed'; driftClass = 'missing-long-payload'; }
    return { frameIndex: f.frameIndex, shortBytes, longBytes, outcome, driftClass };
  });
  const authoritativeFrames = correlations.filter((c) => c.outcome === 'authoritative').length;
  const authoritative = authoritativeFrames === correlations.length;
  return { schema: MPRR_DUAL_PACKET_SCHEMA, authoritative, outcome: authoritative ? 'authoritative' : 'degraded-long-deferred', shortTotal, admittedLong, capacityBytes, frameCount: frames.length, authoritativeFrames, frames: correlations };
}

// mprr short packet = the fixed 24-byte timing/metric slot (matches capture-ring.mjs PACKET_BYTES).
const SHORT_PACKET_BYTES = 24;
// 100 ns tick authority (mprr timingTicks64): 1 ms = 10000 ticks.
const TICKS_PER_MS = 10000n;

function nearestSampleFactory(samples) {
  const sorted = samples
    .filter((s) => s && Number.isFinite(s.ms))
    .sort((a, b) => a.ms - b.ms);
  return (ms) => {
    if (sorted.length === 0) return {};
    let best = sorted[0];
    let bestD = Math.abs(sorted[0].ms - ms);
    for (let i = 1; i < sorted.length; i += 1) {
      const d = Math.abs(sorted[i].ms - ms);
      if (d < bestD) {
        bestD = d;
        best = sorted[i];
      }
    }
    return best;
  };
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Assemble a launch-capture@1 record.
 *
 * @param {object} input
 * @param {Array<{index?:number, ms?:number, imageFile:string, imageBytes?:number, dhashHex?:string}>} input.frames
 *   the captured frames IN ORDER (imageFile = VM-local path/name of the PNG long-packet payload).
 * @param {Array<{ms:number, cpuPct?:number, ramMb?:number, diskPct?:number, disks?:Array<{name:string,writeMBs?:number,readMBs?:number}>, counters?:object}>} [input.resourceSamples]
 *   CPU/RAM/disk (and/or a v2 counters{} object, and/or per-physical-disk throughput) samples at any cadence; each frame takes its nearest-in-time sample.
 * @param {number} [input.startMs] epoch ms of frame 0 (defaults to frames[0].ms or 0).
 * @param {number} [input.fps=12] capture frame rate.
 * @param {number} [input.capacityBytes=Infinity] mprr ring capacity bound for the dual-packet policy.
 * @param {object} [input.meta] { workload, plane, source, screenW, screenH, ... }.
 * @returns {object} launch-capture@1 record.
 */
export function buildLaunchCapture(input) {
  const frames = Array.isArray(input && input.frames) ? input.frames : [];
  if (frames.length === 0) {
    throw new Error('buildLaunchCapture: non-empty frames[] required');
  }
  const fps = input.fps && input.fps > 0 ? input.fps : 12;
  const intervalMs = 1000 / fps;
  const t0 = Number.isFinite(input.startMs)
    ? input.startMs
    : Number.isFinite(frames[0].ms)
      ? frames[0].ms
      : 0;
  const nearest = nearestSampleFactory(Array.isArray(input.resourceSamples) ? input.resourceSamples : []);

  const outFrames = frames.map((f, i) => {
    const ms = Number.isFinite(f.ms) ? f.ms : t0 + i * intervalMs;
    const tMs = Math.round(ms - t0);
    const rs = nearest(ms);
    const frame = {
      index: i,
      tMs,
      timingTicks64: (BigInt(Math.max(0, tMs)) * TICKS_PER_MS).toString(),
      cpuPct: numOrNull(rs.cpuPct),
      ramMb: numOrNull(rs.ramMb),
      diskPct: numOrNull(rs.diskPct),
      image: f.imageFile,
      imageBytes: Number.isFinite(f.imageBytes) ? f.imageBytes | 0 : 0,
      dhashHex: typeof f.dhashHex === 'string' ? f.dhashHex : null,
    };
    // v2: carry the nearest sample's full performance-counter catalog when present (backward compatible).
    if (rs && rs.counters && typeof rs.counters === 'object') {
      frame.counters = rs.counters;
    }
    // per-physical-disk read/write throughput (MB/s), carried from the nearest sample (present only when the
    // sampler emits it). Each entry: { name, writeMBs, readMBs } -- the correlator plots a curve per disk/direction.
    if (rs && Array.isArray(rs.disks)) {
      frame.disks = rs.disks
        .filter((dk) => dk && dk.name != null)
        .map((dk) => ({ name: String(dk.name), writeMBs: numOrNull(dk.writeMBs), readMBs: numOrNull(dk.readMBs) }));
    }
    return frame;
  });

  // union of v2 counter keys across frames (present only when a sampler emitted counters{}).
  const counterKeys = [...new Set(outFrames.flatMap((f) => (f.counters ? Object.keys(f.counters) : [])))].sort();
  // union of physical-disk names across frames (present only when the sampler emitted per-disk throughput).
  const diskNames = [...new Set(outFrames.flatMap((f) => (Array.isArray(f.disks) ? f.disks.map((d) => d.name) : [])))].sort();

  // mprr dual-packet correlation: short (timing+metrics) always present; long (image) admitted while it fits.
  const dualFrames = outFrames.map((f) => ({
    frameIndex: f.index,
    shortBytes: SHORT_PACKET_BYTES,
    longBytes: f.imageBytes,
  }));
  const dualPacket = correlateDualStream(dualFrames, {
    capacityBytes: Number.isFinite(input.capacityBytes) ? input.capacityBytes : Infinity,
  });

  const meta = input.meta || {};
  const record = {
    schema: LAUNCH_CAPTURE_SCHEMA,
    workload: meta.workload || 'labview-launch',
    plane: meta.plane || null,
    source: meta.source || 'ffmpeg-gdigrab',
    fps,
    startMs: t0,
    frameCount: outFrames.length,
    durationMs: outFrames.length ? outFrames[outFrames.length - 1].tMs : 0,
    screen: meta.screenW && meta.screenH ? { width: meta.screenW, height: meta.screenH } : null,
    frames: outFrames,
    // per-metric arrays over the frame timeline (the correlator's three curves).
    resources: {
      cpu: outFrames.map((f) => f.cpuPct),
      ram: outFrames.map((f) => f.ramMb),
      disk: outFrames.map((f) => f.diskPct),
    },
    dualPacket, // mprr dual-packet receipt: authoritative when every frame's long payload was admitted.
    meta,
  };
  // v2: expose the captured performance-counter catalog when a sampler emitted counters{} (else omitted).
  if (counterKeys.length) { record.counterKeys = counterKeys; }
  // expose the physical-disk names when the sampler emitted per-disk read/write throughput (else omitted).
  if (diskNames.length) { record.diskNames = diskNames; }
  return record;
}
