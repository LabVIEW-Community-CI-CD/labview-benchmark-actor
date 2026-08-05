// win-vbox-sdk-labview-trend.mjs -- the WINDOWS-OS-plane LabVIEW launch-to-ready TREND runner via the VirtualBox
// SDK screenshot transport. Sibling of win-vbox-labview-trend.mjs (VBox VNC) and live-vbox-labview-trend.mjs
// (LINUX VBox VNC), but it delegates the CAPTURE to vbox-sdk-capture.py because VirtualBox's VRDE VNC server is
// blind to the Windows WDDM framebuffer (streams a near-black screen), so the RFB core cannot see a Windows
// LabVIEW launch. The python capturer grabs the REAL guest screen via IDisplay.takeScreenShotToArray, computes
// the PINNED dhash-64 (byte-identical to Node's dhash64FromRgba), and emits the SAME {ms,dhashHex} frame stream;
// THIS runner then applies the SAME gated settle-detect (buildWorkloadRecord) + trend (buildTrend) the other
// planes use, so the launchMs is produced by identical code on both planes -- only the capture transport differs
// (SDK screenshot vs RFB), an acknowledged cross-plane capture-path bias (launch durations are a reported witness,
// never hard-gated). Ungated live entry (needs the running Windows VM + vboxapi + activated LabVIEW).
//
//   Env: LBA_ITERATIONS(3) LBA_DURATION_MS(16000) LBA_FPS(12) LBA_TOL(2000) LBA_DRIFT(400)
//        LBA_TOL_HAMMING(3) LBA_WINDOW(8) LBA_VM(actor) LBA_SSH_KEY LBA_SSH_PORT(2200) LBA_SSH_USER(vagrant)
//        LBA_WIN_TASK(LBA-LaunchLabVIEW) LBA_WIN_LAUNCH_CMD LBA_WIN_KILL_CMD
//        LBA_SDK_CAPTURER(<this dir>/vbox-sdk-capture.py) LBA_FRAMES_OUT(<tmp>) LBA_OUT(<trend path>)
//   node experiments/mprr-capture-ring/win-vbox-sdk-labview-trend.mjs

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkloadRecord } from './workload-benchmark.mjs';
import { buildTrend } from './trend.mjs';

const capturer = process.env.LBA_SDK_CAPTURER ?? fileURLToPath(new URL('./vbox-sdk-capture.py', import.meta.url));
const framesOut = process.env.LBA_FRAMES_OUT ?? join(tmpdir(), 'win-sdk-frames.json');
const window = Number(process.env.LBA_WINDOW ?? 8);
const toleranceHamming = Number(process.env.LBA_TOL_HAMMING ?? 3);

console.log('LabVIEW launch TREND (WIN/VBox-SDK): capturing via vboxapi (VRDE VNC is blind to the WDDM framebuffer) ...');
const cap = spawnSync('python3', [capturer], { stdio: 'inherit', env: { ...process.env, LBA_OUT: framesOut } });
if (cap.status !== 0) { throw new Error(`vbox-sdk-capture.py failed (exit ${cap.status}); ensure vboxapi + the running actor VM + SSH are available`); }

const captured = JSON.parse(readFileSync(framesOut, 'utf8'));
const minLaunchMs = Number(process.env.LBA_MIN_LAUNCH_MS ?? 500);
const records = captured.map(({ launchStartMs, frames }, i) => {
  const rec = buildWorkloadRecord({
    frames,
    workloadStartMs: launchStartMs,
    meta: { plane: 'WIN', hypervisor: 'vbox-sdk', workload: 'labview-ide-launch', iteration: `win-sdk-launch-${i}` },
    settle: { window, toleranceHamming },
  });
  const ms = rec.spans.find((s) => s.id === 'launchMs').ms;
  // Plausibility floor: a real LabVIEW launch is seconds; a sub-floor settle means the screen never transitioned
  // (LabVIEW already open / never rendered a cold launch) -> a static-screen artifact. Fail loud, never emit it.
  if (ms < minLaunchMs) {
    throw new Error(`run ${i + 1}: launchMs=${ms}ms < ${minLaunchMs}ms floor -> static-screen artifact (LabVIEW likely already open at capture start); aborting rather than emit a bogus trend`);
  }
  console.log(`  run ${i + 1}/${captured.length}: launchMs=${ms}ms (${frames.length} frames)`);
  return rec;
});

const trend = buildTrend({
  series: records,
  metric: 'launchMs',
  toleranceMs: Number(process.env.LBA_TOL ?? 2000),
  driftThresholdMsPerRun: Number(process.env.LBA_DRIFT ?? 400),
  meta: { workload: 'labview-ide-launch', plane: 'WIN', hypervisor: 'vbox-sdk' },
});
console.log(`\nLabVIEW IDE-launch trend over ${trend.n} runs: ${trend.verdict}`);
console.log(`  values : ${trend.values.join(', ')} ms`);
console.log(`  stats  : min ${trend.stats.min} / median ${trend.stats.median} / mean ${trend.stats.mean} / max ${trend.stats.max} / stddev ${trend.stats.stddev} / spread ${trend.stats.spread} ms`);
console.log(`  baseline ${trend.baselineMs}ms (tol ${trend.toleranceMs}), slope ${trend.slopeMsPerRun} ms/run${trend.drifting ? ' (DRIFTING)' : ''}`);
if (process.env.LBA_OUT) { writeFileSync(process.env.LBA_OUT, `${JSON.stringify(trend, null, 2)}\n`); console.log(`trend -> ${process.env.LBA_OUT}`); }
console.log('done: continuous WIN (VBox SDK) LabVIEW-launch trend captured through the visual ring.');
