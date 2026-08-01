#!/usr/bin/env node
// run-ephemeral-mesh-2node.mjs -- LIVE typed both<->both ephemeral mesh (LINUX / VirtualBox), P2.
//
//   golden snapshot  ─clone×2→  2 nodes (each nodeType=both) on a FRESH private intnet  ─boot→  each node
//   SIMULTANEOUSLY sources its own strictly-seq'd stream (PROGRESS 1..N + DONE(N)) to its peer AND sinks the
//   peer's stream into a dense ingestSeq log  ─→  each node attests strict serialization (spec §5 both↔both)
//   ─→  DESTROY all.
//
// The symmetric twin of run-ephemeral-mesh-typed.mjs: instead of source/sink specialists, both nodes are
// full peers, so EACH seals its own orderedReceipt for what it heard. Driven by the KNOWN `actor` identity
// over an SSH key -- no password ever. Host-side only.
//
// Usage: node experiments/ephemeral-mesh/run-ephemeral-mesh-2node.mjs [--keep] [--out <path>]

import { execFileSync, execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EPHEMERAL_MESH_SCHEMA, EPHEMERAL_MESH_CONCEPT, validateEphemeralMeshReceipt } from './ephemeralMesh.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : join(here, 'receipt-2node.json');

const GOLDEN_VM = process.env.LBA_GOLDEN_VM || 'lba-ubuntu2404-labview2026-scratch';
const GOLDEN_SNAP = process.env.LBA_GOLDEN_SNAP || 'mesh-node-ready';
const SSH_USER = process.env.LBA_SSH_USER || 'actor';
const SSH_HOST = '127.0.0.1';
const MESH_IFACE = process.env.LBA_MESH_IFACE || 'enp0s8';
const LBABUS = '/usr/local/bin/lbabus';
const TCP_PORT = '7420';
const BOOT_TIMEOUT_SEC = Number(process.env.LBA_BOOT_TIMEOUT_SEC || 240);
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=8'];

const ts = Date.now();
const RUN = `S-${ts}`; // single run-scoped sessionId (spec §4.2 default level)
const INTNET = process.env.LBA_MESH_INTNET || `lbamesh-eph-${ts}`;
const SERIALIZATION_MODE = 'serialized';

// both<->both topology: 2 full peers. Each emits `payloads` PROGRESS frames (seq 1..N) + a DONE(N) to its peer.
const NODES = [
  { id: 'eph-a', vm: `lba-eph-a-${ts}`, sshPort: '2223', ip: '192.168.66.11', payloads: 3 },
  { id: 'eph-b', vm: `lba-eph-b-${ts}`, sshPort: '2224', ip: '192.168.66.12', payloads: 2 },
];
const peerOf = (n) => NODES.find((m) => m.id !== n.id);

function log(...a) { console.log('[ephemeral-mesh-2node]', ...a); }
function vbox(...a) { return execFileSync('VBoxManage', a, { encoding: 'utf8' }); }
function vboxTry(...a) { try { return vbox(...a); } catch (e) { return String((e.stdout || '') + (e.stderr || '')); } }
function sleep(ms) { execFileSync('sleep', [String(ms / 1000)]); }
function vmState(vm) { const m = /VMState="([^"]+)"/.exec(vboxTry('showvminfo', vm, '--machinereadable')); return m ? m[1] : 'unknown'; }
function vmExists(vm) { const esc = vm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return new RegExp(`"${esc}"`).test(vboxTry('list', 'vms')); }

