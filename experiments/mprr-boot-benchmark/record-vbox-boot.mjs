// record-vbox-boot.mjs — the LINUX half of the live boot-benchmark co-run: capture + seal a REAL VBox
// mesh-actor from-source boot into a boot-benchmark-v1 record. The WIN half is the VMware VNC equivalent.
//
// It wires the shared, provider-agnostic driver (boot-recorder.mjs) to the real VBox dependencies:
//   - capture backend = createVboxBackend  (VBoxManage controlvm <vm> screenshotpng, from power-on)
//   - serial pins     = fileSerialSource   (tails the host file COM1 is sinked to: `--uartmode1 file`)
//   - guest timing    = journalctl -o short-monotonic over SSH, parsed by parseJournalMonotonic
// then `recordBoot()` starts the VM, captures at cadence, correlates the milestones, and seals.
//
// PREP (once, powered off):  VBoxManage modifyvm <vm> --uart1 0x3F8 4 --uartmode1 file <serialFile>
//   and provision the guest from main (embeds emit-boot-marker.sh + the emit units). For a from-source
//   FIRST boot, the clone/VM must have NO baked lbabus (ConditionPathExists=!/usr/local/bin/lbabus).
//
// PROVEN (2026-07-30, scratch VM, mesh-less BUILD leg): 150 frames, buildMs=5167ms, serial<->journald
// skews 6-11ms; the sealed record passes WIN's boot-benchmark-diff (self-diff -> TIMING_OK).
//
// Config via env (all optional except a running-capable VM + a serial sink file):
//   LBA_VM (default lba-ubuntu2404-labview2026-scratch)  LBA_SERIAL (default /tmp/lba-serial.txt)
//   LBA_SSH_KEY (~/.ssh/lba_scratch)  LBA_SSH_HOST (actor@127.0.0.1)  LBA_SSH_PORT (2222)
//   LBA_OUT (/tmp/vbox-boot-record.json)  LBA_ITERATION (vbox-<SOURCE_COMMIT|dev>)
//   LBA_MILESTONES (BOOT-START,LBABUS-BUILD-START,LBABUS-BUILT,MESH-OK)
//   LBA_CADENCE_HZ (2)  LBA_MAX_MS (180000)  LBA_SKEW_MS (unset -> seal default 500)
//   LBA_MATCH (unit | lbabench; default unit = the shipped DEFAULT_MATCHERS, reuse existing unit log lines)
//
//   node experiments/mprr-boot-benchmark/record-vbox-boot.mjs

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { recordBoot, fileSerialSource } from './boot-recorder.mjs';
import { createVboxBackend } from './capture-backend-vbox.mjs';
import { parseJournalMonotonic, DEFAULT_MATCHERS } from './journal-monotonic.mjs';

const env = process.env;
const VM = env.LBA_VM ?? 'lba-ubuntu2404-labview2026-scratch';
const SERIAL = env.LBA_SERIAL ?? '/tmp/lba-serial.txt';
const SSH_KEY = env.LBA_SSH_KEY ?? `${homedir()}/.ssh/lba_scratch`;
const SSH_HOST = env.LBA_SSH_HOST ?? 'actor@127.0.0.1';
const SSH_PORT = env.LBA_SSH_PORT ?? '2222';
const OUT = env.LBA_OUT ?? '/tmp/vbox-boot-record.json';
const MILESTONES = (env.LBA_MILESTONES ?? 'BOOT-START,LBABUS-BUILD-START,LBABUS-BUILT,MESH-OK').split(',').map((s) => s.trim()).filter(Boolean);
const CADENCE_HZ = Number(env.LBA_CADENCE_HZ ?? 2);
const MAX_MS = Number(env.LBA_MAX_MS ?? 180000);
const SKEW_MS = env.LBA_SKEW_MS != null ? Number(env.LBA_SKEW_MS) : undefined;

// 'lbabench' matches the uniform emit lines (same emit that writes the serial pin -> tight skew); 'unit'
// (default) reuses the existing unit log lines ("building lbabus" / "lbabus built" / "MESH OK") per the
// shipped DEFAULT_MATCHERS, so no new timing instrumentation is required.
const LBABENCH_MATCHERS = {
  'BOOT-START': /LBABENCH BOOT-START/,
  'LBABUS-BUILD-START': /LBABENCH LBABUS-BUILD-START/,
  'LBABUS-BUILT': /LBABENCH LBABUS-BUILT/,
  'MESH-OK': /LBABENCH MESH-OK/,
};
const useLbabench = (env.LBA_MATCH ?? 'unit') === 'lbabench';
const matchers = useLbabench ? LBABENCH_MATCHERS : DEFAULT_MATCHERS;

const SSH = ['-i', SSH_KEY, '-p', SSH_PORT, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', SSH_HOST];
function ssh(cmd) {
  return execFileSync('ssh', [...SSH, cmd], { encoding: 'utf8' });
}

const backend = createVboxBackend({ vm: VM });
const serialSource = fileSerialSource(SERIAL);
// One post-run journald read for the AUTHORITATIVE guest CLOCK_MONOTONIC. `+` ORs the match groups so we get
// the build unit + mesh unit lines AND the lbabench-tagged BOOT-START line in one query.
const journalReader = () => {
  try {
    const out = ssh('journalctl -o short-monotonic -b _SYSTEMD_UNIT=lba-lbabus-build.service + _SYSTEMD_UNIT=lba-mesh.service + SYSLOG_IDENTIFIER=lbabench --no-pager');
    return parseJournalMonotonic(out, matchers);
  } catch (e) {
    console.error('journalReader: ssh journalctl failed:', e.message);
    return {};
  }
};

const iteration = env.LBA_ITERATION ?? (() => {
  try { return `vbox-${ssh('cat /opt/lba/SOURCE_COMMIT 2>/dev/null || echo dev').trim().slice(0, 12)}`; } catch { return 'vbox-dev'; }
})();

console.log(`recording a REAL VBox from-source boot: vm=${VM} milestones=${MILESTONES.join(',')} match=${useLbabench ? 'lbabench' : 'unit'}`);
const rec = await recordBoot({
  iteration, sessionId: `linux-${Date.now()}`, vm: VM, hypervisor: 'virtualbox', plane: 'LINUX',
  backend, serialSource, journalReader,
  milestones: MILESTONES, cadenceHz: CADENCE_HZ, maxDurationMs: MAX_MS, startVm: true,
  ...(SKEW_MS != null ? { skewToleranceMs: SKEW_MS } : {}),
});

writeFileSync(OUT, `${JSON.stringify(rec, null, 2)}\n`);
console.log(`SEALED -> ${OUT}`);
console.log(`frames=${rec.frames.length} recordHash=${rec.seal.recordHash}`);
console.log('pins:', rec.anchor.correlation.pins.map((p) => `${p.caseId}@f${p.frameIndex} guest=${p.guestMonotonicMs}ms skew=${p.skewMs}ms`).join(' | '));
console.log('spans:', JSON.stringify(rec.spans.map((s) => ({ id: s.id, ms: s.ms, scope: s.scope }))));
