// labview-benchmark-actor -- deterministic >=12 FPS Linux /proc performance sampler (LBA-REQ-011, cross-platform).
//
// The concept is NOT Windows-only: this samples the SAME platform-neutral counter catalog keys on Linux from
// /proc + /sys, so a Linux actor produces the exact v2 sample shape a Windows actor does (counters:{key:val}).
// typeperf / Get-Counter are deterministic but floor at 1 Hz -- too coarse for the required 12 FPS. This uses
// a DRIFT-CORRECTED loop (each sample scheduled at epoch0 + n*frameInterval, not setTimeout(interval) which
// accumulates drift) at EXACTLY the 12 FPS frame interval (1000/12 = 83.333 ms), PHASE-LOCKED to the frame
// clock so each sample maps 1:1 to a 12 FPS long packet/frame, and records each sample's ACTUAL epochMs +
// phase error so the exact-12-FPS lock is MEASURED, not assumed. Dependency-free ESM (Node built-ins only).
// Rate counters (…/sec) are deltas over the measured interval; the first (priming) read seeds them.

import { readFileSync } from 'node:fs';

/** Read the cumulative raw counters once from /proc (+ /sys). */
export function readProcSnapshot(now = Date.now()) {
  const stat = readFileSync('/proc/stat', 'utf8');
  const meminfo = readFileSync('/proc/meminfo', 'utf8');
  const diskstats = readFileSync('/proc/diskstats', 'utf8');
  const netdev = readFileSync('/proc/net/dev', 'utf8');
  const loadavg = readFileSync('/proc/loadavg', 'utf8');

  // /proc/stat: aggregate cpu jiffies (user nice system idle iowait irq softirq steal), ctxt, procs_running.
  const cpuLine = stat.split('\n').find((l) => l.startsWith('cpu ')) || 'cpu 0 0 0 0 0 0 0 0';
  const j = cpuLine.trim().split(/\s+/).slice(1).map(Number);
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = j;
  const cpuTotal = user + nice + system + idle + iowait + irq + softirq + steal;
  const cpuBusy = cpuTotal - idle - iowait;
  const ctxt = Number((stat.match(/^ctxt (\d+)/m) || [])[1] || 0);
  const procsRunning = Number((stat.match(/^procs_running (\d+)/m) || [])[1] || 0);

  // /proc/meminfo (kB).
  const mem = (k) => Number((meminfo.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')) || [])[1] || 0);
  const memTotalKb = mem('MemTotal');
  const memAvailKb = mem('MemAvailable');
  const committedKb = mem('Committed_AS');

  // /proc/diskstats: aggregate real block devices (skip loop/ram/dm virtuals). Fields (1-based after major/minor/name):
  // 1=reads 3=sectors-read 5=writes 7=sectors-written. Sectors are 512 bytes.
  let diskReads = 0, diskSectorsRead = 0, diskWrites = 0, diskSectorsWritten = 0;
  for (const line of diskstats.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 10) continue;
    const name = p[2];
    if (/^(loop|ram|dm-|sr|fd)/.test(name)) continue;
    if (/\d$/.test(name) && /^(sd|vd|nvme|xvd|hd)/.test(name) && !/nvme\d+n\d+$/.test(name)) {
      // skip partitions (e.g. sda1) but keep whole disks (sda, nvme0n1); crude but avoids double counting
      if (!/^nvme/.test(name)) continue;
    }
    diskReads += Number(p[3]) || 0;
    diskSectorsRead += Number(p[5]) || 0;
    diskWrites += Number(p[7]) || 0;
    diskSectorsWritten += Number(p[9]) || 0;
  }

  // /proc/net/dev: aggregate rx/tx bytes across interfaces (skip lo). rx bytes = col 0 after iface, tx bytes = col 8.
  let rxBytes = 0, txBytes = 0;
  for (const line of netdev.split('\n')) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m) continue;
    if (m[1].trim() === 'lo') continue;
    const c = m[2].trim().split(/\s+/).map(Number);
    rxBytes += c[0] || 0;
    txBytes += c[8] || 0;
  }

  const loadAvg1 = Number(loadavg.trim().split(/\s+/)[0] || 0);

  return {
    epochMs: now,
    cum: { cpuTotal, cpuBusy, user: user + nice, system, idle: idle + iowait, ctxt, diskReads, diskSectorsRead, diskWrites, diskSectorsWritten, rxBytes, txBytes },
    gauge: { procsRunning, loadAvg1, memTotalKb, memAvailKb, committedKb }
  };
}

