// win-vmware-labview-trend.mjs — the WIN-plane mirror of live-vbox-labview-trend.mjs: a CONTINUOUS/TREND run that
// benchmarks the LabVIEW IDE launch through the visual ring N times on the VMware clean-room and builds the
// launchMs trend (stats + regression + drift). Each iteration kills the prior LabVIEW/X, launches fresh on the
// console (xinit on the freed VT), captures via the WIN VMware VNC source, and assembles a workload record;
// buildTrend turns the N records into a trend receipt. Ungated live entry (needs the activated VMware LabVIEW
// clean-room). Prereqs on the guest: /etc/X11/Xwrapper.config allowed_users=anybody, passwordless sudo,
// VMware RemoteDisplay.vnc on 127.0.0.1:5901.
//
//   Env: LBA_ITERATIONS(5) LBA_DURATION_MS(16000) LBA_VNC_HOST(127.0.0.1) LBA_VNC_PORT(5901) LBA_VNC_PASSWORD
//        LBA_FPS(12) LBA_TOL(2000) LBA_DRIFT(400) LBA_TOL_HAMMING(3) LBA_WINDOW(8)
//        LBA_SSH_KEY(~/.vagrant.d/insecure_private_key) LBA_GUEST_IP(192.168.198.144) LBA_SSH_USER(actor)
//        LBA_LABVIEW_BIN(/usr/local/bin/labview64) LBA_OUT(<trend path>)
//   node experiments/mprr-capture-ring/win-vmware-labview-trend.mjs

import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createVmwareVncSource } from './vmware-vnc-source.mjs';
import { buildWorkloadRecord } from './workload-benchmark.mjs';
import { buildTrend } from './trend.mjs';

const host = process.env.LBA_VNC_HOST ?? '127.0.0.1';
const port = Number(process.env.LBA_VNC_PORT ?? 5901);
const fps = Number(process.env.LBA_FPS ?? 12);
const password = process.env.LBA_VNC_PASSWORD ?? undefined; // VMware = None-auth in our runs
const sshKey = process.env.LBA_SSH_KEY ?? `${os.homedir()}/.vagrant.d/insecure_private_key`;
const guestIp = process.env.LBA_GUEST_IP ?? '192.168.198.144';
const sshUser = process.env.LBA_SSH_USER ?? 'actor';
const labviewBin = process.env.LBA_LABVIEW_BIN ?? '/usr/local/bin/labview64';
const iterations = Number(process.env.LBA_ITERATIONS ?? 5);
const durationMs = Number(process.env.LBA_DURATION_MS ?? 16000);

const sshExec = (cmd) => new Promise((resolve) => {
  const p = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=12', '-i', sshKey, `${sshUser}@${guestIp}`, cmd]);
  let out = '';
  p.stdout.on('data', (b) => { out += b.toString(); });
  p.stderr.on('data', () => {});
  p.on('close', () => resolve(out));
});

/** Capture ONE LabVIEW launch through the visual ring -> a workload record. */
async function captureOnce() {
  // clean pre-launch state: kill prior LabVIEW/X + release the X lock, leave gdm stopped (console free).
  await sshExec("pkill -f labview64 2>/dev/null; pkill -f xinit 2>/dev/null; pkill -f 'Xorg :0' 2>/dev/null; sleep 2; sudo -n rm -f /tmp/.X0-lock 2>/dev/null; true");
  const frames = [];
  const src = createVmwareVncSource({
    host, port, password, fps, durationMs,
    connect: ({ host, port }) => net.connect({ host, port }),
    onFrame: (d) => frames.push({ ms: Date.now(), dhashHex: d.dhash64 }),
  });
  await src.ready;
  const launchStartMs = Date.now();
  await sshExec(`sudo -n systemctl stop gdm 2>/dev/null; sleep 1; nohup xinit ${labviewBin} -- :0 vt1 -nolisten tcp > /tmp/xinit.log 2>&1 & echo TRIGGERED`);
  await src.done;
  return buildWorkloadRecord({
    frames, workloadStartMs: launchStartMs,
    meta: { plane: 'WIN', hypervisor: 'vmware-vnc', workload: 'labview-ide-launch' },
    settle: { window: Number(process.env.LBA_WINDOW ?? 8), toleranceHamming: Number(process.env.LBA_TOL_HAMMING ?? 3) },
  });
}

console.log(`LabVIEW launch TREND (WIN/VMware): ${iterations} runs @ ${durationMs}ms capture each ...`);
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
  meta: { workload: 'labview-ide-launch', plane: 'WIN', hypervisor: 'vmware-vnc' },
});
console.log(`\nLabVIEW IDE-launch trend over ${trend.n} runs: ${trend.verdict}`);
console.log(`  values : ${trend.values.join(', ')} ms`);
console.log(`  stats  : min ${trend.stats.min} / median ${trend.stats.median} / mean ${trend.stats.mean} / max ${trend.stats.max} / stddev ${trend.stats.stddev} / spread ${trend.stats.spread} ms`);
console.log(`  baseline ${trend.baselineMs}ms (tol ${trend.toleranceMs}), slope ${trend.slopeMsPerRun} ms/run${trend.drifting ? ' (DRIFTING)' : ''}`);
if (process.env.LBA_OUT) { writeFileSync(process.env.LBA_OUT, `${JSON.stringify(trend, null, 2)}\n`); console.log(`trend -> ${process.env.LBA_OUT}`); }
console.log('done: continuous WIN LabVIEW-launch trend captured through the visual ring.');
