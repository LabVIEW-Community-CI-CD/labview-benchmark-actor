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
  linuxTrend, winTrend, dispatchId,
  dispatchedAt = null, linuxActorId = 'lba-cleanroom-clone-01', winActorId = 'actor',
  requester = 'agent@labview-benchmark-actor',
} = {}) {
  if (!linuxTrend || !winTrend) throw new Error('assembleLiveN2: linuxTrend and winTrend are required');
  if (typeof dispatchId !== 'string' || !dispatchId) throw new Error('assembleLiveN2: dispatchId is required');
  const benchmark = { metric: linuxTrend.metric, workload: linuxTrend.workload, n: linuxTrend.n };
  const dispatch = buildRequest({
    dispatchId, benchmarkId: linuxTrend.workload, benchmark,
    minActors: 2, requestedPlanes: ['LINUX', 'WIN'], requester, dispatchedAt,
  });
  const returned = [
    { schema: RETURNED_SCHEMA, taskId: `${dispatchId}::LINUX`, actorId: linuxActorId, plane: 'LINUX', receipt: linuxTrend },
    { schema: RETURNED_SCHEMA, taskId: `${dispatchId}::WIN`, actorId: winActorId, plane: 'WIN', receipt: winTrend },
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

function main() {
  const iterations = process.env.LBA_ITERATIONS ?? '3';
  const durationMs = process.env.LBA_DURATION_MS ?? '16000';
  const fps = process.env.LBA_FPS ?? '12';
  const sshKey = process.env.LBA_SSH_KEY;
  const outDir = process.env.LBA_OUT_DIR ?? join(tmpdir(), 'lba-live-n2');
  const dispatchId = process.env.LBA_DISPATCH_ID ?? `mesh-run-labview-ide-launch-live-${new Date().toISOString().slice(0, 10)}`;
  mkdirSync(join(outDir, 'returned'), { recursive: true });

  const shared = { LBA_ITERATIONS: iterations, LBA_DURATION_MS: durationMs, LBA_FPS: fps, ...(sshKey ? { LBA_SSH_KEY: sshKey } : {}) };
  const linuxTrend = runPlaneTrend('LINUX', 'live-vbox-labview-trend.mjs', {
    ...shared,
    LBA_SSH_PORT: process.env.LBA_LINUX_SSH_PORT ?? '2223',
    LBA_SSH_USER: process.env.LBA_LINUX_SSH_USER ?? 'actor',
    LBA_VNC_PORT: process.env.LBA_LINUX_VNC_PORT ?? '5900',
    ...(process.env.LBA_LINUX_VNC_PASSWORD ? { LBA_VNC_PASSWORD: process.env.LBA_LINUX_VNC_PASSWORD } : {}),
  }, join(outDir, 'linux-trend.json'));
  const winTrend = runPlaneTrend('WIN', 'win-vbox-sdk-labview-trend.mjs', {
    ...shared,
    LBA_SSH_PORT: process.env.LBA_WIN_SSH_PORT ?? '2200',
    LBA_SSH_USER: process.env.LBA_WIN_SSH_USER ?? 'vagrant',
    LBA_WIN_TASK: process.env.LBA_WIN_TASK ?? 'LBA-LaunchLabVIEW',
  }, join(outDir, 'win-trend.json'));

  const r = assembleLiveN2({ linuxTrend, winTrend, dispatchId, dispatchedAt: new Date().toISOString().slice(0, 10) });
  writeFileSync(join(outDir, 'dispatch.json'), `${JSON.stringify(r.dispatch, null, 2)}\n`);
  writeFileSync(join(outDir, 'returned', 'linux.json'), `${JSON.stringify(r.returned[0], null, 2)}\n`);
  writeFileSync(join(outDir, 'returned', 'win.json'), `${JSON.stringify(r.returned[1], null, 2)}\n`);
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(r.report, null, 2)}\n`);

  if (!r.ok) { console.error(`\n\u2717 live N=2 FAILED (dispatch ${dispatchId})`); for (const f of r.findings) console.error(`  - ${f}`); process.exit(1); }
  const d = r.comparison?.deltas?.latest;
  console.log(`\n\u2713 live N=2 OK: dispatch ${dispatchId} \u2014 cross-plane corroborated [${r.report.planes.join(', ')}] (all PASS, identity-bound)`);
  console.log(`  LINUX mean ${linuxTrend.stats.mean}ms  vs  WIN mean ${winTrend.stats.mean}ms` + (d ? `  |  latest WIN\u2212LINUX = ${d.delta}ms (${d.pctOfLinux}% of LINUX)` : ''));
  console.log(`  artifacts -> ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
