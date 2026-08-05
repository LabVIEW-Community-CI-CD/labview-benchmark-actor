// driveLiveN2.mjs — ONE agent command for the end-to-end cross-plane N=2: run BOTH live plane trends, wrap them
// as run-bound receipts, and corroborate + compare — the whole mesh run from a single invocation.
//
//   live main: runs the LINUX VBox-VNC trend (live-vbox-labview-trend.mjs) + the WIN VBox-SDK trend
//   (win-vbox-sdk-labview-trend.mjs), mints a matching dispatch (buildRequest), wraps each trend as a
//   returned-receipt@1, then chains ingest (LBA-REQ-091) + corroborate (LBA-REQ-092) -> mesh-cross-plane-report@1.
//   The PURE assembly (assembleLiveN2) is separated from the live I/O so it is deterministically self-testable
//   against committed receipts (no live VMs needed in CI).
//
//   Env (both planes must be live actors; defaults target the current lab VMs):
//     LBA_ITERATIONS(3) LBA_DURATION_MS(16000) LBA_FPS(12) LBA_SSH_KEY(~/.ssh/lba_scratch)
//     LINUX plane: LBA_LINUX_SSH_PORT(2223) LBA_LINUX_SSH_USER(actor) LBA_LINUX_VNC_PORT(5900) LBA_LINUX_VNC_PASSWORD
//     WIN   plane: LBA_WIN_SSH_PORT(2200) LBA_WIN_SSH_USER(vagrant) LBA_WIN_TASK(LBA-LaunchLabVIEW)
//     LBA_DISPATCH_ID(mesh-run-labview-ide-launch-live-<date>) LBA_OUT_DIR(<tmp>/lba-live-n2)
//   node experiments/mesh-fulfillment/driveLiveN2.mjs

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildRequest } from './meshDispatch.mjs';
import { ingestRun } from './meshIngest.mjs';
import { corroborateRun } from './meshCorroborate.mjs';

const RETURNED_SCHEMA = 'labview-benchmark-actor/returned-receipt@1';

/**
 * PURE assembly: two plane trends -> a run-bound { dispatch, returned, report }. The dispatch identity is minted
 * from the (shared) benchmark spec; each trend is wrapped as a returned-receipt@1 bound to `${dispatchId}::PLANE`;
 * ingest + corroborate then produce the cross-plane report. Fails closed (ok:false + findings) if the planes ran
 * different benchmarks (n / metric / workload mismatch -> identity mismatch) or either verdict is not PASS.
 */
export function assembleLiveN2({
  linuxTrend, winTrend, linuxActors, winActors, dispatchId,
  dispatchedAt = null, linuxActorId = 'lba-cleanroom-clone-01', winActorId = 'actor',
  requester = 'agent@labview-benchmark-actor',
} = {}) {
  // Normalize each plane to a ROSTER of { actorId, trend } -- a plane can carry N redundant actors (quorum). The
  // single-trend form (linuxTrend/winTrend) stays supported for the N=2 case.
  const linuxRoster = linuxActors ?? (linuxTrend ? [{ actorId: linuxActorId, trend: linuxTrend }] : []);
  const winRoster = winActors ?? (winTrend ? [{ actorId: winActorId, trend: winTrend }] : []);
  if (linuxRoster.length === 0 || winRoster.length === 0) throw new Error('assembleLiveN2: at least one LINUX and one WIN actor are required');
  if (typeof dispatchId !== 'string' || !dispatchId) throw new Error('assembleLiveN2: dispatchId is required');
  const ref = linuxRoster[0].trend;
  const benchmark = { metric: ref.metric, workload: ref.workload, n: ref.n };
  const dispatch = buildRequest({
    dispatchId, benchmarkId: ref.workload, benchmark,
    minActors: linuxRoster.length + winRoster.length, requestedPlanes: ['LINUX', 'WIN'], requester, dispatchedAt,
  });
  const returned = [
    ...linuxRoster.map((a) => ({ schema: RETURNED_SCHEMA, taskId: `${dispatchId}::LINUX`, actorId: a.actorId, plane: 'LINUX', receipt: a.trend })),
    ...winRoster.map((a) => ({ schema: RETURNED_SCHEMA, taskId: `${dispatchId}::WIN`, actorId: a.actorId, plane: 'WIN', receipt: a.trend })),
  ];
  const ingest = ingestRun({ dispatch, returned });
  const cor = corroborateRun({ collection: ingest.collection, benchmarkId: benchmark.workload });
  const findings = [...ingest.findings.map((f) => `ingest: ${f}`), ...cor.findings.map((f) => `corroborate: ${f}`)];
  return { ok: ingest.ok && cor.ok, findings, dispatch, returned, report: cor.report, comparison: cor.comparison };
}

// ---- live orchestration -------------------------------------------------------------------------
const runnerPath = (rel) => fileURLToPath(new URL(`../mprr-capture-ring/${rel}`, import.meta.url));

