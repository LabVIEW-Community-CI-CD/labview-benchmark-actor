// compare-mesh-runs.mjs — cross-run inference over stored mesh-run manifests. Loads the per-run manifest.json
// files run-mesh.mjs stores (each keyed by a <commit>-r<NNN> runId), prints a comparison table, and surfaces
// the meshFormMs trend so a regression (mesh gets slower / stops forming) is visible ACROSS runs + commits.
//
//   node experiments/mesh-runs/compare-mesh-runs.mjs [runId ...]   # default: every stored run, sorted

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Load run manifests (by explicit ids, else every stored run), sorted by commit then run number. */
export function loadRuns(ids, dir = HERE) {
  const names = ids.length ? ids : (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);
  return names
    .map((n) => { try { return JSON.parse(readFileSync(join(dir, n, 'manifest.json'), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (a.commit === b.commit ? (a.runNumber ?? 0) - (b.runNumber ?? 0) : String(a.commit).localeCompare(String(b.commit))));
}

if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/').split('/').pop() ?? '')) {
  const runs = loadRuns(process.argv.slice(2));
  if (!runs.length) { console.error('no mesh-run manifests found (run: node experiments/mesh-runs/run-mesh.mjs)'); process.exit(2); }
  console.log(['runId'.padEnd(20), 'actors'.padEnd(7), 'result'.padEnd(7), 'ok'.padEnd(6), 'meshFormMs(min/mean/max)'].join(' '));
  for (const r of runs) {
    const f = r.meshFormMs ? `${r.meshFormMs.min}/${r.meshFormMs.mean}/${r.meshFormMs.max}` : '-';
    console.log([String(r.runId).padEnd(20), String(r.actors).padEnd(7), String(r.result).padEnd(7), `${r.okCount}/${r.actors}`.padEnd(6), f].join(' '));
  }
  const wf = runs.filter((r) => r.meshFormMs);
  if (wf.length >= 2) {
    const a = wf[0].meshFormMs.mean; const b = wf.at(-1).meshFormMs.mean;
    console.log(`\ntrend: meshFormMs mean ${a} -> ${b} (${b > a ? '+' : ''}${b - a}ms across ${wf.length} runs, ${wf[0].runId} -> ${wf.at(-1).runId})`);
  }
}
