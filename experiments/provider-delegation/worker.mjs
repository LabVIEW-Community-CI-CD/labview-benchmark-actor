#!/usr/bin/env node
// Bus-side WORKER: a cleanroom actor that CLAIMS delegated uplift/doc tasks off the lbabus bus and runs them.
//
// It listens for a CLAIM frame (bus-msg@1 / ADR-0003), parses the dispatch `{ taskSpec, replyTo }` from the
// payload, ACKs the claim back to the coordinator's observer, runs the provider delegation LOCALLY (reusing
// the proven runDelegation), and announces the DONE receipt to that observer (reusing announceOverBus). The
// provider runs on/near the VM; only the ACK + the small receipt cross the bus (comms-only). Wire-compatible
// with `lbabus net`, so a real lbabus could send the CLAIM or observe the DONE.

import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFrameDecoder, makeEnvelope, sendFrame } from './busFrame.mjs';
import { runDelegation, announceOverBus, RECEIPT_SCHEMA } from './delegateUplift.mjs';

export function startWorker({ port = 7440, host = '0.0.0.0', provider = 'ollama', model, actorId = 'cleanroom-worker', onDone } = {}) {
  const server = net.createServer((sock) => {
    const decode = createFrameDecoder(async (env) => {
      if (env.type !== 'CLAIM' || !String(env.task || '').startsWith('uplift:')) return;
      let dispatch = null;
      try { dispatch = env.payload ? JSON.parse(env.payload) : null; } catch { dispatch = null; }
      const taskSpec = dispatch && dispatch.taskSpec;
      const replyTo = dispatch && dispatch.replyTo ? parseHostPort(dispatch.replyTo) : null;
      sock.end();
      if (!taskSpec || !replyTo) { console.error(`[worker] ${actorId} ignoring malformed CLAIM (need payload {taskSpec, replyTo})`); return; }
      console.error(`[worker] ${actorId} CLAIMED ${env.task} id=${taskSpec.id} -> reply ${replyTo.host}:${replyTo.port}`);
      // 1) ACK the claim to the coordinator observer (immediate "claimed").
      await sendFrame({ host: replyTo.host, port: replyTo.port, envelope: makeEnvelope({ senderId: actorId, type: 'ACK', task: env.task, payload: JSON.stringify({ claimed: true, id: taskSpec.id }), ackOf: env.seq ?? null }) });
      // 2) run the delegation locally, then 3) announce the DONE receipt.
      let receipt;
      try { receipt = await runDelegation(taskSpec, { provider, model }); }
      catch (e) { receipt = { schema: RECEIPT_SCHEMA, task: { domain: taskSpec.domain, id: taskSpec.id, provider }, verdict: 'fail', error: e.message }; }
      const ann = await announceOverBus(receipt, { host: replyTo.host, port: replyTo.port, senderId: actorId });
      console.error(`[worker] ${actorId} DONE id=${taskSpec.id} verdict=${receipt.verdict} announced=${ann.announced}`);
      if (typeof onDone === 'function') onDone(receipt, ann);
    }, () => sock.destroy());
    sock.on('data', decode);
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(port, host, () => {
    console.error(`[worker] ${actorId} listening ${host}:${server.address().port} provider=${provider}`);
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
    provider: a.provider || 'ollama',
    model: a.model,
    actorId: a.actor || process.env.VIHS_COLLAB_AGENT || 'cleanroom-worker',
    onDone: (r) => console.log(`[worker] handled id=${r.task && r.task.id} verdict=${r.verdict}`),
  });
}
