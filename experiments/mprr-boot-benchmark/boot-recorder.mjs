// boot-recorder.mjs — the shared LIVE driver that ties a capture backend + serial pin channel + journald
// authoritative timing to the pure seal core (seal-boot-benchmark.mjs). This is the orchestration that turns
// a real booting VM into a sealed boot-benchmark-v1.
//
// SEAM CONFIRMATION (answer to WIN's ask): the driver is uniformly ASYNC and does `await backend.capture(path)`,
// so ONE driver fits BOTH backends — VBox's SYNC capture() (`await <non-promise>` is a no-op) and VMware's
// ASYNC VNC capture() (a Promise). No sync facade needed.
//
// Every environment-specific dependency is INJECTED so the orchestration is unit-testable with fakes (no VM):
//   backend        : { backend, transport, probe, capture(path)->{ok}|Promise, start? }  (the capture seam)
//   readFrame      : (path) => {rgba,width,height} | Promise                              (decode a captured PNG)
//   serialSource   : { poll() => [{caseId,serialMonotonicMs}] | Promise }                 (new serial pins since last poll)
//   journalReader  : () => { <caseId>: guestMonotonicMs } | Promise                       (one post-MESH-OK journald read)
//   clock          : () => number  host CLOCK_MONOTONIC ms   (default node perf_hooks)
//   sleep          : (ms) => Promise                          (default setTimeout)
//
// The loop: record hostT0 (pre-boot) -> [optionally start the VM] -> at ~cadence: await capture -> decode ->
// push frame {hostMonotonicMs}; drain new serial markers (tag host arrival); stop at MESH-OK or maxDuration ->
// one journald read for the authoritative guest ms -> sealBootBenchmark(). The seal enforces determinism
// (all milestones pinned + skew ok), so a boot that didn't reach MESH-OK simply fails to seal.

import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { sealBootBenchmark } from './seal-boot-benchmark.mjs';
import { parseSerialLog } from './serial-marker.mjs';
import { decodePng } from '../manual-procedure-record/capture-adapter.mjs';

const DEFAULT_CADENCE_HZ = 2;
const DEFAULT_MAX_DURATION_MS = 180_000; // 3 min: a from-source first boot (build ~8s + mesh) fits easily

/** Default frame decode: read the PNG the backend wrote + losslessly decode via the shared capture-adapter. */
export function defaultReadFrame(path) {
  return decodePng(readFileSync(path));
}

/**
 * A file-tailing serial source: the guest's serial output is sinked to a HOST file (VBox `--uartmode1 file`
 * / VMware `serial0.fileName`); poll() returns the NEW LBABENCH markers appended since the last poll.
 * @param {string} path host serial-sink file
 */
export function fileSerialSource(path) {
  let offset = 0;
  const seen = new Set();
  return {
    poll() {
      let buf;
      try { buf = readFileSync(path); } catch { return []; }
      if (buf.length <= offset) return [];
      const chunk = buf.subarray(offset).toString('utf8');
      offset = buf.length;
      const out = [];
      for (const m of parseSerialLog(chunk)) {
        if (!seen.has(m.caseId)) { seen.add(m.caseId); out.push(m); }
      }
      return out;
    },
  };
}

/**
 * Record a mesh-actor boot into a sealed boot-benchmark-v1. Returns the sealed record (throws if the boot
 * did not deterministically correlate — a boot you can't seal is not a record).
 * @param {object} opts see module header
 * @returns {Promise<object>} boot-benchmark-v1
 */
export async function recordBoot(opts) {
  const {
    iteration, sessionId, vm, hypervisor, plane,
    backend, readFrame = defaultReadFrame, serialSource, journalReader,
    milestones = ['BOOT-START', 'LBABUS-BUILD-START', 'LBABUS-BUILT', 'MESH-OK'],
    cadenceHz = DEFAULT_CADENCE_HZ,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
    clock = () => performance.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    tmpPathFor = (i) => `/tmp/lba-boot-${sessionId}-${String(i).padStart(5, '0')}.png`,
    startVm = false,
    skewToleranceMs, visual, sealedAt,
  } = opts;

  if (!backend || typeof backend.capture !== 'function') throw new Error('recordBoot: backend with capture() required');
  if (!serialSource || typeof serialSource.poll !== 'function') throw new Error('recordBoot: serialSource.poll() required');
  if (typeof journalReader !== 'function') throw new Error('recordBoot: journalReader() required');

  const hostT0MonotonicMs = clock(); // t0 = BEFORE the actor boots
  if (startVm && typeof backend.start === 'function') backend.start();

  const intervalMs = Math.max(1, Math.round(1000 / cadenceHz));
  const deadline = hostT0MonotonicMs + maxDurationMs;
  const frames = [];
  const serialMarkers = [];
  const seen = new Set();

  for (let i = 0; clock() < deadline; i += 1) {
    const path = tmpPathFor(i);
    const cap = await backend.capture(path); // UNIFORM AWAIT: sync (VBox) or Promise (VMware VNC) both fit
    const hostMonotonicMs = clock();
    if (cap && cap.ok) {
      const img = await readFrame(path);
      frames.push({ hostMonotonicMs, rgba: img.rgba, width: img.width, height: img.height });
    }
    for (const mk of await serialSource.poll()) {
      if (!seen.has(mk.caseId)) {
        seen.add(mk.caseId);
        serialMarkers.push({ caseId: mk.caseId, serialMonotonicMs: mk.serialMonotonicMs, hostArrivalMonotonicMs: clock() });
      }
    }
    if (seen.has('MESH-OK')) break; // the boot benchmark ends when the mesh forms
    await sleep(intervalMs);
  }

  const guestTiming = await journalReader(); // authoritative guest CLOCK_MONOTONIC (one journald read)

  return sealBootBenchmark({
    iteration, sessionId, vm, hypervisor, plane,
    capture: { backend: backend.backend, transport: backend.transport, cadenceHz, ...(vm ? { vm } : {}) },
    procedure: { id: 'mesh-actor-boot', milestones },
    hostT0MonotonicMs,
    frames,
    serialMarkers,
    guestTiming,
    ...(skewToleranceMs != null ? { skewToleranceMs } : {}),
    ...(visual ? { visual } : {}),
    ...(sealedAt ? { sealedAt } : {}),
  });
}
