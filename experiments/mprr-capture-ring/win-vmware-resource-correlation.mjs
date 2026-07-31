// win-vmware-resource-correlation.mjs — the WIN/VMware mirror of live-vbox-resource-correlation.mjs (LBA-REQ-011
// live): benchmark a REAL LabVIEW IDE launch through the visual ring WHILE sampling the guest's CPU/RAM/disk
// in-guest, then correlate the samples to the captured frame timeline anchored on the UI-READY settle instant
// (the trigger). Pre-trigger = machine load WHILE LAUNCHING; post-trigger = once the IDE is READY / settled.
//
// Clocks: frames are stamped with the HOST epoch (Date.now()); the in-guest sampler stamps the GUEST epoch. We
// measure the guest-minus-host offset once (min-RTT of a few `date +%s%3N` round trips) and fold the samples
// onto the host axis, so the frame timeline, the trigger, and the samples share one epoch-ms axis.
//
// Ungated live entry (needs the activated VMware LabVIEW clean-room). Guest prereqs: /etc/X11/Xwrapper.config
// allowed_users=anybody, passwordless sudo, VMware RemoteDisplay.vnc on 127.0.0.1:5901, Python 3.
//   Env: LBA_VNC_HOST(127.0.0.1) LBA_VNC_PORT(5901) LBA_VNC_PASSWORD LBA_FPS(12) LBA_DURATION_MS(20000)
//        LBA_SSH_KEY(~/.vagrant.d/insecure_private_key) LBA_GUEST_IP(192.168.198.144) LBA_SSH_USER(actor)
//        LBA_SAMPLE_MS(100) LBA_LABVIEW_BIN(/usr/local/bin/labview64) LBA_TOL(3) LBA_WINDOW(10) LBA_OUT(<path>)
//   node experiments/mprr-capture-ring/win-vmware-resource-correlation.mjs

import net from 'node:net';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVmwareVncSource } from './vmware-vnc-source.mjs';
import { buildWorkloadRecord } from './workload-benchmark.mjs';
import { buildResourceCorrelatedLaunch, guestSamplesToHostEpoch } from './resource-correlated-record.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const host = process.env.LBA_VNC_HOST ?? '127.0.0.1';
const port = Number(process.env.LBA_VNC_PORT ?? 5901);
const fps = Number(process.env.LBA_FPS ?? 12);
const password = process.env.LBA_VNC_PASSWORD ?? undefined; // VMware = None-auth in our runs
const sshKey = process.env.LBA_SSH_KEY ?? `${os.homedir()}/.vagrant.d/insecure_private_key`;
const guestIp = process.env.LBA_GUEST_IP ?? '192.168.198.144';
const sshUser = process.env.LBA_SSH_USER ?? 'actor';
const durationMs = Number(process.env.LBA_DURATION_MS ?? 20000);
const sampleMs = Number(process.env.LBA_SAMPLE_MS ?? 100);
const labviewBin = process.env.LBA_LABVIEW_BIN ?? '/usr/local/bin/labview64';

const SSH = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=12', '-i', sshKey, `${sshUser}@${guestIp}`];
const sshRun = (cmd, opts = {}) => spawnSync('ssh', [...SSH, cmd], { encoding: 'utf8', ...opts });

// 1) Measure the guest-minus-host epoch offset (min-RTT of a few round trips -> least mid-point error).
let offsetMs = 0;
let bestRtt = Infinity;
for (let i = 0; i < 5; i += 1) {
  const t0 = Date.now();
  const r = sshRun('date +%s%3N');
  const t1 = Date.now();
  const guest = Number(String(r.stdout).trim());
  if (!Number.isFinite(guest)) continue;
  const rtt = t1 - t0;
  if (rtt < bestRtt) {
    bestRtt = rtt;
    offsetMs = guest - (t0 + t1) / 2;
  }
}
console.log(`host<->guest offset: ${Math.round(offsetMs)}ms (min RTT ${bestRtt}ms)`);

// 2) Ship the in-guest sampler + clear any prior samples, and establish a LEAN pre-launch BASELINE: stop gdm
//    (and kill any prior LabVIEW/X) so the desktop's resident RAM is freed BEFORE the sampler's pre-window
//    baseline. Otherwise the pre-window would include the full GNOME session, which the launch path tears down
//    as it starts LabVIEW — so the RAM delta would read GNOME-teardown, not LabVIEW's resident load. With a
//    lean baseline the pre->post RAM delta is LabVIEW's real cost (matches the LINUX/vbox +~117 MB result).
const samplerSrc = readFileSync(join(HERE, 'in-guest-resource-sampler.py'), 'utf8');
const shipped = spawnSync('ssh', [...SSH, 'cat > /tmp/lba-sampler.py'], { input: samplerSrc, encoding: 'utf8' });
if (shipped.status !== 0) { console.error('failed to ship sampler:', shipped.stderr); process.exit(1); }
sshRun('sudo -n pkill -f labview64 2>/dev/null; sudo -n pkill -f xinit 2>/dev/null; pkill -f lba-sampler.py 2>/dev/null; sudo -n systemctl stop gdm 2>/dev/null; sleep 5; sudo -n rm -f /tmp/.X0-lock /tmp/lba-samples.jsonl');
const samplerDurationMs = durationMs + 3000;

