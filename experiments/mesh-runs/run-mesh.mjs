// run-mesh.mjs — reliable, REPEATABLE containerized lbabus mesh runs with a UNIQUE per-run prefix + STORED
// per-run logs, so runs are individually identifiable and comparable ACROSS runs (for agent inference).
//
// Why: the VM mesh path is environment-flaky (NAT, tools, boot timing); the Linux-container mesh
// (tools/collab-cli/ci/Dockerfile.linux --target mesh, the SAME mesh-actor.sh workload) forms in seconds and
// is deterministic. ci/mesh-linux.sh is a one-shot PASS/FAIL gate that self-cleans (logs discarded). This
// harness KEEPS the evidence: each run gets a reproducible runId prefix mesh-<commit>[-<role>]-r<NNN> on every
// actor name (role, when set, is the `Actor:` trailer of the building commit — the same one lbabus agents
// --role-from-commit reads), and every actor's timestamped log + a structured manifest.json are written under
// experiments/mesh-runs/<runId>/ BEFORE cleanup. Compare two runs by diffing their manifests (mesh formation
// success + per-actor meshFormMs).
//
//   node experiments/mesh-runs/run-mesh.mjs [--actors N] [--image IMG] [--role R] [--run-id ID] [--out-dir DIR] [--keep]
//
// Env deps injected for CI-testability: exec (docker), now, rng. Default exec shells to the docker CLI.

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

/** Short commit id for HEAD, with a `-dirty` marker if the working tree has uncommitted changes. */
export function resolveCommit(exec) {
  const head = exec('git', ['rev-parse', '--short', 'HEAD']);
  if (head.status !== 0) return 'nogit';
  const sha = head.stdout.trim();
  const st = exec('git', ['status', '--porcelain']);
  return (st.status === 0 && st.stdout.trim().length > 0) ? `${sha}-dirty` : sha;
}

/**
 * Derive the actor role from the commit DESCRIPTION: the last `Actor:`/`Agent:` git trailer of <ref> (the
 * same convention `lbabus agents --role-from-commit` reads). Returns a dns/url-safe slug, or null. This ties
 * the run's actor identity to the commit it ran, and names the role overlay (agents/roles/<role>.md).
 */
