// verify-dep-manifest.mjs — fail-closed, dependency-free, OFFLINE validator for the authoring dependency manifest
// (dep-manifest@1). Validates the SHAPE + PIN FORMAT of the manifest, not live resolution — so it is deterministic
// and gate-safe (an authoring-namespaced check() in the shared verify-local-gates runner; LBA-REQ-017). Each pinned
// dependency is either "resolved" (a concrete SHA / pip version / vipc must be present + well-formed) or "tbd-*"
// (a pin LINUX still has to verify on the VM — allowed to be empty for now, but its shape is still checked). The
// verifier NEVER clones, installs, or touches the network; an optional online-resolve mode can be layered later.
//
//   import { verifyDepManifest } from './verify-dep-manifest.mjs'
//   node experiments/labview-authoring/verify-dep-manifest.mjs [dep-manifest.json]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEP_MANIFEST_SCHEMA = 'labview-benchmark-actor/dep-manifest@1';
const VALID_PLANES = ['win', 'linux'];
const SHA40 = /^[0-9a-f]{40}$/;
const TAGLIKE = /^[\w][\w.\-/]*$/;                         // a tag/ref is an accepted alternative to a SHA
const PIP_SPEC = /^(==|~=)\d+(\.\d+)*([abrc]\d+|\.[\w]+)*$/; // a PINNED specifier (== / ~=), not a floating range
const PIN_TBD = /^tbd(-[\w-]+)?$/;                          // tbd, tbd-linux-verify, tbd-linux-owns-vipc, ...
const BITNESS = [32, 64];

const isStr = (v) => typeof v === 'string' && v.length > 0;
const planesOk = (p) => Array.isArray(p) && p.length > 0 && p.every((x) => VALID_PLANES.includes(x));
const isResolved = (pinStatus) => pinStatus == null || pinStatus === 'verified';

/**
 * Validate a dep-manifest@1 object. Pure + offline.
 * @param {object} manifest
 * @returns {{ok:boolean, errors:string[], summary:(object|null)}}
 */
export function verifyDepManifest(manifest) {
  const errors = [];
  const e = (m) => errors.push(m);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['manifest must be a JSON object'], summary: null };
  }
  if (manifest.schema !== DEP_MANIFEST_SCHEMA) {
    e(`schema must be "${DEP_MANIFEST_SCHEMA}" (got ${JSON.stringify(manifest.schema)})`);
  }
  if (!manifest.target || typeof manifest.target !== 'object') e('target object is required');

  const gitRepos = manifest.gitRepos;
  const pipTools = manifest.pipTools;
  const vipmPackages = manifest.vipmPackages;
  if (!Array.isArray(gitRepos) || gitRepos.length === 0) e('gitRepos must be a non-empty array');
  if (!Array.isArray(pipTools)) e('pipTools must be an array');
  if (!Array.isArray(vipmPackages)) e('vipmPackages must be an array');

  const checkPinStatus = (ps, w) => {
    if (ps != null && ps !== 'verified' && !PIN_TBD.test(ps)) {
      e(`${w}.pinStatus must be "verified" or "tbd..." (got ${JSON.stringify(ps)})`);
    }
  };

  for (const [i, r] of (Array.isArray(gitRepos) ? gitRepos : []).entries()) {
    const w = `gitRepos[${i}]`;
    if (!isStr(r?.name)) e(`${w}.name required`);
    if (!isStr(r?.url) || !/^https:\/\/.+\.git$/.test(r.url)) e(`${w}.url must be an https .git URL`);
    if (!isStr(r?.dest)) e(`${w}.dest required`);
    if (!planesOk(r?.planes)) e(`${w}.planes must be a non-empty subset of [${VALID_PLANES.join(', ')}]`);
    checkPinStatus(r?.pinStatus, w);
    if (isResolved(r?.pinStatus) && !(isStr(r?.pin) && (SHA40.test(r.pin) || TAGLIKE.test(r.pin)))) {
      e(`${w}.pin must be a 40-hex commit SHA or a tag for a resolved pin`);
    }
  }

  for (const [i, t] of (Array.isArray(pipTools) ? pipTools : []).entries()) {
    const w = `pipTools[${i}]`;
    if (!isStr(t?.name)) e(`${w}.name required`);
    if (!planesOk(t?.planes)) e(`${w}.planes must be a non-empty subset of [${VALID_PLANES.join(', ')}]`);
    if (!BITNESS.includes(t?.pythonBitness)) e(`${w}.pythonBitness must be 32 or 64`);
    checkPinStatus(t?.pinStatus, w);
    if (isResolved(t?.pinStatus) && !(isStr(t?.version) && PIP_SPEC.test(t.version))) {
      e(`${w}.version must be a pinned pip specifier like "==0.5.7" for a resolved pin`);
    }
  }

  for (const [i, p] of (Array.isArray(vipmPackages) ? vipmPackages : []).entries()) {
    const w = `vipmPackages[${i}]`;
    if (!isStr(p?.name)) e(`${w}.name required`);
    if (!planesOk(p?.planes)) e(`${w}.planes must be a non-empty subset of [${VALID_PLANES.join(', ')}]`);
    if (!BITNESS.includes(p?.labviewBitness)) e(`${w}.labviewBitness must be 32 or 64`);
    checkPinStatus(p?.pinStatus, w);
    if (isResolved(p?.pinStatus) && !isStr(p?.vipc) && !isStr(p?.version)) {
      e(`${w} needs a vipc path or a version for a resolved pin`);
    }
  }

  if (errors.length) return { ok: false, errors, summary: null };
  const all = [...gitRepos, ...pipTools, ...vipmPackages];
  return {
    ok: true,
    errors: [],
    summary: {
      schema: manifest.schema,
      gitRepos: gitRepos.length,
      pipTools: pipTools.length,
      vipmPackages: vipmPackages.length,
      resolved: all.filter((x) => isResolved(x.pinStatus)).length,
      tbd: all.filter((x) => !isResolved(x.pinStatus)).length,
    },
  };
}

if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/').split('/').pop() ?? '')) {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = process.argv[2] ?? join(here, 'dep-manifest.json');
  const { ok, errors, summary } = verifyDepManifest(JSON.parse(readFileSync(path, 'utf8')));
  if (ok) {
    console.log(`dep-manifest OK (${summary.resolved} resolved / ${summary.tbd} tbd): ${summary.gitRepos} gitRepos, ${summary.pipTools} pipTools, ${summary.vipmPackages} vipmPackages`);
    process.exit(0);
  }
  console.error('dep-manifest FAILED (fail-closed):');
  for (const m of errors) console.error(`  - ${m}`);
  process.exit(1);
}
