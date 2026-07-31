#!/usr/bin/env node
// Bus-side WORKER POOL: a persistent cleanroom actor that CLAIMS delegated uplift/doc tasks off the lbabus
// bus and runs them, bounding concurrency to `--concurrency N` (excess claims queue FIFO and drain as slots
// free). One process, N in-flight delegations -- the provider calls are I/O-bound (HTTP to Ollama), so N
// async slots is the pool. Stays up across many claims; `server.poolStats()` exposes accepted/done/peak.
//
// It listens for a CLAIM frame (bus-msg@1 / ADR-0003), parses the dispatch `{ taskSpec, replyTo }` from the
// payload, ACKs the claim back to the coordinator's observer, runs the provider delegation LOCALLY (reusing
// the proven runDelegation), and announces the DONE receipt to that observer (reusing announceOverBus). The
// provider runs on/near the VM; only the ACK + the small receipt cross the bus (comms-only). Wire-compatible
// with `lbabus net`, so a real lbabus could send the CLAIM or observe the DONE.

import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeFrame, createFrameDecoder, makeEnvelope, sendFrame } from './busFrame.mjs';
import { runDelegation, announceOverBus, RECEIPT_SCHEMA } from './delegateUplift.mjs';
import { detectTool } from './riskyTest.mjs';
import { probeVipmCapability } from './vipmGate.mjs';

export function startWorker({ port = 7440, host = '0.0.0.0', concurrency = 2, provider = 'ollama', model, drive, actorId = 'cleanroom-worker', caps, capsTools = ['node', 'ffmpeg', 'LabVIEWCLI'], onDone } = {}) {
  const queue = [];
  let running = 0;
  const stats = { accepted: 0, done: 0, failed: 0, peak: 0 };

  // VIPM capability, probed ONCE at startup (or injected synthetically via caps.vipm): { present, edition }.
  // Advertised so the router sends a VIPM task only to a VIPM-capable worker, and a Community-Edition build
  // only to a worker whose edition can build for the target repo's visibility (see registry.editionGate).
  const vipmCap = (caps && caps.vipm) || probeVipmCapability();

  // Capabilities this worker advertises on a HELLO probe: its provider + which of `capsTools` are present on
  // PATH (so a router sends an ffmpeg/LabVIEW risky-test only to a worker that HAS the tool). A `caps` override
  // lets a test inject synthetic capabilities. Live running/queued are attached fresh on each probe.
  const helloCaps = () => ({
    agent: actorId,
    provider,
    concurrency,
    running,
    queued: queue.length,
    tools: (caps && caps.tools) || Object.fromEntries(capsTools.map((t) => [t, detectTool(t).present])),
    vipm: vipmCap,
  });

  // Bounded scheduler: run up to `concurrency` delegations at once; the rest wait FIFO in `queue`.
  const pump = () => {
    while (running < concurrency && queue.length > 0) {
      const job = queue.shift();
      running += 1;
      if (running > stats.peak) stats.peak = running;
      runJob(job).finally(() => { running -= 1; pump(); });
    }
  };

  async function runJob(job) {
    let receipt;
    try { receipt = await runDelegation(job.taskSpec, { provider, model, drive }); }
    catch (e) { receipt = { schema: RECEIPT_SCHEMA, task: { domain: job.taskSpec.domain, id: job.taskSpec.id, provider }, verdict: 'fail', error: e.message }; }
    stats.done += 1;
    if (receipt.verdict !== 'pass') stats.failed += 1;
    const ann = await announceOverBus(receipt, { host: job.replyTo.host, port: job.replyTo.port, senderId: actorId });
    console.error(`[worker] ${actorId} DONE id=${job.taskSpec.id} verdict=${receipt.verdict} announced=${ann.announced} (running=${running - 1}/${concurrency} queued=${queue.length})`);
    if (typeof onDone === 'function') onDone(receipt, ann);
  }

  const server = net.createServer((sock) => {
    const decode = createFrameDecoder(async (env) => {
      // Liveness + capability probe: a router sends HELLO, the worker replies READY with its caps.
      if (env.type === 'HELLO') {
        try { sock.write(encodeFrame(makeEnvelope({ senderId: actorId, type: 'READY', task: 'caps', payload: JSON.stringify(helloCaps()), ackOf: env.seq ?? null }))); } catch { /* best-effort */ }
        return;
      }
      if (env.type !== 'CLAIM' || !String(env.task || '').startsWith('uplift:')) return;
      let dispatch = null;
      try { dispatch = env.payload ? JSON.parse(env.payload) : null; } catch { dispatch = null; }
      const taskSpec = dispatch && dispatch.taskSpec;
      const replyTo = dispatch && dispatch.replyTo ? parseHostPort(dispatch.replyTo) : null;
      sock.end();
      if (!taskSpec || !replyTo) { console.error(`[worker] ${actorId} ignoring malformed CLAIM (need payload {taskSpec, replyTo})`); return; }
      stats.accepted += 1;
      queue.push({ taskSpec, replyTo });
      const full = running >= concurrency;
      console.error(`[worker] ${actorId} CLAIMED ${env.task} id=${taskSpec.id} (${full ? 'queued' : 'starting'}; running=${running}/${concurrency} queued=${queue.length})`);
      // ACK the claim to the coordinator observer, reflecting pool state, then schedule it.
      await sendFrame({ host: replyTo.host, port: replyTo.port, envelope: makeEnvelope({ senderId: actorId, type: 'ACK', task: env.task, payload: JSON.stringify({ claimed: true, id: taskSpec.id, running, queued: queue.length, concurrency }), ackOf: env.seq ?? null }) });
      pump();
    }, () => sock.destroy());
    sock.on('data', decode);
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(port, host, () => {
    server.poolStats = () => ({ accepted: stats.accepted, done: stats.done, failed: stats.failed, peak: stats.peak, running, queued: queue.length, concurrency });
    console.error(`[worker] ${actorId} pool listening ${host}:${server.address().port} concurrency=${concurrency} provider=${provider}`);
    resolve(server);
  }));
}

function parseHostPort(s) { const [h, p] = String(s).split(':'); return { host: h, port: Number(p) }; }

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k.startsWith('--')) { const key = k.slice(2); const v = argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[++i] : true; o[key] = v; }
  }
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const a = parseArgs(process.argv.slice(2));
  startWorker({
    port: Number(a.listen || 7440),
    concurrency: Number(a.concurrency || 2),
    provider: a.provider || 'ollama',
    model: a.model,
    actorId: a.actor || process.env.VIHS_COLLAB_AGENT || 'cleanroom-worker',
    onDone: (r) => console.log(`[worker] handled id=${r.task && r.task.id} verdict=${r.verdict}`),
  });
}
