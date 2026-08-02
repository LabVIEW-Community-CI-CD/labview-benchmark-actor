#!/usr/bin/env node
// Capability-aware task routing (LBA-REQ-041, ADR-0029) -- extends the distributed executor (ADR-0028) so a
// heterogeneous fleet runs each task ONLY on an instance that has the capability the task requires. The host
// has LabVIEW (it is the only instance that can run VIs); codespaces are node-only. So a `labview` task is
// routed to a LabVIEW-capable instance and a `node` task can run anywhere -- capacity-weighted within the
// eligible set (reusing the ADR-0028 partition). Pure + deterministic; the gate replays a committed receipt.

import { capacityWeightedPartition } from './parallelWorkload.mjs';

export const ROUTED_SCHEMA = 'labview-benchmark-actor/capability-routed-workload@1';

// tasks:     [{ id, requires: string[] }]           -- a task's required capabilities (empty = runs anywhere)
// instances: [{ id, capabilities: string[], weight }] -- what each instance can do + its capacity weight
// Returns shards aligned to `instances`: each task lands on an eligible instance, capacity-weighted within
// the eligible set. Deterministic (tasks grouped by capability signature, groups + tasks sorted). Throws if a
// task's capability cannot be satisfied by ANY instance (fail-closed on an impossible routing).
export function routeByCapability(tasks, instances) {
  const shards = instances.map(() => []);
  const groups = new Map();
  for (const t of tasks) {
    const req = [...(t.requires || [])].sort();
    const key = req.join('|');
    if (!groups.has(key)) groups.set(key, { req, ids: [] });
    groups.get(key).ids.push(t.id);
  }
  for (const { req, ids } of [...groups.values()].sort((a, b) => a.req.join('|').localeCompare(b.req.join('|')))) {
    const eligibleIdx = instances
      .map((inst, i) => (req.every((c) => (inst.capabilities || []).includes(c)) ? i : -1))
      .filter((i) => i >= 0);
    if (eligibleIdx.length === 0) throw new Error(`no instance satisfies capabilities [${req.join(', ')}] for ${ids.length} task(s)`);
    const sub = capacityWeightedPartition([...ids].sort(), eligibleIdx.map((i) => instances[i]));
    eligibleIdx.forEach((instIdx, k) => { for (const id of sub[k]) shards[instIdx].push(id); });
  }
  return shards;
}

// Build a capability-routed receipt from the instances, the capability-tagged tasks, and each shard's result.
export function buildRoutedReceipt({ workload, instances, tasks, shards }) {
  return {
    schema: ROUTED_SCHEMA,
    workload,
    instances: instances.map((x) => ({ id: x.id, hostname: x.hostname, capabilities: [...x.capabilities].sort(), weight: x.weight, searchTool: x.searchTool })),
    tasks: [...tasks].map((t) => ({ id: t.id, requires: [...(t.requires || [])].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
    shards: shards.map((s, i) => ({ instance: instances[i].id, tasks: [...s.tasks].sort(), passed: s.passed, total: s.tasks.length })),
    allPassed: shards.every((s) => s.passed === s.tasks.length),
  };
}

// Validate a committed routed receipt deterministically: every task ran on a CAPABILITY-MATCHING instance,
// the routing re-derived from the recorded capabilities + weights reproduces the shards, the shards are
// disjoint + cover every task, the instances are distinct, all searched with ripgrep, and every task passed.
export function validateRouting(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== ROUTED_SCHEMA) return { ok: false, findings: [`schema must be ${ROUTED_SCHEMA}`] };
  const instances = receipt.instances || [];
  const tasks = receipt.tasks || [];
  const shards = receipt.shards || [];
  if (instances.length < 2) findings.push('a distributed routing needs >= 2 instances');
  if (shards.length !== instances.length) findings.push('shards do not align with instances');

  const capsById = new Map(instances.map((x) => [x.id, x.capabilities || []]));
  const reqById = new Map(tasks.map((t) => [t.id, t.requires || []]));

  // (a) capability correctness: every task ran on an instance that has ALL its required capabilities
  for (const s of shards) {
    const caps = capsById.get(s.instance) || [];
    for (const id of s.tasks) {
      const req = reqById.get(id) || [];
      if (!req.every((c) => caps.includes(c))) findings.push(`task ${id} (needs [${req.join(',')}]) ran on ${s.instance} lacking it`);
    }
  }
  // (b) the routing re-derived from the recorded capabilities + weights reproduces the shards
  const expected = routeByCapability(tasks, instances.map((x) => ({ capabilities: x.capabilities, weight: x.weight })));
  for (let i = 0; i < shards.length; i++) {
    const got = [...(shards[i].tasks || [])].sort().join('|');
    const exp = [...(expected[i] || [])].sort().join('|');
    if (got !== exp) findings.push(`instance ${i} tasks do not match the capability routing`);
  }
  // (c) disjoint + coverage + distinct instances + ripgrep-only + all passed
  const union = new Set(); let overlap = false;
  for (const s of shards) for (const t of s.tasks) { if (union.has(t)) overlap = true; union.add(t); }
  if (overlap) findings.push('shards overlap (not disjoint)');
  if (union.size !== new Set(tasks.map((t) => t.id)).size) findings.push('shards do not cover every task');
  if (new Set(instances.map((x) => x.hostname)).size < instances.length) findings.push('instances are not distinct (hostnames not unique)');
  for (const x of instances) if (x.searchTool !== 'ripgrep') findings.push(`instance ${x.id} search tool is ${x.searchTool}, not ripgrep`);
  for (const s of shards) if (s.passed !== s.total) findings.push(`instance ${s.instance} had failures (${s.passed}/${s.total})`);
  if (receipt.allPassed !== true) findings.push('allPassed is not true');

  return { ok: findings.length === 0, findings, instances: instances.map((x) => x.id) };
}
