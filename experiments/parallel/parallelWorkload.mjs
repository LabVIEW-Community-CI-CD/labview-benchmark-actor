#!/usr/bin/env node
// Distributed parallel-workload core (LBA-REQ-040, ADR-0028): split an independent-task workload across
// N instances (this host + a codespace / VM worker), run the shards CONCURRENTLY, and prove disjoint real
// work was done in parallel. A step toward the North Star distributed benchmark mesh (docs/roadmap.md):
// on-demand distributed runs across planes, no central aggregation.
//
// This module is the PURE, deterministic core (partition + receipt build/validate) — no I/O, no network —
// so the `parallel-workload-two-instances` gate replays a committed real receipt offline in CI. The live
// cross-instance dispatch lives in runParallel.mjs.

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/parallel-workload@1';

// FNV-1a 32-bit — a stable, dependency-free hash so the shard assignment is reproducible on any machine.
// Static capacity weights by instance TYPE (operator directive): the host is the fastest worker, a local VM
// is medium, a codespace is the slowest. The proportional split gives faster instances more tasks. Override
// per type here as the fleet's real relative speed is learned (that is a fine future refinement).
export const INSTANCE_TYPE_WEIGHTS = { host: 3, vm: 2, codespace: 1 };
export function weightForType(type) { return INSTANCE_TYPE_WEIGHTS[type] ?? 1; }

// Capacity-weighted, deterministic partition across N instances: split the sorted task list proportionally
// to each instance's weight (largest-remainder apportionment, tie-broken by instance order), then slice
// sequentially in instance order. Deterministic given (tasks, instances) so a committed receipt re-derives
// the same shards from the recorded per-instance weights.
export function capacityWeightedPartition(taskIds, instances) {
  const sorted = [...taskIds].sort();
  const N = sorted.length;
  const weights = instances.map((x) => (x.weight > 0 ? x.weight : 1));
  const totalW = weights.reduce((a, b) => a + b, 0) || 1;
  const ideal = weights.map((w) => (N * w) / totalW);
  const counts = ideal.map((v) => Math.floor(v));
  const remainder = N - counts.reduce((a, b) => a + b, 0);
  const order = instances.map((_, i) => i).sort((a, b) => (ideal[b] - Math.floor(ideal[b])) - (ideal[a] - Math.floor(ideal[a])) || a - b);
  for (let k = 0; k < remainder; k++) counts[order[k % order.length]] += 1;
  const shards = [];
  let pos = 0;
  for (let i = 0; i < instances.length; i++) { shards.push(sorted.slice(pos, pos + counts[i])); pos += counts[i]; }
  return shards;
}

// Build a distributed-workload receipt from the canonical task list + each instance's execution result.
export function buildReceipt({ workload, tasks, shards }) {
  const sortedTasks = [...tasks].sort();
  return {
    schema: RECEIPT_SCHEMA,
    workload,
    instanceCount: shards.length,
    totalTasks: sortedTasks.length,
    tasks: sortedTasks,
    shards: shards.map((s, i) => ({
      shard: i,
      instance: s.instance,   // logical id: host | codespace:<name> | vm:<id>
      type: s.type,           // host | codespace | vm
      hostname: s.hostname,
      weight: s.weight,
      searchTool: s.searchTool,
      tasks: [...s.tasks].sort(),
      passed: s.passed,
      total: s.tasks.length,
      wallMs: s.wallMs,
    })),
    allPassed: shards.every((s) => s.passed === s.tasks.length),
  };
}

// Validate a committed receipt deterministically for N instances: the capacity-weighted partition re-derived
// from the RECORDED per-instance weights reproduces the committed shards; the shards are DISJOINT and COVER
// every task; the instances are distinct; every instance searched with ripgrep; and every task passed.
// Fail-closed on any violation. Volatile facts (wallMs) are not validated. Works for any instanceCount >= 2.
export function validateReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) return { ok: false, findings: [`schema must be ${RECEIPT_SCHEMA}`] };
  const { tasks = [], shards = [] } = receipt;
  if (!Array.isArray(tasks) || tasks.length === 0) findings.push('no tasks');
  if (!Array.isArray(shards) || shards.length < 2) findings.push('a distributed workload needs >= 2 instances');
  if (receipt.instanceCount !== shards.length) findings.push(`instanceCount ${receipt.instanceCount} != shards ${shards.length}`);

  // (a) the capacity-weighted partition from the recorded weights reproduces the committed shard task-sets
  const expected = capacityWeightedPartition(tasks, shards.map((s) => ({ weight: s.weight })));
  for (let i = 0; i < shards.length; i++) {
    const got = [...(shards[i].tasks || [])].sort().join('|');
    const exp = [...(expected[i] || [])].sort().join('|');
    if (got !== exp) findings.push(`instance ${i} tasks do not match the capacity-weighted split for its weight`);
  }
  // (b) disjoint + full coverage
  const union = new Set();
  let overlap = false;
  for (const s of shards) for (const t of (s.tasks || [])) { if (union.has(t)) overlap = true; union.add(t); }
  if (overlap) findings.push('shards overlap (not disjoint)');
  if (union.size !== new Set(tasks).size) findings.push('shards do not cover every task');
  // (c) distinct instances, ripgrep-only, all passed
  const hosts = new Set(shards.map((s) => s.hostname));
  if (hosts.size < shards.length) findings.push('shards did not run on distinct instances (hostnames not unique)');
  for (const s of shards) {
    if (s.searchTool !== 'ripgrep') findings.push(`instance ${s.instance} search tool is ${s.searchTool}, not ripgrep`);
    if (s.passed !== s.total) findings.push(`instance ${s.instance} had failures (${s.passed}/${s.total})`);
  }
  if (receipt.allPassed !== true) findings.push('allPassed is not true');

  return { ok: findings.length === 0, findings, instances: [...hosts], tasks: union.size };
}
