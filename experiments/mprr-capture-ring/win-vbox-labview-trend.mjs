// win-vbox-labview-trend.mjs — the WINDOWS-OS-plane runner for the `actor` VirtualBox VM (Windows 11 + LabVIEW).
// A CONTINUOUS/TREND run that benchmarks the LabVIEW IDE launch-to-ready through the visual ring N times and builds
// the launchMs trend (stats + regression + drift), mirroring live-vbox-labview-trend.mjs (LINUX) — SAME plane-neutral
// RFB/VNC capture core (vbox-vnc-source.mjs) so a Windows VBox capture emits BYTE-IDENTICAL capture-ring descriptors
// to the LINUX VBox capture; only the LAUNCH TRIGGER is Windows-native (Start-Process LabVIEW.exe / taskkill, not
// xinit). This is the WIN plane for the agent-driven N=2 mesh run: its workload-trend@1 is wrapped as a
// returned-receipt@1 and handed back to `lba mesh-run`. Ungated live entry (needs the running Windows VM + activated
// LabVIEW + VBox VNC + OpenSSH).
//
// Guest prereqs (Windows `actor` VM): OpenSSH server RUNNING (guest :22 -> host 127.0.0.1:<LBA_SSH_PORT>) with the
// host pubkey in the actor user's authorized_keys; VBox VNC (VRDE VNC module) on host 127.0.0.1:<LBA_VNC_PORT>; and a
// scheduled task `LBA-LaunchLabVIEW` that runs LabVIEW.exe IN THE LOGGED-IN INTERACTIVE SESSION. The scheduled task
// is REQUIRED because a process launched from an SSH/WinRM session runs in Windows session 0 (services), whose GUI is
// NOT the interactive desktop the VNC source captures -- `schtasks /run` places the launch in the user's session so
// LabVIEW actually renders on the captured screen. Create it once in the guest (as the logged-in user), e.g.:
//   schtasks /create /tn LBA-LaunchLabVIEW /tr "'C:\Program Files\National Instruments\LabVIEW 2026\LabVIEW.exe'" /sc ONCE /st 00:00 /rl HIGHEST /f
// Host-side (NOT the guest): switch the VM's remote display to the VNC module + restart:
//   VBoxManage setproperty vrdeextpack VNC ; VBoxManage modifyvm actor --vrde on --vrdeproperty VNCPassword= --vrdeport 5900
//
//   Env: LBA_ITERATIONS(5) LBA_DURATION_MS(16000) LBA_VNC_HOST(127.0.0.1) LBA_VNC_PORT(5900) LBA_VNC_PASSWORD
//        LBA_FPS(12) LBA_TOL(2000) LBA_DRIFT(400) LBA_TOL_HAMMING(3) LBA_WINDOW(8)
//        LBA_SSH_KEY(~/.ssh/lba_scratch) LBA_SSH_PORT(2200) LBA_SSH_USER(actor)
//        LBA_WIN_TASK(LBA-LaunchLabVIEW) LBA_WIN_LAUNCH_CMD (override the launch command) LBA_WIN_KILL_CMD (override pre-clean)
//        LBA_OUT(<trend path>)
//   node experiments/mprr-capture-ring/win-vbox-labview-trend.mjs

import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createVboxVncSource, VBOX_DEFAULT_VNC_PORT } from './vbox-vnc-source.mjs';
import { buildWorkloadRecord } from './workload-benchmark.mjs';
import { buildTrend } from './trend.mjs';