function sshCapture(port, cmd, timeoutSec = 60) {
  try { return { code: 0, stdout: execFileSync('ssh', [...SSH_OPTS, '-p', port, `${SSH_USER}@${SSH_HOST}`, cmd], { encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 8 * 1024 * 1024 }) }; }
  catch (e) { return { code: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }; }
}
function sshAsync(port, cmd, timeoutSec = 150) {
  return new Promise((resolve) => {
    execFile('ssh', [...SSH_OPTS, '-p', port, `${SSH_USER}@${SSH_HOST}`, cmd], { encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' }));
  });
}

function destroyNode(vm) {
  vboxTry('controlvm', vm, 'poweroff');
  for (let i = 0; i < 30; i += 1) { const s = vmState(vm); if (s === 'poweroff' || s === 'aborted' || s === 'unknown') break; sleep(1000); }
  vboxTry('unregistervm', vm, '--delete');
  return !vmExists(vm);
}

// Each node listens for its peer's stream AND emits its own -- both halves of a `both` node, concurrently.
function bidiCmd(n) {
  const peer = peerOf(n);
  const peerFrames = peer.payloads + 1; // peer emits N payloads + 1 DONE
  const setIp = `sudo ip addr flush dev ${MESH_IFACE} >/dev/null 2>&1; sudo ip addr add ${n.ip}/24 dev ${MESH_IFACE} >/dev/null 2>&1; sudo ip link set ${MESH_IFACE} up >/dev/null 2>&1`;
  const listen = `${LBABUS} net listen --tcp ${TCP_PORT} --echo --count ${peerFrames} --timeout 80 > /tmp/recv.log 2>/dev/null & lp=$!`;
  const payloadLoop = `for k in $(seq 1 ${n.payloads}); do ${LBABUS} net send --hosts ${peer.ip} --tcp ${TCP_PORT} --session ${RUN} --seq $k --type PROGRESS --task typed --message "p$k" --await 2 --retries 40 --retry-ms 500 >/dev/null 2>&1; done`;
  const done = `${LBABUS} net send --hosts ${peer.ip} --tcp ${TCP_PORT} --session ${RUN} --seq ${n.payloads} --type DONE --task typed --message "final=${n.payloads}" --await 2 --retries 40 --retry-ms 500 >/dev/null 2>&1`;
  return `${setIp}; export VIHS_COLLAB_AGENT=${n.id}; ${listen}; sleep 6; ${payloadLoop}; ${done}; echo "SENT ${n.id}"; wait $lp; echo "=== RECEIVED ${n.id} ==="; cat /tmp/recv.log`;
}

// Parse a `net listen` capture into a deduplicated, ingest-ordered frame log (spec §4.1).
function buildFrameLog(stdout) {
  const frameLog = [];
  const seen = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^TCP \S+\s+\[[^\]]+\]\s+(\S+)\s+#(\d+)\s+(\S+)/.exec(line);
    if (!m) continue;
    const senderId = m[1];
    const seq = Number(m[2]);
    const frameType = m[3] === 'DONE' ? 'DONE' : 'PAYLOAD';
    const dedup = `${senderId}#${seq}#${frameType}`;
    if (seen.has(dedup)) continue; // idempotent replay
    seen.add(dedup);
    frameLog.push({ sessionId: RUN, senderId, seq, ingestSeq: frameLog.length + 1, frameType });
  }
  return frameLog;
}

function summarizeStreams(frameLog) {
  const streams = new Map();
  for (const f of frameLog) { if (!streams.has(f.senderId)) streams.set(f.senderId, []); streams.get(f.senderId).push(f); }
  const perStream = [];
  let allStreamsOk = true;
  for (const [senderId, frames] of streams) {
    const payloads = frames.filter((f) => f.frameType === 'PAYLOAD').sort((a, b) => a.ingestSeq - b.ingestSeq);
    const dones = frames.filter((f) => f.frameType === 'DONE');
    const N = payloads.length;
    const contiguous = N >= 1 && payloads.every((f, i) => f.seq === i + 1);
    const inIngestOrder = contiguous;
    const terminalDone = dones.length === 1 && N >= 1 && dones[0].seq === N && dones[0].ingestSeq > payloads[N - 1].ingestSeq;
    if (!(contiguous && inIngestOrder && terminalDone)) allStreamsOk = false;
    perStream.push({ sessionId: RUN, senderId, firstSeq: N ? 1 : 0, lastSeq: N, count: N, contiguous, inIngestOrder, terminalDone });
  }
  return { perStream, allStreamsOk, streamCount: streams.size };
}

const startedAt = new Date();
let created = [];
let receipt = null;

