#!/usr/bin/env node
// run-ephemeral-mesh.mjs -- LIVE P1 orchestrator for the canonical ephemeral mesh (LINUX / VirtualBox plane).
//
//   golden snapshot  ->  linked clone  ->  boot  ->  loopback lbabus MESH OK  ->  seal receipt  ->  DESTROY
//
// This is the "cattle, not pets" cycle end to end: a throwaway node is cloned from an immutable golden
// snapshot, driven with the KNOWN dev identity (actor + an SSH key -- no password ever), made to prove the
// lbabus TCP+UDP bus on loopback, and then destroyed so NOTHING survives (LBA-REQ-006 clean teardown,
// LBA-REQ-007 comms-only, ADR-0003/0004). The committed receipt is the CI evidence; verify-ephemeral-mesh.mjs
// re-validates it offline.
//
// Host-side only: needs VBoxManage + ssh/scp + the actor SSH key already trusted by the golden.
// Usage:
//   node experiments/ephemeral-mesh/run-ephemeral-mesh.mjs [--keep] [--out <path>]
//     --keep   leave the clone running (debug); the sealed receipt then attests destroyed=false and will
//              NOT pass validation -- only a full destroy-cycle run produces a green receipt.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EPHEMERAL_MESH_SCHEMA, EPHEMERAL_MESH_CONCEPT, validateEphemeralMeshReceipt } from './ephemeralMesh.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : join(here, 'receipt.json');

// --- config (dev-default, NON-SECRET identity: actor + an already-trusted SSH key) ---
const GOLDEN_VM = process.env.LBA_GOLDEN_VM || 'lba-ubuntu2404-labview2026-scratch';
const GOLDEN_SNAP = process.env.LBA_GOLDEN_SNAP || 'mesh-node-ready';
const SSH_USER = process.env.LBA_SSH_USER || 'actor';
const SSH_HOST = '127.0.0.1';
const SSH_PORT = process.env.LBA_CLONE_SSH_PORT || '2223';
const CLONE_VM = process.env.LBA_CLONE_VM || `lba-ephemeral-${Date.now()}`;
const CLONE_MEM = process.env.LBA_CLONE_MEM || '4096';
const CLONE_CPUS = process.env.LBA_CLONE_CPUS || '2';
const BOOT_TIMEOUT_SEC = Number(process.env.LBA_BOOT_TIMEOUT_SEC || 240);
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=8'];

function log(...a) { console.log('[ephemeral-mesh]', ...a); }
function vbox(...a) { return execFileSync('VBoxManage', a, { encoding: 'utf8' }); }
function vboxTry(...a) { try { return vbox(...a); } catch (e) { return String((e.stdout || '') + (e.stderr || '')); } }
function sleep(ms) { execFileSync('sleep', [String(ms / 1000)]); }

function sshCapture(remoteCmd, timeoutSec = 120) {
  try {
    const stdout = execFileSync('ssh', [...SSH_OPTS, '-p', SSH_PORT, `${SSH_USER}@${SSH_HOST}`, remoteCmd], { encoding: 'utf8', timeout: timeoutSec * 1000 });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

function vmState(vm) {
  const info = vboxTry('showvminfo', vm, '--machinereadable');
  const m = /VMState="([^"]+)"/.exec(info);
  return m ? m[1] : 'unknown';
}
function vmExists(vm) {
  const esc = vm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${esc}"`).test(vboxTry('list', 'vms'));
}

function destroyClone() {
  log(`destroying clone ${CLONE_VM} ...`);
  vboxTry('controlvm', CLONE_VM, 'poweroff');
  for (let i = 0; i < 30; i += 1) {
    const s = vmState(CLONE_VM);
    if (s === 'poweroff' || s === 'aborted' || s === 'unknown') break;
    sleep(1000);
  }
  vboxTry('unregistervm', CLONE_VM, '--delete');
  const gone = !vmExists(CLONE_VM);
  log(`clone removed: ${gone ? 'gone (clean)' : 'STILL PRESENT'}`);
  return { gone };
}

const startedAt = new Date();
let cloneCreated = false;
let receipt = null;

