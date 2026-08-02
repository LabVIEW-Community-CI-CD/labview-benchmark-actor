#!/usr/bin/env node
// LIVE capability-routed distributed workload (LBA-REQ-041, ADR-0029). Extends the ADR-0028 executor with
// CAPABILITY-AWARE routing: the host advertises `labview` (it has LabVIEWCLI) + `node`; codespaces advertise
// `node` only. The workload mixes a REAL LabVIEW task (the activation probe -- `LabVIEWCLI RunVI`) with the
// node self-tests. routeByCapability sends the LabVIEW task ONLY to a LabVIEW-capable instance (the host) and
// spreads the node tasks capacity-weighted across the whole pool; shards run CONCURRENTLY. NOT run in CI; the
// committed receipt replays deterministically via verify-capability-routing.selftest.mjs. Every instance
// searches with ripgrep only. Usage:  [MAX_REMOTE=2] node experiments/parallel/runCapabilityRouted.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { routeByCapability, buildRoutedReceipt, validateRouting } from './capabilityRouter.mjs';
import { weightForType } from './parallelWorkload.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const REPO = 'LabVIEW-Community-CI-CD/labview-benchmark-actor';
const REMOTE_DIR = '/workspaces/labview-benchmark-actor';
const MAX_REMOTE = Number(process.env.MAX_REMOTE || 2);
const LVCLI = '/usr/local/bin/LabVIEWCLI';

// The host advertises `labview` iff LabVIEWCLI is installed; a codespace is node-only.
function discoverPool() {
  const hostCaps = existsSync(LVCLI) ? ['labview', 'node'] : ['node'];
  const host = { id: 'host', dispatch: 'local', capabilities: hostCaps, weight: weightForType('host'), searchTool: 'ripgrep', hostname: hostname() };
  const remote = [];
  try {
    const cs = JSON.parse(execFileSync('gh', ['codespace', 'list', '--json', 'name,repository'], { encoding: 'utf8' }));
    for (const c of cs) if (c.repository === REPO) remote.push({ id: `codespace:${c.name}`, name: c.name, dispatch: 'codespace', capabilities: ['node'], weight: weightForType('codespace'), searchTool: 'ripgrep', hostname: `codespace:${c.name}` });
  } catch (e) { console.error(`  (codespace discovery skipped: ${e.message})`); }
  return [host, ...remote.slice(0, MAX_REMOTE)];
}

// The workload: one REAL LabVIEW task (activation probe) + the node self-tests present on origin/develop.
function buildWorkload() {
  const found = execFileSync('rg', ['--files', 'experiments'], { cwd: repoRoot, encoding: 'utf8' }).split(/\r?\n/).filter((l) => /\.selftest\.mjs$/.test(l));
  let onDevelop = new Set(found);
  try { onDevelop = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', 'origin/develop'], { cwd: repoRoot, encoding: 'utf8' }).split(/\r?\n/)); } catch { /* keep all */ }
  const nodeTasks = found.filter((t) => onDevelop.has(t)).sort().map((id) => ({ id, requires: ['node'], cmd: `node "${id}"` }));
  const lvTask = { id: 'labview:activation-probe', requires: ['labview'], cmd: 'bash experiments/activation/probe-activation.sh 7 5 /tmp/lba-cap-probe.json' };
  return [lvTask, ...nodeTasks];
}

function ensureCodespace(name) {
  const setup = `which rg >/dev/null 2>&1 || (sudo apt-get update -qq >/dev/null 2>&1 && sudo apt-get install -y ripgrep >/dev/null 2>&1); cd ${REMOTE_DIR} && git fetch origin develop -q && git checkout -B develop origin/develop 2>/dev/null; echo READY`;
  spawnSync('gh', ['codespace', 'ssh', '-c', name, '--', setup], { encoding: 'utf8', timeout: 240000 });
}

function runLocal(inst, ids, cmdById) {
  const t0 = Date.now(); let passed = 0;
  for (const id of ids) { if (spawnSync('bash', ['-c', cmdById.get(id)], { cwd: repoRoot, stdio: 'ignore' }).status === 0) passed += 1; else console.error(`  host FAIL ${id}`); }
  return { ...inst, tasks: ids, passed, wallMs: Date.now() - t0 };
}
function runRemote(inst, ids, cmdById, sshArgv) {
  const t0 = Date.now();
  const body = ids.map((id) => `${cmdById.get(id)} >/dev/null 2>&1 && echo P || echo "F ${id}"`).join('; ');
  const remote = `cd ${REMOTE_DIR} && echo "HOST:$(hostname)" && echo "RG:$(rg --version 2>/dev/null | head -1)" && ${body}`;
  const r = spawnSync(sshArgv[0], [...sshArgv.slice(1), remote], { encoding: 'utf8', timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  for (const f of out.match(/^F .+$/gm) || []) console.error(`  ${inst.id} ${f}`);
  return { ...inst, hostname: (out.match(/HOST:(\S+)/) || [])[1] || inst.id, searchTool: /RG:ripgrep/.test(out) ? 'ripgrep' : 'unknown', tasks: ids, passed: (out.match(/^P$/gm) || []).length, wallMs: Date.now() - t0 };
}

const pool = discoverPool();
console.log(`pool: ${pool.map((p) => `${p.id}{${p.capabilities.join('+')}}`).join(', ')}`);
for (const p of pool) if (p.dispatch === 'codespace') { process.stdout.write(`  provisioning ${p.id}...\n`); ensureCodespace(p.name); }

const workload = buildWorkload();
const cmdById = new Map(workload.map((t) => [t.id, t.cmd]));
const tasks = workload.map((t) => ({ id: t.id, requires: t.requires }));
const shards = routeByCapability(tasks, pool);
console.log(`workload: 1 labview + ${tasks.length - 1} node tasks -> ${pool.map((p, i) => `${p.id.split(':')[0]} ${shards[i].length}`).join(' | ')}`);

const results = await Promise.all(pool.map((inst, i) => Promise.resolve().then(() => (inst.dispatch === 'local'
  ? runLocal(inst, shards[i], cmdById)
  : runRemote(inst, shards[i], cmdById, ['gh', 'codespace', 'ssh', '-c', inst.name, '--'])))));

const receipt = buildRoutedReceipt({ workload: 'cross-plane capability-routed', instances: results, tasks, shards: results });
const v = validateRouting(receipt);
mkdirSync(join(here, 'fixtures'), { recursive: true });
writeFileSync(join(here, 'fixtures', 'capability-routed-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

for (const s of receipt.shards) { const inst = receipt.instances.find((x) => x.id === s.instance); console.log(`  ${s.instance} [${inst.hostname} {${inst.capabilities.join('+')}}] ${s.passed}/${s.total}`); }
const lvShard = receipt.shards.find((s) => s.tasks.includes('labview:activation-probe'));
console.log(`labview task ran on: ${lvShard ? lvShard.instance : 'NONE'} (capabilities ${receipt.instances.find((x) => x.id === lvShard?.instance)?.capabilities.join('+')}); valid=${v.ok}${v.ok ? '' : ' findings=' + v.findings.join('; ')}`);
