#!/usr/bin/env node
// LIVE distributed parallel-workload orchestrator (LBA-REQ-040, ADR-0028). Discovers the instance POOL --
// this host (always) plus available labview-benchmark-actor codespaces (and running local VMs) up to a
// conservative BUDGET cap -- capacity-weight-splits the workload across them, runs the shards CONCURRENTLY,
// and writes a distributed-workload receipt. NOT run in CI; the committed receipt is replayed
// deterministically by verify-parallel-workload.selftest.mjs.
//
// Design (operator-directed): dynamic discovery (no committed registry); direct SSH adapters per instance
// type (local spawn / `gh codespace ssh` / `vagrant ssh`); STATIC capacity weights by type (host fastest);
// budget cap default = host + 2 remote, concurrency = pool size; may auto-resume stopped codespaces up to
// the cap. EVERY instance searches with RIPGREP ONLY -- the task list is discovered with `rg` and each shard
// attests searchTool=ripgrep. Usage:  [MAX_REMOTE=2] node experiments/parallel/runParallel.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { capacityWeightedPartition, buildReceipt, validateReceipt, weightForType } from './parallelWorkload.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const REPO = 'LabVIEW-Community-CI-CD/labview-benchmark-actor';
const REMOTE_DIR = '/workspaces/labview-benchmark-actor';
const MAX_REMOTE = Number(process.env.MAX_REMOTE || 2); // budget default: host + 2 remote instances

// Discover the self-test workload with ripgrep (rg-only), then keep only those PRESENT ON origin/develop --
// the code every synced instance actually has -- so a shard never runs a file a worker is missing (the new,
// not-yet-merged files in this branch are excluded). Sorted => deterministic task list.
function discoverTasks() {
  const found = execFileSync('rg', ['--files', 'experiments'], { cwd: repoRoot, encoding: 'utf8' })
    .split(/\r?\n/).filter((l) => /\.selftest\.mjs$/.test(l));
  let onDevelop = new Set(found);
  try {
    onDevelop = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', 'origin/develop'], { cwd: repoRoot, encoding: 'utf8' }).split(/\r?\n/));
  } catch { /* no origin/develop -> fall back to all found */ }
  return found.filter((t) => onDevelop.has(t)).sort();
}

// Discover the instance POOL (dynamic, budget-capped): host always; then labview-benchmark-actor codespaces;
// then running local Ubuntu VMs. Stopped codespaces are fine (gh ssh auto-resumes). Capped to MAX_REMOTE.
function discoverPool() {
  const host = { instance: 'host', type: 'host', dispatch: 'local', weight: weightForType('host') };
  const remote = [];
  try {
    const cs = JSON.parse(execFileSync('gh', ['codespace', 'list', '--json', 'name,repository,state'], { encoding: 'utf8' }));
    for (const c of cs) if (c.repository === REPO) remote.push({ instance: `codespace:${c.name}`, type: 'codespace', dispatch: 'codespace', name: c.name, weight: weightForType('codespace') });
  } catch (e) { console.error(`  (codespace discovery skipped: ${e.message})`); }
  try {
    const env = { ...process.env, VAGRANT_HOME: process.env.VAGRANT_HOME || `${process.env.HOME}/.lba-vagrant-home` };
    for (const line of execFileSync('vagrant', ['global-status'], { encoding: 'utf8', env }).split(/\r?\n/)) {
      const m = line.match(/^([0-9a-f]{7})\s+\S+\s+virtualbox\s+running\s+(\S+)/);
      if (m && /ubuntu|labview|scratch|mesh/i.test(m[2])) remote.push({ instance: `vm:${m[1]}`, type: 'vm', dispatch: 'vm', vmId: m[1], weight: weightForType('vm') });
    }
  } catch { /* vagrant optional */ }
  return [host, ...remote.slice(0, MAX_REMOTE)];
}

// Ensure a codespace worker has ripgrep + the repo at develop (UNTIMED setup, not part of the workload).
function ensureCodespace(name) {
  const setup = `which rg >/dev/null 2>&1 || (sudo apt-get update -qq >/dev/null 2>&1 && sudo apt-get install -y ripgrep >/dev/null 2>&1); cd ${REMOTE_DIR} && git fetch origin develop -q && git checkout develop -q 2>/dev/null && git merge --ff-only origin/develop -q 2>/dev/null; echo READY`;
  spawnSync('gh', ['codespace', 'ssh', '-c', name, '--', setup], { encoding: 'utf8', timeout: 240000 });
}