// 3) Start the capture (host-epoch ms + frame dhash per sampled frame).
const frames = [];
const src = createVmwareVncSource({
  host, port, password, fps, durationMs,
  connect: ({ host, port }) => net.connect({ host, port }),
  onFrame: (d) => frames.push({ ms: Date.now(), dhashHex: d.dhash64 }),
});
const dims = await src.ready;
console.log(`capture connected: ${dims.width}x${dims.height} @ ${host}:${port}; launching LabVIEW + capturing ${durationMs}ms...`);

// 3b) Start the in-guest sampler in a PERSISTENT ssh session (foreground python). A nohup'd background process
//     is reaped by systemd-logind when its starting session closes (KillUserProcesses); keeping the session
//     open for the whole capture keeps the sampler alive. It self-terminates after its window; kill as backstop.
const samplerSsh = spawn('ssh', [...SSH, `python3 /tmp/lba-sampler.py /tmp/lba-samples.jsonl ${samplerDurationMs} ${sampleMs}`], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500)); // let the sampler take its first baseline reads
console.log(`in-guest sampler started (${sampleMs}ms interval, persistent session)`);

// 4) Trigger the LabVIEW launch ASYNC (capture + sampler keep running through it).
const launchStartMs = Date.now();
const remote = `m=$(awk '{print $1}' /proc/uptime); echo WORKLOAD_START_MONO=$m; sudo -n systemctl stop gdm 2>/dev/null; sleep 1; nohup xinit ${labviewBin} -- :0 vt1 -nolisten tcp > /tmp/xinit.log 2>&1 & echo TRIGGERED`;
const ssh = spawn('ssh', [...SSH, remote]);
let sshOut = '';
ssh.stdout.on('data', (b) => { sshOut += b.toString(); });
ssh.stderr.on('data', () => {});
await new Promise((resolve) => ssh.on('close', resolve));
const monoMatch = /WORKLOAD_START_MONO=([\d.]+)/.exec(sshOut);
const workloadStartGuestMonoNs = monoMatch ? Math.round(Number(monoMatch[1]) * 1e9) : null;
console.log(`launch triggered (guest mono ${monoMatch?.[1] ?? '?'}s)`);

// 5) Let the capture run to durationMs (LabVIEW loads + settles; static UI = the stable tail).
await src.done;
console.log(`captured ${frames.length} frames`);

// 6) Fetch the in-guest samples (guest epoch-ms JSONL).
const samplesRaw = sshRun('cat /tmp/lba-samples.jsonl 2>/dev/null');
const guestSamples = String(samplesRaw.stdout)
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);
console.log(`fetched ${guestSamples.length} in-guest resource samples`);
try { samplerSsh.kill(); } catch { /* backstop; the sampler self-terminates after its window */ }

// 7) Assemble the workload record (settle detector -> launchMs + the UI-READY trigger).
const record = buildWorkloadRecord({
  frames,
  workloadStartMs: launchStartMs,
  meta: { plane: 'WIN', hypervisor: 'vmware-vnc', workload: 'labview-ide-launch', workloadStartGuestMonoNs },
  settle: { window: Number(process.env.LBA_WINDOW ?? 10), toleranceHamming: Number(process.env.LBA_TOL ?? 3) },
});
const launch = record.spans.find((s) => s.id === 'launchMs');
console.log(`launchMs=${launch.ms}ms; UI-READY settle @host ${record.sourceDetail.settleMs} (trigger)`);

// 8) Fold the guest samples onto the host axis + correlate, anchored on the settle instant.
const hostSamples = guestSamplesToHostEpoch(guestSamples, offsetMs);
const rc = buildResourceCorrelatedLaunch({
  record,
  hostSamples,
  epochMsAtFrameZero: frames.length ? frames[0].ms : launchStartMs,
  frameRateHz: fps,
  hostGuestOffsetMs: Math.round(offsetMs),
});
console.log(`resource correlation (pre=launching / post=settled), ${rc.preSampleCount} pre / ${rc.postSampleCount} post samples:`);
console.log(`  CPU%   ${rc.headline.cpuPreMean} -> ${rc.headline.cpuPostMean}   Δ ${rc.headline.cpuDeltaMean}`);
console.log(`  RAM MB ${rc.headline.ramPreMean} -> ${rc.headline.ramPostMean}   Δ ${rc.headline.ramDeltaMean}`);
console.log(`  Disk%  ${rc.headline.diskPreMean} -> ${rc.headline.diskPostMean}   Δ ${rc.headline.diskDeltaMean}`);

if (process.env.LBA_OUT) { writeFileSync(process.env.LBA_OUT, `${JSON.stringify(rc, null, 2)}\n`); console.log(`record -> ${process.env.LBA_OUT}`); }
console.log('done: real WIN LabVIEW launch resource-correlated through the visual ring.');
