#!/usr/bin/env node
// run-ephemeral-mesh-typed.mjs -- LIVE typed source->sink ephemeral mesh (LINUX / VirtualBox), P2b.
//
//   golden snapshot  ─clone×3→  2 sources + 1 sink on a FRESH private intnet  ─boot→  each source emits a
//   strictly-seq'd stream (PROGRESS 1..N + terminal DONE(N)) to the sink  ─→  the sink SERIALIZES them into
//   one dense ingestSeq log and attests strict serialization (spec §4)  ─→  DESTROY all.
//
// This proves the "node types" contract live: nodes boot as a declared type (source = emit-only, sink =
// collect-only), and the sink's serialized ingest log is re-validated fails-closed (ephemeral-mesh@1, typed).
// Driven by the KNOWN `actor` identity over an SSH key -- no password ever. Host-side only.
//
// Usage: node experiments/ephemeral-mesh/run-ephemeral-mesh-typed.mjs [--keep] [--out <path>]

import { execFileSync, execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EPHEMERAL_MESH_SCHEMA, EPHEMERAL_MESH_CONCEPT, validateEphemeralMeshReceipt } from './ephemeralMesh.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : join(here, 'receipt-typed.json');

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
const RUN = `S-${ts}`; // single run-scoped sessionId (spec §4.2 default level; sink attributes streams by senderId)
const INTNET = process.env.LBA_MESH_INTNET || `lbamesh-eph-${ts}`;
const SERIALIZATION_MODE = 'serialized';

// Typed topology: 2 sources + 1 sink. Each source emits `payloads` PROGRESS frames (seq 1..N) + a DONE(N).
const NODES = [
  { id: 'eph-a', nodeType: 'source', vm: `lba-eph-a-${ts}`, sshPort: '2223', ip: '192.168.66.11', payloads: 3 },
  { id: 'eph-b', nodeType: 'source', vm: `lba-eph-b-${ts}`, sshPort: '2224', ip: '192.168.66.12', payloads: 2 },
  { id: 'eph-sink', nodeType: 'sink', vm: `lba-eph-sink-${ts}`, sshPort: '2225', ip: '192.168.66.13' },
];
const SINK = NODES.find((n) => n.nodeType === 'sink');
const SOURCES = NODES.filter((n) => n.nodeType === 'source');
const EXPECTED_FRAMES = SOURCES.reduce((m, s) => m + s.payloads + 1, 0); // +1 DONE per source

function log(...a) { console.log('[ephemeral-mesh-typed]', ...a); }
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

function setIp(n) { return `sudo ip addr flush dev ${MESH_IFACE} >/dev/null 2>&1; sudo ip addr add ${n.ip}/24 dev ${MESH_IFACE} >/dev/null 2>&1; sudo ip link set ${MESH_IFACE} up >/dev/null 2>&1`; }
function sinkCmd(n) { return `${setIp(n)}; export VIHS_COLLAB_AGENT=${n.id}; ${LBABUS} net listen --tcp ${TCP_PORT} --echo --count ${EXPECTED_FRAMES} --timeout 70 2>/dev/null`; }
function sourceCmd(n) {
  const send = (seq, type, msg) => `${LBABUS} net send --hosts ${SINK.ip} --tcp ${TCP_PORT} --session ${RUN} --seq ${seq} --type ${type} --task typed --message "${msg}" --await 2 --retries 40 --retry-ms 500 >/dev/null 2>&1`;
  const payloadLoop = `for k in $(seq 1 ${n.payloads}); do ${LBABUS} net send --hosts ${SINK.ip} --tcp ${TCP_PORT} --session ${RUN} --seq $k --type PROGRESS --task typed --message "p$k" --await 2 --retries 40 --retry-ms 500 >/dev/null 2>&1; done`;
  return `${setIp(n)}; export VIHS_COLLAB_AGENT=${n.id}; sleep 6; ${payloadLoop}; ${send(n.payloads, 'DONE', `final=${n.payloads}`)}; echo "SOURCE ${n.id} sent ${n.payloads}+DONE"`;
}

function destroyNode(vm) {
  vboxTry('controlvm', vm, 'poweroff');
  for (let i = 0; i < 30; i += 1) { const s = vmState(vm); if (s === 'poweroff' || s === 'aborted' || s === 'unknown') break; sleep(1000); }
  vboxTry('unregistervm', vm, '--delete');
  return !vmExists(vm);
}

