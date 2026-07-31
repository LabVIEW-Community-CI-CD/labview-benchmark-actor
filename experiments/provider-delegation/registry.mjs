#!/usr/bin/env node
// Claim registry / router: discover the LIVE cleanroom workers, learn their CAPABILITIES (provider + tools),
// and route each domain task to a live worker that can run it -- load-balanced round-robin across the eligible
// workers. Reuses the bus HELLO->READY handshake (worker.mjs) + the CLAIM dispatch (coordinator.mjs). A router
// that lets one coordinator drive a POOL of cleanrooms: an ffmpeg/LabVIEW risky-test only goes to a worker that
// HAS the tool; a dead worker is excluded by liveness. Dependency-free.

import net from 'node:net';
import { encodeFrame, createFrameDecoder, makeEnvelope } from './busFrame.mjs';
import { dispatchClaim } from './coordinator.mjs';

// Probe one worker for liveness + capabilities (synchronous HELLO -> READY on the same socket).
export function probeWorker(address, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const [host, port] = String(address).split(':');
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; try { sock.destroy(); } catch { /* ignore */ } resolve(v); } };
    const sock = net.connect(Number(port), host, () => {
      sock.write(encodeFrame(makeEnvelope({ senderId: 'router', type: 'HELLO', task: 'caps' })));
    });
    const decode = createFrameDecoder((env) => {
      if (env.type === 'READY') {
        let capsObj = null;
        try { capsObj = JSON.parse(env.payload); } catch { capsObj = {}; }
        finish({ address, alive: true, caps: capsObj || {} });
      }
    }, () => finish({ address, alive: false }));
    sock.on('data', decode);
    sock.on('error', () => finish({ address, alive: false }));
    sock.setTimeout(timeoutMs, () => finish({ address, alive: false }));
  });
}

// Discover the live workers among `addresses` (dead / unreachable ones are dropped).
export async function discover(addresses, opts = {}) {
  const probed = await Promise.all(addresses.map((a) => probeWorker(a, opts)));
  return probed.filter((p) => p.alive);
}

// What a task requires of a worker: a risky-test needs its tool; a task may pin a provider.
export function requiredCapabilities(task) {
  if (task.domain === 'risky-test' && task.tool) return { tool: task.tool };
  if (task.requireProvider) return { provider: task.requireProvider };
  return {};
}

export function capable(worker, task) {
  const req = requiredCapabilities(task);
  const caps = (worker && worker.caps) || {};
  if (req.tool && !(caps.tools && caps.tools[req.tool])) return false;
  if (req.provider && caps.provider !== req.provider) return false;
  return true;
}

// Route: pick a live + capable worker, least-loaded (by advertised `running`) with a round-robin tiebreak.
export function route(registry, task, cursor = { i: 0 }) {
  const eligible = registry.filter((w) => capable(w, task));
  if (eligible.length === 0) return null;
  const minRunning = Math.min(...eligible.map((w) => (w.caps.running || 0)));
  const leastLoaded = eligible.filter((w) => (w.caps.running || 0) === minRunning);
  const pick = leastLoaded[cursor.i % leastLoaded.length];
  cursor.i += 1;
  return pick;
}

// Discover + route + dispatch a batch of tasks across the worker pool. Returns the registry snapshot + a
// per-task result { task, routedTo, verdict }. Unroutable tasks (no capable live worker) are reported, not thrown.
export async function dispatchAcrossPool(addresses, tasks, opts = {}) {
  const registry = await discover(addresses, opts);
  const cursor = { i: 0 };
  const results = [];
  for (const task of tasks) {
    const worker = route(registry, task, cursor);
    if (!worker) { results.push({ task: task.id, routedTo: null, verdict: 'unroutable' }); continue; }
    // eslint-disable-next-line no-await-in-loop -- sequential dispatch keeps the demo receipt stable + gentle on the pool.
    const ev = await dispatchClaim({ worker: worker.address, taskSpec: task, replyHost: opts.replyHost || '127.0.0.1', observePort: 0, timeoutMs: opts.timeoutMs || 60000 });
    results.push({ task: task.id, routedTo: worker.caps.agent || worker.address, verdict: ev.done ? ev.done.verdict : 'none' });
  }
  return { registry: registry.map((w) => ({ address: w.address, agent: w.caps.agent, provider: w.caps.provider, tools: w.caps.tools })), results };
}