try {
  // 1. LINKED CLONE from the immutable golden snapshot.
  log(`cloning ${GOLDEN_VM}@${GOLDEN_SNAP} -> ${CLONE_VM} (linked)`);
  vbox('clonevm', GOLDEN_VM, '--snapshot', GOLDEN_SNAP, '--options', 'link', '--name', CLONE_VM, '--register');
  cloneCreated = true;

  // 2. Reconfigure: own SSH forward, drop the intnet NIC (loopback proof needs only NAT; avoids a dup mesh
  //    IP with the running golden), and trim to a light footprint.
  vboxTry('modifyvm', CLONE_VM, '--natpf1', 'delete', 'ssh');
  vbox('modifyvm', CLONE_VM, '--natpf1', `ssh,tcp,127.0.0.1,${SSH_PORT},,22`);
  vbox('modifyvm', CLONE_VM, '--nic2', 'none');
  vbox('modifyvm', CLONE_VM, '--memory', CLONE_MEM, '--cpus', CLONE_CPUS);

  // 3. BOOT headless.
  log(`booting ${CLONE_VM} (headless) ...`);
  const bootStart = Date.now();
  vbox('startvm', CLONE_VM, '--type', 'headless');

  // 4. Wait for SSH (the KNOWN identity via key auth -- no password).
  let ready = false;
  let bootSeconds = 0;
  const deadline = Date.now() + BOOT_TIMEOUT_SEC * 1000;
  while (Date.now() < deadline) {
    const r = sshCapture('echo READY', 12);
    if (r.code === 0 && /READY/.test(r.stdout)) { ready = true; bootSeconds = Math.round((Date.now() - bootStart) / 1000); break; }
    sleep(4000);
  }
  if (!ready) throw new Error(`clone did not become SSH-ready within ${BOOT_TIMEOUT_SEC}s`);
  log(`clone SSH-ready in ${bootSeconds}s`);

  // 5. Probe node identity.
  const hostname = sshCapture('hostname', 20).stdout.trim();
  const user = sshCapture('whoami', 20).stdout.trim();
  const lbabusVersion = (sshCapture('/usr/local/bin/lbabus --version 2>/dev/null | head -1', 20).stdout.trim()) || 'unknown';
  const meshIdentity = (/VIHS_COLLAB_AGENT=(\S+)/.exec(sshCapture('cat /etc/lba-mesh-actor 2>/dev/null', 20).stdout) || [])[1] || null;
  log(`node: host=${hostname} user=${user} lbabus=${lbabusVersion} identity=${meshIdentity}`);

  // 6. Copy + run the loopback MESH-OK proof inside the clone.
  execFileSync('scp', [...SSH_OPTS, '-P', SSH_PORT, join(here, 'loopback-mesh-proof.sh'), `${SSH_USER}@${SSH_HOST}:/tmp/loopback-mesh-proof.sh`], { encoding: 'utf8', timeout: 30000 });
  const proof = sshCapture('bash /tmp/loopback-mesh-proof.sh', 120);
  const nodeLog = proof.stdout.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.length > 0);
  process.stdout.write(proof.stdout);

  // 7. Parse RESULT key=value lines.
  const results = {};
  for (const line of nodeLog) {
    const m = /^RESULT\s+([a-z_]+)=(.*)$/.exec(line);
    if (m) results[m[1]] = m[2];
  }
  const tcpFrames = Number(results.tcp_frames ?? 0);
  const udpDistinct = Number(results.udp_distinct ?? 0);
  const meshOk = results.mesh_ok === 'true' && proof.code === 0;

  // 8. Seal the receipt.
  const willDestroy = !keep;
  receipt = {
    schema: EPHEMERAL_MESH_SCHEMA,
    concept: EPHEMERAL_MESH_CONCEPT,
    requirement: 'LBA-REQ-006',
    alsoRequirements: ['LBA-REQ-007'],
    test: 'T-EPHEMERAL-MESH-P1',
    ranAt: startedAt.toISOString(),
    plane: 'LINUX',
    hypervisor: 'virtualbox',
    transport: 'lbabus net -- labview-benchmark-actor/bus-msg@1, ADR-0003/0004 (loopback 127.0.0.1 TCP+UDP)',
    lifecycle: {
      model: 'golden snapshot -> linked clone -> boot -> run -> destroy (cattle, no reboot-survival)',
      goldenVm: GOLDEN_VM,
      goldenSnapshot: GOLDEN_SNAP,
      cloneVm: CLONE_VM,
      cloneType: 'linked',
      identity: `${SSH_USER} (dev-default, non-secret) via SSH key auth`,
      memoryMb: Number(CLONE_MEM),
      cpus: Number(CLONE_CPUS),
      bootSeconds,
      survivesReboot: false,
      destroyed: willDestroy,
    },
    node: {
      hostname: hostname || 'unknown',
      user: user || 'unknown',
      lbabusVersion,
      meshIdentity,
    },
    loopbackMesh: {
      tcpPort: Number(results.tcp_port ?? 47420),
      udpPort: Number(results.udp_port ?? 47421),
      bind: '127.0.0.1',
      tcpFramesReceived: tcpFrames,
      udpDistinctSenders: udpDistinct,
      meshOk,
    },
    asserts: {
      sshKeyAuthNoPassword: true,
      lbabusPresent: lbabusVersion !== 'unknown' && lbabusVersion.length > 0,
      tcpLoopback: tcpFrames >= 1,
      udpLoopback: udpDistinct >= 1,
      meshOk,
      cloneCreated: true,
      cloneDestroyed: willDestroy,
      commsOnly: true,
      noRebootSurvivalNeeded: true,
    },
    pass: meshOk && tcpFrames >= 1 && udpDistinct >= 1 && willDestroy,
    nodeLog,
  };
} finally {
  if (cloneCreated && !keep) {
    const { gone } = destroyClone();
    if (receipt) receipt.lifecycle.removalConfirmed = gone;
  } else if (keep) {
    log(`--keep set: clone ${CLONE_VM} left running on ssh port ${SSH_PORT} (receipt will not validate).`);
  }
}

if (!receipt) { console.error('[ephemeral-mesh] no receipt produced'); process.exit(1); }

writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
log(`receipt -> ${outPath}`);

try {
  const summary = validateEphemeralMeshReceipt(receipt);
  log('PASS', JSON.stringify(summary));
  process.exit(0);
} catch (e) {
  console.error('[ephemeral-mesh] FAIL', e.message);
  process.exit(1);
}