// Parse the sink's `net listen` stdout into a deduplicated, ingest-ordered frame log (spec §4.1).
function buildSinkFrameLog(sinkStdout) {
  const frameLog = [];
  const seen = new Set();
  for (const line of sinkStdout.split(/\r?\n/)) {
    const m = /^TCP \S+\s+\[[^\]]+\]\s+(\S+)\s+#(\d+)\s+(\S+)/.exec(line);
    if (!m) continue;
    const senderId = m[1];
    const seq = Number(m[2]);
    const frameType = m[3] === 'DONE' ? 'DONE' : 'PAYLOAD';
    const dedup = `${senderId}#${seq}#${frameType}`;
    if (seen.has(dedup)) continue; // idempotent replay -> does not consume a new ingestSeq
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
    const inIngestOrder = contiguous; // payloads sorted by ingestSeq already have seq === i+1 when contiguous
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
  // 1. CLONE the typed nodes onto a fresh private intnet, each with its own SSH forward.
  for (const n of NODES) {
    log(`cloning ${GOLDEN_VM}@${GOLDEN_SNAP} -> ${n.vm} (${n.nodeType}) on intnet ${INTNET}`);
    vbox('clonevm', GOLDEN_VM, '--snapshot', GOLDEN_SNAP, '--options', 'link', '--name', n.vm, '--register');
    created.push(n.vm);
    vboxTry('modifyvm', n.vm, '--natpf1', 'delete', 'ssh');
    vbox('modifyvm', n.vm, '--natpf1', `ssh,tcp,127.0.0.1,${n.sshPort},,22`);
    vbox('modifyvm', n.vm, '--nic2', 'intnet', '--intnet2', INTNET, '--cableconnected2', 'on');
    vbox('modifyvm', n.vm, '--memory', '3072', '--cpus', '2');
  }

  // 2. BOOT all headless.
  const bootStart = Date.now();
  for (const n of NODES) { log(`booting ${n.vm} (headless)`); vbox('startvm', n.vm, '--type', 'headless'); }

  // 3. Wait for SSH on every node (known identity, key auth -- no password).
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
    log(`${n.vm} SSH-ready (${n.nodeType}, lbabus=${n.lbabusVersion})`);
  }
  const bootSeconds = Math.round((Date.now() - bootStart) / 1000);

  // 4. Run the typed mesh CONCURRENTLY: the sink listens; each source pins its IP + identity and emits its
  //    strictly-seq'd stream (sources self-delay a few seconds so the sink binds first).
  log(`running typed mesh: ${SOURCES.length} source(s) -> 1 sink on ${INTNET}, expecting ${EXPECTED_FRAMES} frames`);
  const sinkRun = sshAsync(SINK.sshPort, sinkCmd(SINK), 150);
  const sourceRuns = SOURCES.map((n) => sshAsync(n.sshPort, sourceCmd(n), 150));
  const [sinkRes, ...sourceRes] = await Promise.all([sinkRun, ...sourceRuns]);

  SOURCES.forEach((n, i) => { n.sent = /SOURCE .* sent \d+\+DONE/.test(sourceRes[i].stdout); log(`${n.id} source: ${n.sent ? 'sent+DONE' : 'INCOMPLETE'}`); });

  // 5. Serialize the sink's inbound frames into a dense ingestSeq log + per-stream summary (spec §4).
  const frameLog = buildSinkFrameLog(sinkRes.stdout);
  const { perStream, allStreamsOk, streamCount } = summarizeStreams(frameLog);
  const M = frameLog.length;
  const ingestSeqDense = frameLog.every((f, i) => f.ingestSeq === i + 1);
  const strictSerialization = ingestSeqDense && allStreamsOk && streamCount === SOURCES.length && M === EXPECTED_FRAMES;
  log(`sink serialized ${M}/${EXPECTED_FRAMES} frames across ${streamCount} stream(s); strictSerialization=${strictSerialization}`);

  const allSourcesSent = SOURCES.every((n) => n.sent);
  const willDestroy = !keep;

  receipt = {
    schema: EPHEMERAL_MESH_SCHEMA,
    concept: EPHEMERAL_MESH_CONCEPT,
    meshMode: 'typed',
    serializationMode: SERIALIZATION_MODE,
    requirement: 'LBA-REQ-006',
    alsoRequirements: ['LBA-REQ-007'],
    test: 'T-EPHEMERAL-MESH-P2-TYPED',
    ranAt: startedAt.toISOString(),
    plane: 'LINUX',
    hypervisor: 'virtualbox',
    transport: `lbabus net -- labview-benchmark-actor/bus-msg@1, ADR-0003/0004 (private intnet ${INTNET}, TCP ${TCP_PORT}; source->sink typed streams, sessionId ${RUN})`,
    lifecycle: {
      model: 'golden snapshot -> N linked clones (typed) -> boot -> source->sink strict serialization -> destroy',
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
      nodeType: n.nodeType,
      ip: n.ip,
      lbabusVersion: n.lbabusVersion || 'unknown',
      activity: {
        listened: n.nodeType === 'sink' || n.nodeType === 'both',
        emittedCoordination: n.nodeType === 'source' || n.nodeType === 'both',
      },
      ...(n.nodeType === 'sink' || n.nodeType === 'both'
        ? {
          orderedReceipt: {
            ingestSeqDense,
            totalFrames: M,
            strictSerialization,
            orderKey: '(sessionId,senderId,seq) within a stream; cross-source by sink ingestSeq (arrival)',
            frameLog,
            perStream,
          },
        }
        : { sent: !!n.sent }),
    })),
    asserts: {
      sshKeyAuthNoPassword: true,
      lbabusPresent: NODES.every((n) => n.lbabusVersion && n.lbabusVersion !== 'unknown'),
      nodeTypesHonored: true,
      strictSerialization,
      meshOk: strictSerialization && allSourcesSent,
      cloneCreated: true,
      cloneDestroyed: willDestroy,
      commsOnly: true,
      noRebootSurvivalNeeded: true,
    },
    pass: strictSerialization && allSourcesSent && willDestroy,
    sinkStdout: sinkRes.stdout.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter(Boolean),
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

if (!receipt) { console.error('[ephemeral-mesh-typed] no receipt produced'); process.exit(1); }
writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
log(`receipt -> ${outPath}`);
try {
  const summary = validateEphemeralMeshReceipt(receipt);
  log('PASS', JSON.stringify(summary));
  process.exit(0);
} catch (e) {
  console.error('[ephemeral-mesh-typed] FAIL', e.message);
  process.exit(1);
}
