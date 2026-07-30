// record-vmware-boot.mjs — the WIN half of the live boot-benchmark co-run: capture + seal a REAL VMware
// mesh-actor from-source boot into a boot-benchmark-v1 record. The VMware VNC mirror of record-vbox-boot.mjs.
//
// Wires the shared, provider-agnostic driver (boot-recorder.mjs) to the real VMware dependencies:
//   - capture backend = createVmwareBackend  (RemoteDisplay.vnc framebuffer grab, from power-on)
//   - serial pins     = fileSerialSource     (tails the host file serial0 is sinked to: serial0.fileName)
//   - guest timing    = journalctl -o short-monotonic over SSH, parsed by parseJournalMonotonic
// then recordBoot() starts the VM, captures at cadence, correlates the milestones, and seals.
//
// PREP (once, powered off) — LBA_PREP=1 applies it to the .vmx via upsertVmxConfig, or set it yourself:
//   serial0.present=TRUE / serial0.fileType=file / serial0.fileName=<LBA_SERIAL>   (the LBABENCH pin sink)
//   RemoteDisplay.vnc.enabled=TRUE / RemoteDisplay.vnc.port=<LBA_VNC_PORT>          (the framebuffer source)
//   and provision the guest from main (embeds emit-boot-marker.sh + the emit units). For a from-source FIRST
//   boot the VM must have NO baked lbabus (ConditionPathExists=!/usr/local/bin/lbabus) so the build fires.
//
// Config via env (all optional except a startable VM + a serial sink file):
//   LBA_VMX (path to the .vmx; required)          LBA_VNC_PORT (5901)
//   LBA_SERIAL (default <tmp>/lba-serial.txt)      LBA_VMRUN (vmrun on PATH)
//   LBA_SSH_KEY (~/.vagrant.d/insecure_private_key)  LBA_SSH_HOST (auto: actor@<vmrun getGuestIPAddress>)  LBA_SSH_PORT (22)
//   LBA_OUT (<tmp>/vmware-boot-record.json)        LBA_ITERATION (vmware-<SOURCE_COMMIT|dev>)
//   LBA_MILESTONES (BOOT-START,LBABUS-BUILD-START,LBABUS-BUILT,MESH-OK)
//   LBA_CADENCE_HZ (2)  LBA_MAX_MS (180000)  LBA_SKEW_MS (unset -> seal default 500)
//   LBA_MATCH (unit | lbabench; default unit). For the cross-plane co-run we standardize LBA_MATCH=lbabench
//             (the uniform emit lines -> tight 6-11ms skew; BOOT-START has no unit line so it needs lbabench
//             regardless), matching the pin we already read on the serial channel.
//   LBA_PREP (1 = upsert serial+vnc into the .vmx before starting; VM must be powered off)
//
//   node experiments/mprr-boot-benchmark/record-vmware-boot.mjs

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordBoot, fileSerialSource } from './boot-recorder.mjs';
import { createVmwareBackend, vmwareSerialConfigVmx, vmwareVncConfigVmx, upsertVmxConfig } from './capture-backend-vmware.mjs';
import { parseJournalMonotonic, DEFAULT_MATCHERS } from './journal-monotonic.mjs';

const env = process.env;
const VMX = env.LBA_VMX;
if (!VMX) { console.error('[abort] set LBA_VMX=<path to the .vmx>'); process.exit(2); }
const VNC_PORT = Number(env.LBA_VNC_PORT ?? 5901);
const SERIAL = env.LBA_SERIAL ?? join(tmpdir(), 'lba-serial.txt');
// vmrun is usually NOT on PATH on Windows -> resolve the standard install locations when a bare name is given
// (an explicit LBA_VMRUN path is used as-is). On other OSes the PATH lookup stands.
function resolveVmrun(v) {
  if (v !== 'vmrun') return v;
  for (const p of ['C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe', 'C:\\Program Files\\VMware\\VMware Workstation\\vmrun.exe']) {
    if (existsSync(p)) return p;
  }
  return v;
}
const VMRUN = resolveVmrun(env.LBA_VMRUN ?? 'vmrun');
const SSH_KEY = env.LBA_SSH_KEY ?? join(homedir(), '.vagrant.d', 'insecure_private_key');
const SSH_PORT = env.LBA_SSH_PORT ?? '22';
const OUT = env.LBA_OUT ?? join(tmpdir(), 'vmware-boot-record.json');
const MILESTONES = (env.LBA_MILESTONES ?? 'BOOT-START,LBABUS-BUILD-START,LBABUS-BUILT,MESH-OK').split(',').map((s) => s.trim()).filter(Boolean);
const CADENCE_HZ = Number(env.LBA_CADENCE_HZ ?? 2);
const MAX_MS = Number(env.LBA_MAX_MS ?? 180000);
const SKEW_MS = env.LBA_SKEW_MS != null ? Number(env.LBA_SKEW_MS) : undefined;

