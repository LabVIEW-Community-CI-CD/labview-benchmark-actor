// win-vmware-labview-launch.mjs — the WIN-plane mirror of live-vbox-labview-launch.mjs: a LIVE benchmark of a
// REAL LabVIEW workload (IDE launch) through the visual ring, captured via the WIN VMware RemoteDisplay VNC
// source while LabVIEW launches on the console (xinit on the freed VT). WIN's settle detector finds the
// "UI READY" pin and buildWorkloadRecord assembles the boot-benchmark-v1 workload record:
//   launchMs = UI-ready-settle - launch-trigger  (HOST-observed, cross-plane witness).
// Ungated live entry (needs the activated VMware LabVIEW clean-room). Prereqs on the guest:
// /etc/X11/Xwrapper.config allowed_users=anybody, passwordless sudo, VMware RemoteDisplay.vnc on 127.0.0.1:5901.
//
//   Env: LBA_VNC_HOST(127.0.0.1) LBA_VNC_PORT(5901) LBA_VNC_PASSWORD LBA_FPS(12) LBA_DURATION_MS(40000)
//        LBA_SSH_KEY(~/.vagrant.d/insecure_private_key) LBA_GUEST_IP(192.168.198.144) LBA_SSH_USER(actor)
//        LBA_LABVIEW_BIN(/usr/local/bin/labview64) LBA_WINDOW(10) LBA_TOL(3) LBA_OUT(<record path>)
//   node experiments/mprr-capture-ring/win-vmware-labview-launch.mjs

import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createVmwareVncSource } from './vmware-vnc-source.mjs';
import { buildWorkloadRecord } from './workload-benchmark.mjs';

const host = process.env.LBA_VNC_HOST ?? '127.0.0.1';
const port = Number(process.env.LBA_VNC_PORT ?? 5901);
const fps = Number(process.env.LBA_FPS ?? 12);
const password = process.env.LBA_VNC_PASSWORD ?? undefined; // VMware = None-auth in our runs
const sshKey = process.env.LBA_SSH_KEY ?? `${os.homedir()}/.vagrant.d/insecure_private_key`;
const guestIp = process.env.LBA_GUEST_IP ?? '192.168.198.144';
const sshUser = process.env.LBA_SSH_USER ?? 'actor';
const durationMs = Number(process.env.LBA_DURATION_MS ?? 40000);
const labviewBin = process.env.LBA_LABVIEW_BIN ?? '/usr/local/bin/labview64';

// 1) Start the capture (host-clock ms + frame dhash per sampled frame).
const frames = [];
const src = createVmwareVncSource({
  host, port, password, fps, durationMs,
  connect: ({ host, port }) => net.connect({ host, port }),
  onFrame: (d) => frames.push({ ms: Date.now(), dhashHex: d.dhash64 }),
});
const dims = await src.ready;
console.log(`capture connected: ${dims.width}x${dims.height} @ ${host}:${port}; launching LabVIEW + capturing ${durationMs}ms...`);

// 2) Trigger the LabVIEW launch ASYNC (so the capture keeps running through it): grab the guest CLOCK_MONOTONIC
//    for provenance, stop gdm to free the VT, xinit labview64 on the console (detached).
const launchStartMs = Date.now();
const remote = `m=$(awk '{print $1}' /proc/uptime); echo WORKLOAD_START_MONO=$m; sudo -n systemctl stop gdm 2>/dev/null; sleep 1; nohup xinit ${labviewBin} -- :0 vt1 -nolisten tcp > /tmp/xinit.log 2>&1 & echo TRIGGERED`;
const ssh = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=12', '-i', sshKey, `${sshUser}@${guestIp}`, remote]);
let sshOut = '';
ssh.stdout.on('data', (b) => { sshOut += b.toString(); });
ssh.stderr.on('data', () => {});
await new Promise((resolve) => ssh.on('close', resolve));
const monoMatch = /WORKLOAD_START_MONO=([\d.]+)/.exec(sshOut);
const workloadStartGuestMonoNs = monoMatch ? Math.round(Number(monoMatch[1]) * 1e9) : null;
console.log(`launch triggered (guest mono ${monoMatch?.[1] ?? '?'}s at launch)`);

// 3) Let the capture run to durationMs (LabVIEW loads + settles; the static UI = the stable tail).
await src.done;
console.log(`captured ${frames.length} frames`);

// 4) Assemble the workload record: WIN's settle detector -> launchMs + the UI-READY visual pin.
const rec = buildWorkloadRecord({
  frames,
  workloadStartMs: launchStartMs,
  meta: { plane: 'WIN', hypervisor: 'vmware-vnc', workload: 'labview-ide-launch', workloadStartGuestMonoNs },
  settle: { window: Number(process.env.LBA_WINDOW ?? 10), toleranceHamming: Number(process.env.LBA_TOL ?? 3) },
});
const launch = rec.spans.find((s) => s.id === 'launchMs');
console.log(`LabVIEW IDE launch (visual ring): launchMs=${launch.ms}ms (host-observed, cross-plane witness)`);
console.log(`  UI-READY pin: dhash ${rec.frames[0].perceptualFingerprint}, settleMs +${rec.sourceDetail.settleMs - launchStartMs}ms, stable tail ${rec.sourceDetail.stableTailFrames}/${rec.sourceDetail.framesCaptured} frames`);
if (process.env.LBA_OUT) { writeFileSync(process.env.LBA_OUT, `${JSON.stringify(rec, null, 2)}\n`); console.log(`record -> ${process.env.LBA_OUT}`); }
console.log('done: real WIN LabVIEW workload benchmarked through the visual ring.');