/** Run one plane's trend runner with the given env overrides and return the parsed workload-trend@1. */
function runPlaneTrend(label, runnerRel, env, outPath) {
  process.stdout.write(`\n\u25b6 ${label} plane: ${runnerRel}\n`);
  const r = spawnSync('node', [runnerPath(runnerRel)], { stdio: 'inherit', env: { ...process.env, ...env, LBA_OUT: outPath } });
  if (r.status !== 0) throw new Error(`${label} plane runner failed (exit ${r.status})`);
  return JSON.parse(readFileSync(outPath, 'utf8'));
}

/** Parse LBA_LINUX_ACTORS="actorId:sshPort:vncPort,actorId:sshPort:vncPort" -> roster; defaults to a single actor. */
function parseLinuxActors() {
  const spec = process.env.LBA_LINUX_ACTORS;
  if (spec && spec.trim()) {
    return spec.split(',').map((s) => {
      const [actorId, sshPort, vncPort] = s.split(':');
      return { actorId, sshPort, vncPort };
    });
  }
  return [{
    actorId: process.env.LBA_LINUX_ACTOR_ID ?? 'lba-cleanroom-clone-01',
    sshPort: process.env.LBA_LINUX_SSH_PORT ?? '2223',
    vncPort: process.env.LBA_LINUX_VNC_PORT ?? '5900',
  }];
}

function main() {
  const iterations = process.env.LBA_ITERATIONS ?? '3';
  const durationMs = process.env.LBA_DURATION_MS ?? '16000';
  const fps = process.env.LBA_FPS ?? '12';
  const sshKey = process.env.LBA_SSH_KEY;
  const linuxUser = process.env.LBA_LINUX_SSH_USER ?? 'actor';
  const linuxVncPw = process.env.LBA_LINUX_VNC_PASSWORD;
  const outDir = process.env.LBA_OUT_DIR ?? join(tmpdir(), 'lba-live-n2');
  const dispatchId = process.env.LBA_DISPATCH_ID ?? `mesh-run-labview-ide-launch-live-${new Date().toISOString().slice(0, 10)}`;
  mkdirSync(join(outDir, 'returned'), { recursive: true });
  const shared = { LBA_ITERATIONS: iterations, LBA_DURATION_MS: durationMs, LBA_FPS: fps, ...(sshKey ? { LBA_SSH_KEY: sshKey } : {}) };

  // LINUX plane: one trend per rostered actor (N>=1 -> quorum). WIN plane: the SDK actor.
  const linuxActors = parseLinuxActors().map((a) => ({
    actorId: a.actorId,
    trend: runPlaneTrend(`LINUX/${a.actorId}`, 'live-vbox-labview-trend.mjs', {
      ...shared,
      LBA_SSH_PORT: a.sshPort, LBA_SSH_USER: linuxUser, LBA_VNC_PORT: a.vncPort,
      ...(linuxVncPw ? { LBA_VNC_PASSWORD: linuxVncPw } : {}),
    }, join(outDir, `linux-${a.actorId}.json`)),
  }));
  const winActors = [{
    actorId: process.env.LBA_WIN_ACTOR_ID ?? 'actor',
    trend: runPlaneTrend('WIN', 'win-vbox-sdk-labview-trend.mjs', {
      ...shared,
      LBA_SSH_PORT: process.env.LBA_WIN_SSH_PORT ?? '2200',
      LBA_SSH_USER: process.env.LBA_WIN_SSH_USER ?? 'vagrant',
      LBA_WIN_TASK: process.env.LBA_WIN_TASK ?? 'LBA-LaunchLabVIEW',
    }, join(outDir, 'win-actor.json')),
  }];

  const r = assembleLiveN2({ linuxActors, winActors, dispatchId, dispatchedAt: new Date().toISOString().slice(0, 10) });
  writeFileSync(join(outDir, 'dispatch.json'), `${JSON.stringify(r.dispatch, null, 2)}\n`);
  r.returned.forEach((rr) => writeFileSync(join(outDir, 'returned', `${rr.plane.toLowerCase()}-${rr.actorId}.json`), `${JSON.stringify(rr, null, 2)}\n`));
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(r.report, null, 2)}\n`);

  const n = r.returned.length;
  if (!r.ok) { console.error(`\n\u2717 live N=${n} FAILED (dispatch ${dispatchId})`); for (const f of r.findings) console.error(`  - ${f}`); process.exit(1); }
  const q = r.report.corroboration.quorum;
  const d = r.comparison?.deltas?.latest;
  console.log(`\n\u2713 live N=${n} OK: dispatch ${dispatchId} \u2014 cross-plane corroborated [${r.report.planes.join(', ')}] (all PASS, identity-bound)`);
  for (const p of r.report.planes) console.log(`  ${p}: ${q.perPlane[p].count} actor(s) ${JSON.stringify(q.perPlane[p].actors)} means ${JSON.stringify(q.perPlane[p].meansMs)}ms`);
  if (d) console.log(`  compare: latest WIN\u2212LINUX = ${d.delta}ms (${d.pctOfLinux}% of LINUX)`);
  console.log(`  artifacts -> ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
