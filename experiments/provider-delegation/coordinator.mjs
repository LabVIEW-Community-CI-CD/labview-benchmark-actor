#!/usr/bin/env node
// Host COORDINATOR: dispatch an uplift/doc task to a cleanroom WORKER over the bus and collect the result.
//
// Starts an observer (bus-msg@1 listener) for the worker's ACK + DONE, sends a CLAIM frame carrying the
// dispatch `{ taskSpec, replyTo }` to the worker's listener, and resolves when the worker returns its DONE
// receipt (or the timeout fires). `replyTo` is the address the WORKER uses to reach this coordinator's
// observer (e.g. the NAT gateway 10.0.2.2 for a VirtualBox guest). Wire-compatible with `lbabus net`.

import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeFrame, createFrameDecoder, makeEnvelope } from './busFrame.mjs';

export function dispatchClaim({ worker, taskSpec, replyHost = '127.0.0.1', observePort = 7420, observeHost = '0.0.0.0', sessionId = 'uplift', timeoutMs = 180000 }) {
  return new Promise((resolve) => {
    const [wHost, wPort] = String(worker).split(':');
    const events = { ack: null, done: null, error: null };
    let settled = false;
    const observer = net.createServer((sock) => {
      const decode = createFrameDecoder((env) => {
        if (env.type === 'ACK') events.ack = env;
        if (env.type === 'DONE') { let r = null; try { r = JSON.parse(env.payload); } catch { r = {}; } events.done = r || {}; finish(); }
      }, () => sock.destroy());
      sock.on('data', decode);
      sock.on('error', () => {});
    });
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); observer.close(); resolve(events); };
    const timer = setTimeout(finish, timeoutMs);
    observer.listen(observePort, observeHost, () => {
      const actualPort = observer.address().port;
      const dispatch = { taskSpec, replyTo: `${replyHost}:${actualPort}` };
      const frame = encodeFrame(makeEnvelope({ senderId: 'host-coordinator', sessionId, type: 'CLAIM', task: `uplift:${taskSpec.domain}`, payload: JSON.stringify(dispatch) }));
      console.error(`[coordinator] CLAIM uplift:${taskSpec.domain} id=${taskSpec.id} -> worker ${wHost}:${wPort} (reply ${replyHost}:${actualPort})`);
      const c = net.connect(Number(wPort), wHost, () => c.write(frame, () => c.end()));
      c.on('error', (e) => { events.error = e.message; });
    });
  });
}

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
  if (!a.worker || !a.task) {
    console.error('usage: node coordinator.mjs --worker <host:port> --task <task.json> [--reply <host-reachable-by-worker>] [--observe <port>]');
    process.exit(2);
  }
  const taskSpec = JSON.parse(fs.readFileSync(a.task, 'utf8'));
  const ev = await dispatchClaim({ worker: a.worker, taskSpec, replyHost: a.reply || '127.0.0.1', observePort: Number(a.observe || 7420) });
  const verdict = ev.done ? ev.done.verdict : 'NONE';
  console.log(`[coordinator] worker=${a.worker} task=${taskSpec.id} claimed=${ev.ack ? 'yes' : 'no'} verdict=${verdict}${ev.error ? ` error=${ev.error}` : ''}`);
  process.exit(ev.done && ev.done.verdict === 'pass' ? 0 : 1);
}