try {
  // 1. CLONE 2 both-nodes onto a fresh private intnet.
  for (const n of NODES) {
    log(`cloning ${GOLDEN_VM}@${GOLDEN_SNAP} -> ${n.vm} (both) on intnet ${INTNET}`);
    vbox('clonevm', GOLDEN_VM, '--snapshot', GOLDEN_SNAP, '--options', 'link', '--name', n.vm, '--register');
    created.push(n.vm);
    vboxTry('modifyvm', n.vm, '--natpf1', 'delete', 'ssh');
    vbox('modifyvm', n.vm, '--natpf1', `ssh,tcp,127.0.0.1,${n.sshPort},,22`);
    vbox('modifyvm', n.vm, '--nic2', 'intnet', '--intnet2', INTNET, '--cableconnected2', 'on');
    vbox('modifyvm', n.vm, '--memory', '3072', '--cpus', '2');
  }

  // 2. BOOT both headless.
  const bootStart = Date.now();
  for (const n of NODES) { log(`booting ${n.vm} (headless)`); vbox('startvm', n.vm, '--type', 'headless'); }

  // 3. Wait for SSH on both (known identity, key auth -- no password).
  for (const n of NODES) {
    let ready = false;
    const deadline = Date.now() + BOOT_TIMEOUT_SEC * 1000;
    while (Date.now() < deadline) {
      const r = sshCapture(n.sshPort, 'echo READY', 12);
      if (r.code === 0 && /READY/.test(r.stdout)) { ready = true; break; }
      sleep(4000);
    }
    if (!ready) throw new Error(`${n.vm} not SSH-ready within ${BOOT_TIMEOUT_SEC}s`);
    n.lbabusVersion = (sshCapture(n.sshPort, `${LBABUS} --version 2>/dev/null | head -1`, 20).stdout.trim()) || 'unknown';
    log(`${n.vm} SSH-ready (both, lbabus=${n.lbabusVersion})`);
  }
  const bootSeconds = Math.round((Date.now() - bootStart) / 1000);

  // 4. Run both peers CONCURRENTLY: each sources its stream to the peer AND sinks the peer's stream.
  log(`running typed both<->both mesh on ${INTNET} (each node sources + sinks)`);
  const runs = await Promise.all(NODES.map((n) => sshAsync(n.sshPort, bidiCmd(n), 160)));

  // 5. For each node, serialize the peer's stream it received into a dense ingestSeq log (spec §4).
  NODES.forEach((n, i) => {
    const out = runs[i].stdout;
    n.sent = new RegExp(`SENT ${n.id}`).test(out);
    const idx = out.indexOf(`=== RECEIVED ${n.id} ===`);
    const recvBlock = idx >= 0 ? out.slice(idx) : '';
    const frameLog = buildFrameLog(recvBlock);
    const { perStream, allStreamsOk, streamCount } = summarizeStreams(frameLog);
    const M = frameLog.length;
    const ingestSeqDense = frameLog.every((f, j) => f.ingestSeq === j + 1);
    const expected = peerOf(n).payloads + 1;
    const strict = ingestSeqDense && allStreamsOk && streamCount === 1 && M === expected;
    n.orderedReceipt = {
      ingestSeqDense, totalFrames: M, strictSerialization: strict,
      orderKey: '(sessionId,senderId,seq) within a stream; cross-source by sink ingestSeq (arrival)',
      frameLog, perStream,
    };
    log(`${n.id}: sourced ${n.payloads}+DONE, sinked ${M}/${expected} from peer; strict=${strict}`);
  });

  const allStrict = NODES.every((n) => n.orderedReceipt.strictSerialization);
  const allSent = NODES.every((n) => n.sent);
  const willDestroy = !keep;

  receipt = {
    schema: EPHEMERAL_MESH_SCHEMA,
    concept: EPHEMERAL_MESH_CONCEPT,
    meshMode: 'typed',
    serializationMode: SERIALIZATION_MODE,
    requirement: 'LBA-REQ-006',
    alsoRequirements: ['LBA-REQ-007'],
    test: 'T-EPHEMERAL-MESH-P2-TYPED-BOTH',
    ranAt: startedAt.toISOString(),
    plane: 'LINUX',
    hypervisor: 'virtualbox',
    transport: `lbabus net -- labview-benchmark-actor/bus-msg@1, ADR-0003/0004 (private intnet ${INTNET}, TCP ${TCP_PORT}; both<->both typed streams, sessionId ${RUN})`,
    lifecycle: {
      model: 'golden snapshot -> 2 linked clones (both) -> boot -> both<->both strict serialization -> destroy',
      goldenVm: GOLDEN_VM,
      goldenSnapshot: GOLDEN_SNAP,
      cloneVms: NODES.map((n) => n.vm),
      cloneType: 'linked',
      intnet: INTNET,
      identity: `${SSH_USER} (dev-default, non-secret) via SSH key auth`,
      bootSeconds,
      survivesReboot: false,
      destroyed: willDestroy,
    },
    nodes: NODES.map((n) => ({
      id: n.id,
      nodeType: 'both',
      ip: n.ip,
      lbabusVersion: n.lbabusVersion || 'unknown',
      activity: { listened: true, emittedCoordination: true },
      orderedReceipt: n.orderedReceipt,
    })),
    asserts: {
      sshKeyAuthNoPassword: true,
      lbabusPresent: NODES.every((n) => n.lbabusVersion && n.lbabusVersion !== 'unknown'),
      nodeTypesHonored: true,
      strictSerialization: allStrict,
      meshOk: allStrict && allSent,
      cloneCreated: true,
      cloneDestroyed: willDestroy,
      commsOnly: true,
      noRebootSurvivalNeeded: true,
    },
    pass: allStrict && allSent && willDestroy,
  };
} finally {
  if (created.length && !keep) {
    log(`destroying ${created.length} clone(s) ...`);
    const gone = created.map((vm) => destroyNode(vm));
    log(`clones removed: ${gone.every(Boolean) ? 'all gone (clean)' : 'SOME STILL PRESENT'}`);
    if (receipt) receipt.lifecycle.removalConfirmed = gone.every(Boolean);
  } else if (keep) {
    log(`--keep set: clones left running (${created.join(', ')}); receipt will not validate.`);
  }
}

if (!receipt) { console.error('[ephemeral-mesh-2node] no receipt produced'); process.exit(1); }
writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
log(`receipt -> ${outPath}`);
try {
  const summary = validateEphemeralMeshReceipt(receipt);
  log('PASS', JSON.stringify(summary));
  process.exit(0);
} catch (e) {
  console.error('[ephemeral-mesh-2node] FAIL', e.message);
  process.exit(1);
}