const host = process.env.LBA_VNC_HOST ?? '127.0.0.1';
const port = Number(process.env.LBA_VNC_PORT ?? VBOX_DEFAULT_VNC_PORT);
const fps = Number(process.env.LBA_FPS ?? 12);
const password = process.env.LBA_VNC_PASSWORD ?? undefined;
const sshKey = process.env.LBA_SSH_KEY ?? `${os.homedir()}/.ssh/lba_scratch`;
const sshPort = process.env.LBA_SSH_PORT ?? '2200';
const sshUser = process.env.LBA_SSH_USER ?? 'actor';
const iterations = Number(process.env.LBA_ITERATIONS ?? 5);
const durationMs = Number(process.env.LBA_DURATION_MS ?? 16000);
// Windows-native trigger + pre-clean (overridable). The launch goes through a scheduled task so LabVIEW renders in the
// interactive desktop session (NOT session 0), which is what the VNC source captures; taskkill clears any prior IDE.
const winTask = process.env.LBA_WIN_TASK ?? 'LBA-LaunchLabVIEW';
const killCmd = process.env.LBA_WIN_KILL_CMD ?? 'taskkill /F /IM LabVIEW.exe';
const launchCmd = process.env.LBA_WIN_LAUNCH_CMD ?? `schtasks /run /tn ${winTask}`;

const sshExec = (cmd) => new Promise((resolve) => {
  const p = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=12', '-i', sshKey, '-p', sshPort, `${sshUser}@127.0.0.1`, cmd]);
  let out = '';
  p.stdout.on('data', (b) => { out += b.toString(); });
  p.stderr.on('data', () => {});
  p.on('close', () => resolve(out));
});

/** Capture ONE LabVIEW launch through the visual ring -> a workload record. */
async function captureOnce() {
  // clean pre-launch state: kill any prior LabVIEW so the next launch is a cold IDE start (ignore "not found").
  await sshExec(`${killCmd} 2>NUL & ping -n 3 127.0.0.1 >NUL & exit 0`);
  const frames = [];
  const src = createVboxVncSource({
    host, port, password, fps, durationMs,
    connect: ({ host, port }) => net.connect({ host, port }),
    onFrame: (d) => frames.push({ ms: Date.now(), dhashHex: d.dhash64 }),
  });
  await src.ready;
  const launchStartMs = Date.now();
  await sshExec(`${launchCmd} & echo TRIGGERED`);
  await src.done;
  return buildWorkloadRecord({
    frames, workloadStartMs: launchStartMs,
    meta: { plane: 'WIN', hypervisor: 'vbox-vnc', workload: 'labview-ide-launch' },
    settle: { window: Number(process.env.LBA_WINDOW ?? 8), toleranceHamming: Number(process.env.LBA_TOL_HAMMING ?? 3) },
  });
}

console.log(`LabVIEW launch TREND (WIN/VBox): ${iterations} runs @ ${durationMs}ms capture each ...`);
const records = [];
for (let i = 0; i < iterations; i += 1) {
  const rec = await captureOnce();
  const ms = rec.spans.find((s) => s.id === 'launchMs').ms;
  records.push(rec);
  console.log(`  run ${i + 1}/${iterations}: launchMs=${ms}ms`);
}

const trend = buildTrend({
  series: records, metric: 'launchMs',
  toleranceMs: Number(process.env.LBA_TOL ?? 2000),
  driftThresholdMsPerRun: Number(process.env.LBA_DRIFT ?? 400),
  meta: { workload: 'labview-ide-launch', plane: 'WIN', hypervisor: 'vbox-vnc' },
});
console.log(`\nLabVIEW IDE-launch trend over ${trend.n} runs: ${trend.verdict}`);
console.log(`  values : ${trend.values.join(', ')} ms`);
console.log(`  stats  : min ${trend.stats.min} / median ${trend.stats.median} / mean ${trend.stats.mean} / max ${trend.stats.max} / stddev ${trend.stats.stddev} / spread ${trend.stats.spread} ms`);
console.log(`  baseline ${trend.baselineMs}ms (tol ${trend.toleranceMs}), slope ${trend.slopeMsPerRun} ms/run${trend.drifting ? ' (DRIFTING)' : ''}`);
if (process.env.LBA_OUT) { writeFileSync(process.env.LBA_OUT, `${JSON.stringify(trend, null, 2)}\n`); console.log(`trend -> ${process.env.LBA_OUT}`); }
console.log('done: continuous WIN (VBox) LabVIEW-launch trend captured through the visual ring.');
