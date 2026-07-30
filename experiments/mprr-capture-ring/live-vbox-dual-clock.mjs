// live-vbox-dual-clock.mjs — LIVE visual dual-clock on VirtualBox. Drives the fiducial INSIDE the guest (renders
// on the guest display, advanced on the GUEST monotonic clock via in-guest-fiducial.py over SSH) while the host
// captures the guest framebuffer over VNC and reads which step each frame shows -> pairs guest-display-time to
// host-capture-time (the VISUAL analog of the boot-benchmark dual-clock). Ungated live entry (needs the VM).
//
//   Env: LBA_VNC_HOST(127.0.0.1) LBA_VNC_PORT(5900) LBA_VNC_PASSWORD LBA_FPS(12)
//        LBA_SSH_KEY(~/.ssh/lba_scratch) LBA_SSH_PORT(2222) LBA_SSH_USER(actor)
//        LBA_GUEST_SCRIPT(/tmp/in-guest-fiducial.py) LBA_INTERVAL_MS(400) LBA_OUT(<receipt path>)
//   node experiments/mprr-capture-ring/live-vbox-dual-clock.mjs

import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createVboxVncSource, VBOX_DEFAULT_VNC_PORT } from './vbox-vnc-source.mjs';
import { DUAL_CLOCK_TICKS, correlateVisualDualClock } from './visual-dual-clock.mjs';

const host = process.env.LBA_VNC_HOST ?? '127.0.0.1';
const port = Number(process.env.LBA_VNC_PORT ?? VBOX_DEFAULT_VNC_PORT);
const fps = Number(process.env.LBA_FPS ?? 12);
const password = process.env.LBA_VNC_PASSWORD ?? undefined;
const sshKey = process.env.LBA_SSH_KEY ?? `${os.homedir()}/.ssh/lba_scratch`;
const sshPort = process.env.LBA_SSH_PORT ?? '2222';
const sshUser = process.env.LBA_SSH_USER ?? 'actor';
const guestScript = process.env.LBA_GUEST_SCRIPT ?? '/tmp/in-guest-fiducial.py';
const intervalMs = Number(process.env.LBA_INTERVAL_MS ?? 400);
const ticks = DUAL_CLOCK_TICKS;
const durationMs = ticks.length * intervalMs + 3000;

// Host capture: record { hostMs, dhashHex } per sampled frame (the fiducial always carries the center anchor,
// so no frame is the all-zero sentinel — every frame decodes to a step or is unknown noise).
const captured = [];
const src = createVboxVncSource({
  host, port, password, fps, durationMs,
  connect: ({ host, port }) => net.connect({ host, port }),
  onFrame: (d) => captured.push({ hostMs: Date.now(), dhashHex: d.dhash64 }),
});
const dims = await src.ready;
console.log(`capture connected: ${dims.width}x${dims.height} @ ${host}:${port} (${password ? 'VNC-auth' : 'None-auth'})`);

// Guest render: stop gdm (free the display) + run the fiducial renderer over SSH, collecting its stdout log.
const remote = `sudo -n systemctl stop gdm 2>/dev/null; sudo -n python3 ${guestScript} --ticks ${ticks.join(',')} --interval-ms ${intervalMs} --width ${dims.width} --height ${dims.height}`;
const sshArgs = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=12', '-i', sshKey, '-p', sshPort, `${sshUser}@127.0.0.1`, remote];
const guestLines = [];
const ssh = spawn('ssh', sshArgs);
ssh.stdout.on('data', (b) => { for (const line of b.toString().split('\n')) if (line.trim()) guestLines.push(line.trim()); });
ssh.stderr.on('data', () => {});
const guestDone = new Promise((resolve) => ssh.on('close', resolve));

await guestDone;
await src.done;

const guestSteps = guestLines.map((l) => {
  const m = /step=(\d+) tick=(\d+) guestMonoNs=(\d+)/.exec(l);
  return m ? { step: Number(m[1]), tick: Number(m[2]), guestMonoMs: Number(BigInt(m[3]) / 1_000_000n) } : null;
}).filter(Boolean);
console.log(`guest advanced ${guestSteps.length} steps; host captured ${captured.length} frames`);
if (guestSteps.length < 2) { console.error('FAIL: guest did not render (check gdm stop / sudo / /dev/fb0)'); process.exit(1); }

const receipt = correlateVisualDualClock({ guestSteps, captured, w: dims.width, h: dims.height });
console.log(`visual dual-clock: ${receipt.pairedSteps} steps paired; (host-guest) delta mean ${receipt.driftMs.meanDelta}ms spread ${receipt.driftMs.spreadMs}ms`);
for (const p of receipt.pairs) console.log(`  step ${p.step} tick ${p.tick}: guest +${p.relGuestMs}ms  host +${p.relHostMs}ms  delta ${p.deltaMs}ms`);
if (process.env.LBA_OUT) { writeFileSync(process.env.LBA_OUT, `${JSON.stringify(receipt, null, 2)}\n`); console.log(`receipt -> ${process.env.LBA_OUT}`); }
console.log('done: visual dual-clock correlated (guest-display-time -> host-capture-time).');