export function resolveRole(exec, ref = 'HEAD') {
  const r = exec('git', ['log', '-1', '--format=%B', ref]);
  if (r.status !== 0) return null;
  let found = null;
  for (const raw of r.stdout.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const c = line.indexOf(':');
    if (c <= 0) continue;
    const key = line.slice(0, c).trim().toLowerCase();
    if (key === 'actor' || key === 'agent') { const v = line.slice(c + 1).trim(); if (v) found = v; }
  }
  if (!found) return null;
  const slug = found.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

/** Next run number for a base = 1 + the max r<NNN> already stored for that base. */
export function nextRunNumber(existingRunIds, base) {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-r(\\d+)$`);
  let max = 0;
  for (const id of existingRunIds) { const m = re.exec(id); if (m) max = Math.max(max, Number(m[1])); }
  return max + 1;
}

/** runId = <base>-r<NNN> where base is <commit> or <commit>-<role> (ties actor names + the record to the code state). */
export function makeRunId(base, runNumber) {
  return `${base}-r${String(runNumber).padStart(3, '0')}`;
}

/** Parse `docker logs -t` output (each line: "<rfc3339> <text>") into milestone metrics for one actor. */
export function parseActorLog(logText) {
  const lines = logText.split(/\r?\n/).filter(Boolean).map((l) => {
    const m = /^(\S+)\s+(.*)$/.exec(l);
    return m ? { t: Date.parse(m[1]), text: m[2] } : { t: NaN, text: l };
  });
  const find = (re) => lines.find((l) => re.test(l.text));
  const start = find(/mesh start:/);
  const heard = [...lines].reverse().find((l) => /heard from/.test(l.text));
  const meshOk = find(/MESH OK \(TCP\+UDP\)/);
  const incomplete = find(/MESH INCOMPLETE/);
  const hm = heard && /TCP heard from (\d+) \/ (\d+) ; UDP heard from (\d+) \/ (\d+)/.exec(heard.text);
  const meshFormMs = start && meshOk && Number.isFinite(start.t) && Number.isFinite(meshOk.t) ? meshOk.t - start.t : null;
  return {
    meshOk: Boolean(meshOk),
    incomplete: Boolean(incomplete),
    tcpHeard: hm ? `${hm[1]}/${hm[2]}` : null,
    udpHeard: hm ? `${hm[3]}/${hm[4]}` : null,
    meshFormMs,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
  const actors = Number(opt('--actors', '3'));
  const image = opt('--image', 'lbabus-linux-verify:mesh');
  const outDir = opt('--out-dir', join(HERE));
  const keep = args.includes('--keep');
  const exec = defaultExec;
  const commit = resolveCommit(exec);
  const role = opt('--role', resolveRole(exec));
  const base = role ? `${commit}-${role}` : commit;
  const existing = existsSync(outDir) ? readdirSync(outDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  const runNumber = nextRunNumber(existing, base);
  const runId = opt('--run-id', makeRunId(base, runNumber));

  const prefix = `mesh-${runId}`;
  const net = `${prefix}-net`;
  const names = Array.from({ length: actors }, (_, i) => `${prefix}-actor-${i + 1}`);
  const peers = names.join(',');
  const tcpTimeout = 60 + actors * 3;
  const runDir = join(outDir, runId);
  mkdirSync(runDir, { recursive: true });

  console.log(`== mesh run ${runId}: ${actors} actors (image ${image}${role ? `, role ${role}` : ''}) ==`);
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
        ...(role ? ['-e', `LBA_AGENTS_ROLE=${role}`] : []),
        '-e', `TIMEOUT_SEC=${tcpTimeout}`, '-e', `UDP_TIMEOUT_SEC=${tcpTimeout}`,
        '-e', 'SEND_RETRIES=90', '-e', 'UDP_BEACONS=1', image]);
    }
    for (const n of names) exec('docker', ['wait', n]);

    const perActor = names.map((name) => {
      const exitCode = Number(exec('docker', ['inspect', '-f', '{{.State.ExitCode}}', name]).stdout.trim());
      const logText = exec('docker', ['logs', '-t', name]).stdout;
      writeFileSync(join(runDir, `${name}.log`), logText);
      return { name, exitCode, ...parseActorLog(logText) };
    });

    const okCount = perActor.filter((a) => a.exitCode === 0).length;
    const formMs = perActor.map((a) => a.meshFormMs).filter((m) => Number.isFinite(m));
    const manifest = {
      schema: 'labview-benchmark-actor/mesh-run@1',
      runId, prefix, commit, role: role ?? null, runNumber: Number(/-r(\d+)$/.exec(runId)?.[1] ?? 0), image, network: net, actors,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      result: okCount === actors ? 'PASS' : 'FAIL',
      okCount,
      meshFormMs: formMs.length ? { min: Math.min(...formMs), max: Math.max(...formMs), mean: Math.round(formMs.reduce((s, m) => s + m, 0) / formMs.length) } : null,
      perActor,
    };
    writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(`result: ${manifest.result} (${okCount}/${actors} formed the full TCP+UDP mesh)`);
    if (manifest.meshFormMs) console.log(`meshFormMs: min=${manifest.meshFormMs.min} mean=${manifest.meshFormMs.mean} max=${manifest.meshFormMs.max}`);
    console.log(`stored: ${join(runDir, 'manifest.json')} + ${actors} actor logs`);
    process.exitCode = manifest.result === 'PASS' ? 0 : 1;
  } finally {
    cleanup();
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/').split('/').pop() ?? '')) {
  await main();
}