// 'lbabench' matches the uniform emit lines (the same emit that writes the serial pin -> tight skew); 'unit'
// (default) reuses the existing unit log lines per the shipped DEFAULT_MATCHERS.
const LBABENCH_MATCHERS = {
  'BOOT-START': /LBABENCH BOOT-START/,
  'LBABUS-BUILD-START': /LBABENCH LBABUS-BUILD-START/,
  'LBABUS-BUILT': /LBABENCH LBABUS-BUILT/,
  'MESH-OK': /LBABENCH MESH-OK/,
};
const useLbabench = (env.LBA_MATCH ?? 'unit') === 'lbabench';
const matchers = useLbabench ? LBABENCH_MATCHERS : DEFAULT_MATCHERS;

function vmrun(args) {
  return execFileSync(VMRUN, ['-T', 'ws', ...args], { encoding: 'utf8' });
}

// Optional PREP: bake the serial sink + VNC server into the .vmx (VM must be powered off).
if (env.LBA_PREP === '1') {
  const kv = [...vmwareSerialConfigVmx({ hostFile: SERIAL }), ...vmwareVncConfigVmx({ port: VNC_PORT })];
  writeFileSync(VMX, upsertVmxConfig(readFileSync(VMX, 'utf8'), kv));
  console.log(`[prep] upserted serial0(file=${SERIAL}) + RemoteDisplay.vnc(port=${VNC_PORT}) into ${VMX}`);
}

// SSH host: explicit, else auto-resolve the guest NAT IP via vmrun (the VM must be up by journalReader time).
function sshHost() {
  if (env.LBA_SSH_HOST) return env.LBA_SSH_HOST;
  try { return `actor@${vmrun(['getGuestIPAddress', VMX, '-wait']).trim()}`; } catch { return 'actor@127.0.0.1'; }
}
const SSH_BASE = ['-i', SSH_KEY, '-p', SSH_PORT, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=8'];
function ssh(cmd) {
  return execFileSync('ssh', [...SSH_BASE, sshHost(), cmd], { encoding: 'utf8' });
}

const backend = createVmwareBackend({ vmx: VMX, vncPort: VNC_PORT, vmrun: VMRUN });
const serialSource = fileSerialSource(SERIAL);
// One post-run journald read for the AUTHORITATIVE guest CLOCK_MONOTONIC (build unit + mesh unit + lbabench).
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
  try { return `vmware-${ssh('cat /opt/lba/SOURCE_COMMIT 2>/dev/null || echo dev').trim().slice(0, 12)}`; } catch { return 'vmware-dev'; }
})();

console.log(`recording a REAL VMware from-source boot: vmx=${VMX} vnc=${VNC_PORT} milestones=${MILESTONES.join(',')} match=${useLbabench ? 'lbabench' : 'unit'}`);
const rec = await recordBoot({
  iteration, sessionId: `win-${Date.now()}`, vm: VMX, hypervisor: 'vmware', plane: 'WIN',
  backend, serialSource, journalReader,
  milestones: MILESTONES, cadenceHz: CADENCE_HZ, maxDurationMs: MAX_MS, startVm: true,
  tmpPathFor: (i) => join(tmpdir(), `lba-boot-${String(i).padStart(5, '0')}.png`),
  ...(SKEW_MS != null ? { skewToleranceMs: SKEW_MS } : {}),
});

writeFileSync(OUT, `${JSON.stringify(rec, null, 2)}\n`);
console.log(`SEALED -> ${OUT}`);
console.log(`frames=${rec.frames.length} recordHash=${rec.seal.recordHash}`);
console.log('pins:', rec.anchor.correlation.pins.map((p) => `${p.caseId}@f${p.frameIndex} guest=${p.guestMonotonicMs}ms skew=${p.skewMs}ms`).join(' | '));
console.log('spans:', JSON.stringify(rec.spans.map((s) => ({ id: s.id, ms: s.ms, scope: s.scope }))));
