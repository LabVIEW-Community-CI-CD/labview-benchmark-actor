// bootbench-run.mjs — from-source-boot container 4-milestone TIMING record (buildMs + meshFormMs), the
// reliable hypervisor-free analog of the VM boot-benchmark. Runs N `lbabus-linux-verify:bootbench` containers
// as a mesh: each BUILDS lbabus from source on start (LBABUS-BUILD-START -> LBABUS-BUILT) then meshes
// (-> MESH-OK), emitting each milestone with the guest CLOCK_MONOTONIC (/proc/uptime). Parses the LBABENCH
// lines from `docker logs`, computes per-node buildMs + meshFormMs, and seals a record + manifest under
// experiments/mesh-runs/<runId>/ for cross-run and CROSS-PLANE (container-vs-container) comparison.
//
//   node experiments/mesh-runs/bootbench-run.mjs [--actors N] [--image IMG] [--run-id ID] [--out-dir DIR] [--keep]

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function defaultExec(file, args) {
  try {
    const stdout = execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: typeof err.status === 'number' ? err.status : 1, stdout: err.stdout?.toString?.() ?? '', stderr: err.stderr?.toString?.() ?? String(err) };
  }
}

export function resolveCommit(exec) {
  const head = exec('git', ['rev-parse', '--short', 'HEAD']);
  if (head.status !== 0) return 'nogit';
  const sha = head.stdout.trim();
  const st = exec('git', ['status', '--porcelain']);
  return (st.status === 0 && st.stdout.trim().length > 0) ? `${sha}-dirty` : sha;
}

export function nextRunNumber(existingRunIds, base) {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-r(\\d+)$`);
  let max = 0;
  for (const id of existingRunIds) { const m = re.exec(id); if (m) max = Math.max(max, Number(m[1])); }
  return max + 1;
}

/** Parse `LBABENCH <case> mono=<seconds.fraction>` milestone lines into buildMs + meshFormMs (guest clock). */
export function parseMilestones(logText) {
  const mono = {};
  for (const m of logText.matchAll(/LBABENCH (\S+) mono=([0-9.]+)/g)) {
    if (mono[m[1]] === undefined) mono[m[1]] = Number(m[2]); // first occurrence per milestone
  }
  const ms = (a, b) => (mono[a] !== undefined && mono[b] !== undefined ? Math.round((mono[b] - mono[a]) * 1000) : null);
  return {
    milestones: mono,
    buildMs: ms('LBABUS-BUILD-START', 'LBABUS-BUILT'),
    meshFormMs: ms('LBABUS-BUILT', 'MESH-OK'),
    meshOk: mono['MESH-OK'] !== undefined,
  };
}

const stat = (xs) => (xs.length ? { min: Math.min(...xs), max: Math.max(...xs), mean: Math.round(xs.reduce((s, v) => s + v, 0) / xs.length) } : null);

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
  const actors = Number(opt('--actors', '2'));
  const image = opt('--image', 'lbabus-linux-verify:bootbench');
  const outDir = opt('--out-dir', HERE);
  const keep = args.includes('--keep');
  const exec = defaultExec;
  const commit = resolveCommit(exec);
  const base = `bootbench-${commit}`;
  const existing = existsSync(outDir) ? readdirSync(outDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  const runNumber = nextRunNumber(existing, base);
  const runId = opt('--run-id', `${base}-r${String(runNumber).padStart(3, '0')}`);

  const prefix = `bb-${commit}-r${String(runNumber).padStart(3, '0')}`;
  const net = `${prefix}-net`;
  const names = Array.from({ length: actors }, (_, i) => `${prefix}-actor-${i + 1}`);
  const peers = names.join(',');
  const timeout = 60 + actors * 3;
  const runDir = join(outDir, runId);
  mkdirSync(runDir, { recursive: true });

  console.log(`== bootbench run ${runId}: ${actors} from-source-boot actors (image ${image}) ==`);
  const startedAt = new Date();
  exec('docker', ['network', 'create', net]);
  const cleanup = () => {
    if (keep) return;
    for (const n of names) exec('docker', ['rm', '-f', n]);
    exec('docker', ['network', 'rm', net]);
  };

  try {
    for (const n of names) {
      exec('docker', ['run', '-d', '--name', n, '--hostname', n, '--network', net,
        '-e', `VIHS_COLLAB_AGENT=${n}`, '-e', `MESH_PEERS=${peers}`,
        '-e', `TIMEOUT_SEC=${timeout}`, '-e', `UDP_TIMEOUT_SEC=${timeout}`,
        '-e', 'SEND_RETRIES=90', '-e', 'UDP_BEACONS=1', image]);
    }
    for (const n of names) exec('docker', ['wait', n]);

    const perActor = names.map((name) => {
      const exitCode = Number(exec('docker', ['inspect', '-f', '{{.State.ExitCode}}', name]).stdout.trim());
      const logText = exec('docker', ['logs', name]).stdout + exec('docker', ['logs', name]).stderr;
      writeFileSync(join(runDir, `${name}.log`), logText);
      const { buildMs, meshFormMs, meshOk } = parseMilestones(logText);
      return { name, exitCode, meshOk, buildMs, meshFormMs };
    });

    const okCount = perActor.filter((a) => a.exitCode === 0 && a.meshOk).length;
    const record = {
      schema: 'labview-benchmark-actor/bootbench-4milestone@1',
      runId, prefix, commit, image, network: net, actors, plane: process.env.LBA_PLANE ?? 'WIN',
      substrate: 'docker-container', clock: 'guest CLOCK_MONOTONIC (/proc/uptime)',
      milestones: ['BOOT-START', 'LBABUS-BUILD-START', 'LBABUS-BUILT', 'MESH-OK'],
      startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(),
      result: okCount === actors ? 'PASS' : 'FAIL', okCount,
      buildMs: stat(perActor.map((a) => a.buildMs).filter(Number.isFinite)),
      meshFormMs: stat(perActor.map((a) => a.meshFormMs).filter(Number.isFinite)),
      perActor,
    };
    writeFileSync(join(runDir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);

    console.log(`result: ${record.result} (${okCount}/${actors} built + formed the full mesh)`);
    if (record.buildMs) console.log(`buildMs:    min=${record.buildMs.min} mean=${record.buildMs.mean} max=${record.buildMs.max}`);
    if (record.meshFormMs) console.log(`meshFormMs: min=${record.meshFormMs.min} mean=${record.meshFormMs.mean} max=${record.meshFormMs.max}`);
    console.log(`sealed: ${join(runDir, 'record.json')} + ${actors} actor logs`);
    process.exitCode = record.result === 'PASS' ? 0 : 1;
  } finally {
    cleanup();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
  await main();
}