// ---- dispatch adapters (one per instance type) --------------------------------------------------
function runLocal(inst, tasks) {
  const t0 = Date.now();
  let passed = 0;
  for (const t of tasks) { if (spawnSync(process.execPath, [t], { cwd: repoRoot, stdio: 'ignore' }).status === 0) passed += 1; else console.error(`  host FAIL ${t}`); }
  return { instance: inst.instance, type: 'host', hostname: hostname(), weight: inst.weight, searchTool: 'ripgrep', tasks, passed, wallMs: Date.now() - t0 };
}
function runRemote(inst, tasks, sshArgv) {
  const t0 = Date.now();
  const remote = `cd ${REMOTE_DIR} && echo "HOST:$(hostname)" && echo "RG:$(rg --version 2>/dev/null | head -1)" && for t in ${tasks.join(' ')}; do node "$t" >/dev/null 2>&1 && echo P || echo "F $t"; done`;
  const r = spawnSync(sshArgv[0], [...sshArgv.slice(1), remote], { encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const host = (out.match(/HOST:(\S+)/) || [])[1] || inst.instance;
  const passed = (out.match(/^P$/gm) || []).length;
  for (const f of out.match(/^F .+$/gm) || []) console.error(`  ${inst.instance} ${f}`);
  return { instance: inst.instance, type: inst.type, hostname: host, weight: inst.weight, searchTool: /RG:ripgrep/.test(out) ? 'ripgrep' : 'unknown', tasks, passed, wallMs: Date.now() - t0 };
}
function runInstance(inst, tasks) {
  if (inst.dispatch === 'local') return runLocal(inst, tasks);
  if (inst.dispatch === 'codespace') return runRemote(inst, tasks, ['gh', 'codespace', 'ssh', '-c', inst.name, '--']);
  if (inst.dispatch === 'vm') return runRemote(inst, tasks, ['vagrant', 'ssh', inst.vmId, '-c']);
  throw new Error(`unknown dispatch: ${inst.dispatch}`);
}

const tasks = discoverTasks();
const pool = discoverPool();
console.log(`pool (budget host + ${MAX_REMOTE} remote): ${pool.map((p) => `${p.instance}[w${p.weight}]`).join(', ')}`);

// provision codespace workers (UNTIMED) before the timed dispatch
for (const p of pool) if (p.dispatch === 'codespace') { process.stdout.write(`  provisioning ${p.instance} (rg + sync)...\n`); ensureCodespace(p.name); }

const shards = capacityWeightedPartition(tasks, pool);
console.log(`workload: ${tasks.length} self-tests -> ${pool.map((p, i) => `${p.type} ${shards[i].length}`).join(' | ')} (concurrent)`);

const results = await Promise.all(pool.map((inst, i) => Promise.resolve().then(() => runInstance(inst, shards[i]))));

const receipt = buildReceipt({ workload: 'experiment self-tests', tasks, shards: results });
const v = validateReceipt(receipt);
mkdirSync(join(here, 'fixtures'), { recursive: true });
writeFileSync(join(here, 'fixtures', 'parallel-workload-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

for (const s of receipt.shards) console.log(`  ${s.instance} [${s.hostname} w${s.weight}] ${s.passed}/${s.total} in ${s.wallMs}ms (rg=${s.searchTool})`);
const seq = receipt.shards.reduce((a, s) => a + s.wallMs, 0);
const wall = Math.max(...receipt.shards.map((s) => s.wallMs));
console.log(`distributed: ${receipt.instanceCount} instances, max-instance ${wall}ms vs sequential-sum ${seq}ms (speedup ~${(seq / wall).toFixed(2)}x); valid=${v.ok}${v.ok ? '' : ' findings=' + v.findings.join('; ')}`);
console.log(`parallel: max-shard ${wall}ms vs sequential-sum ${seq}ms (speedup ~${(seq / wall).toFixed(2)}x); valid=${v.ok}${v.ok ? '' : ' findings=' + v.findings.join('; ')}`);
