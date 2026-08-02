// actorLoad.mjs -- a single mesh ACTOR's synthetic CPU load, pinned to a disjoint core pool by the caller
// (taskset -c). Spawns <busyCount> worker_threads, each running a tight busy loop for <durationMs>, so the
// actor's OWN /proc/<pid>/stat CPU time reflects its commanded stress rung while all actors run concurrently.
// busyCount 0 = idle (the process just waits out the window). Node builtins only.
//   usage: node actorLoad.mjs <busyCount> <durationMs>

import { Worker, isMainThread, workerData } from 'node:worker_threads';

if (!isMainThread) {
  // a CPU-bound loop; the accumulator is conditionally observed at the end so V8 cannot eliminate it as dead
  const end = Date.now() + ((workerData && workerData.durationMs) || 0);
  let x = 0;
  while (Date.now() < end) {
    for (let i = 0; i < 2_000_000; i += 1) x += Math.sqrt(i) | 0;
  }
  if (x < 0) process.stdout.write(String(x)); // sink: keeps the loop live (never taken)
  // the worker returns here naturally; do NOT process.exit (that would kill sibling workers/the process)
} else {
  const busyCount = Math.max(0, Number.parseInt(process.argv[2] || '0', 10) || 0);
  const durationMs = Math.max(0, Number.parseInt(process.argv[3] || '0', 10) || 0);
  const workers = [];
  for (let i = 0; i < busyCount; i += 1) {
    workers.push(new Worker(new URL(import.meta.url), { workerData: { durationMs } }));
  }
  // stay alive for the whole capture window even when idle (no workers), then exit
  setTimeout(() => {
    for (const w of workers) { try { w.terminate(); } catch { /* already done */ } }
    process.exit(0);
  }, durationMs + 300);
}