/** Turn two raw snapshots into a v2 counters{} sample (rates over the measured interval). */
export function sampleFromSnapshots(prev, cur) {
  const dtSec = (cur.epochMs - prev.epochMs) / 1000;
  const dTotal = cur.cum.cpuTotal - prev.cum.cpuTotal;
  const pct = (d) => (dTotal > 0 ? (d / dTotal) * 100 : null);
  const rate = (a, b) => (dtSec > 0 ? (cur.cum[a] - prev.cum[a]) * (b || 1) / dtSec : null);
  const g = cur.gauge;
  return {
    epochMs: cur.epochMs,
    counters: {
      // platform-neutral catalog keys (shared with the Windows sampler)
      cpuTotalPct: pct(cur.cum.cpuBusy - prev.cum.cpuBusy),
      cpuUserPct: pct(cur.cum.user - prev.cum.user),
      cpuPrivilegedPct: pct(cur.cum.system - prev.cum.system),
      contextSwitchesPerSec: rate('ctxt'),
      memAvailableMb: g.memAvailKb / 1024,
      memCommittedBytes: g.committedKb * 1024,
      memCommittedInUsePct: g.memTotalKb > 0 ? (1 - g.memAvailKb / g.memTotalKb) * 100 : null,
      diskReadsPerSec: rate('diskReads'),
      diskWritesPerSec: rate('diskWrites'),
      diskReadBytesPerSec: rate('diskSectorsRead', 512),
      diskWriteBytesPerSec: rate('diskSectorsWritten', 512),
      netBytesReceivedPerSec: rate('rxBytes'),
      netBytesSentPerSec: rate('txBytes'),
      // Linux-native keys (no exact Windows analogue)
      procsRunning: g.procsRunning,
      loadAvg1: g.loadAvg1
    }
  };
}

/** Sleep until a target epoch-ms instant (drift-corrected scheduling). */
function sleepUntil(targetMs) {
  return new Promise((resolve) => {
    const d = targetMs - Date.now();
    if (d <= 0) resolve();
    else setTimeout(resolve, d);
  });
}

/**
 * Capture a REAL series phase-locked to EXACTLY the 12 FPS frame clock -- one sample per 12 FPS long packet.
 * @param {object} [opts]
 * @param {number} [opts.frameRateHz=12] frames/sec; the sample cadence is EXACTLY 1000/frameRateHz ms.
 * @param {number} [opts.samples=150] number of emitted samples (one per frame).
 * @param {number} [opts.epochMsAtFrameZero] frame-clock origin to PHASE-LOCK to (default = capture start).
 * @returns {Promise<object>} a resource-correlated series (v2 counters shape), one sample per frame, with a
 *   measured effective-FPS + per-sample phase-error summary proving the exact-12-FPS lock.
 */
export async function captureFrameLockedSeries(opts = {}) {
  const frameRateHz = opts.frameRateHz ?? 12;
  if (!(Number.isFinite(frameRateHz) && frameRateHz > 0)) throw new Error('frameRateHz must be > 0.');
  const frameIntervalMs = 1000 / frameRateHz; // EXACTLY 12 FPS -> 83.3333.. ms (matches the 12 FPS long packets)
  const samples = opts.samples ?? 150;
  const epoch0 = Number.isFinite(opts.epochMsAtFrameZero) ? opts.epochMsAtFrameZero : Date.now();
  const out = [];
  const phaseErrors = [];
  let prev = readProcSnapshot(Date.now());
  for (let n = 1; n <= samples; n += 1) {
    const idealMs = epoch0 + n * frameIntervalMs; // frame n boundary
    await sleepUntil(idealMs);
    const at = Date.now();
    const cur = readProcSnapshot(at);
    phaseErrors.push(Math.abs(at - idealMs)); // distance from the exact frame boundary
    out.push({ ...sampleFromSnapshots(prev, cur), frameIndex: n });
    prev = cur;
  }
  const dts = out.slice(1).map((s, i) => s.epochMs - out[i].epochMs).sort((a, b) => a - b);
  const medianCadenceMs = dts.length ? dts[Math.floor(dts.length / 2)] : null;
  const durationSec = (out[out.length - 1].epochMs - epoch0) / 1000;
  const effectiveFps = out.length / durationSec;
  const pe = [...phaseErrors].sort((a, b) => a - b);
  return {
    schema: 'labview-benchmark-actor/resource-correlated-launch@2',
    plane: 'LINUX',
    source: '/proc + /sys (drift-corrected, frame-locked loop)',
    frameRateHz,
    frameIntervalMs,
    epochMsAtFrameZero: epoch0,
    sampleCount: out.length,
    measured: {
      medianCadenceMs,
      effectiveFps, // rounds to exactly frameRateHz when locked
      exactly12fps: Math.abs(effectiveFps - frameRateHz) < 0.05,
      medianPhaseErrorMs: pe.length ? pe[Math.floor(pe.length / 2)] : null,
      maxPhaseErrorMs: pe.length ? pe[pe.length - 1] : null
    },
    samples: out
  };
}

// CLI: node linuxProcSampler.mjs [samples] [frameRateHz] > capture.json
if (process.argv[1] && process.argv[1].endsWith('linuxProcSampler.mjs')) {
  const samples = Number(process.argv[2]) || 150;
  const frameRateHz = Number(process.argv[3]) || 12;
  captureFrameLockedSeries({ samples, frameRateHz }).then((series) => {
    process.stdout.write(JSON.stringify(series, null, 2) + '\n');
    const m = series.measured;
    process.stderr.write(`[sampler] ${series.sampleCount} samples @ ${series.frameIntervalMs.toFixed(3)} ms -> ${m.effectiveFps.toFixed(3)} FPS (exactly12fps=${m.exactly12fps}); median phase-error ${m.medianPhaseErrorMs} ms, max ${m.maxPhaseErrorMs} ms\n`);
  });
}
