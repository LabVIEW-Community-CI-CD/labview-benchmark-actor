#!/usr/bin/env node
// lba — agent-facing governance + verification helper for labview-benchmark-actor.
//
// ============================================================================================
//  THIS TOOL IS DESIGNED TO BE ITERATIVELY REFINED.
//  Every agent that works in this repo should LEAVE THIS TOOL BETTER THAN THEY FOUND IT:
//  add a subcommand, add a governance surface, or tighten a check — then BUMP `ITERATION`.
//  The next agent expects the same. The `agent-tooling-selftest` gate keeps it working across
//  refinements, so extend freely and let the gate catch regressions.
// ============================================================================================
//
// WHY: the repetitive, error-prone parts of landing a change here are (1) the regen+verify pipeline
// (generate the derived views, then run correspondences + the full gate suite) and (2) confirming a new
// requirement is wired into EVERY governance surface. This tool collapses both into one command each.
//
// HOW TO EXTEND (extension points — keep everything dependency-free):
//   • Add a subcommand:        add an entry to COMMANDS. Each is { desc, run(args) }.
//   • Add a pipeline step:     add an entry to PIPELINE ([label, scriptRelPath]).
//   • Add a governance surface: add an entry to GOVERNANCE_SURFACES ({ label, file, has(id, text) }).
//                               `govern-check` and `selftest` pick it up automatically.
//   • Tighten the selftest:    add a case to SELFTEST.
//
// SUBCOMMANDS:
//   verify                       regen the derived views, then run correspondences + the full gate suite
//   regen                        (re)write the generated views only (traceability, test report, scorecard)
//   govern-check <LBA-REQ-NNN>   report which governance surfaces already contain a requirement id
//   next-ids                     print the next free requirement id and ADR id
//   init                         plan (or --run) the one-command First Win golden-VM onboarding (LBA-REQ-033)
//   mesh-run                     agent-drive one mesh run: ingest a live dispatch + returned receipts, then cross-plane corroborate + compare
//   release-preflight <X.Y.Z>    release doctor: node major + version + CHANGELOG + the 3 publish agreement gates
//   release <X.Y.Z> --dry-run    print the full governed-release phase plan (ordering + deps + the 2 signings) + preflight
//   release-verify-published <X.Y.Z>  confirm the VS Code Marketplace listing shows the version live after publish (#412)
//   release-cut-github <X.Y.Z> --run <id>  verify the publish-workflow run artifact + cut the immutable ext-v* release (#412)
//   signing-status               discover + report the enrolled reviewer key location + where each sign-off runs
//   selftest                     self-check this tool (run by the `agent-tooling-selftest` gate)

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { capacityWeightedPartition } from '../experiments/parallel/parallelWorkload.mjs';
import { describeFlow, analyzeFlow } from '../experiments/first-win/firstWinOnboarding.mjs';
import { ingestRun, readReturned } from '../experiments/mesh-fulfillment/meshIngest.mjs';
import { corroborateRun } from '../experiments/mesh-fulfillment/meshCorroborate.mjs';
import { assembleLiveN2 } from '../experiments/mesh-fulfillment/driveLiveN2.mjs';

export const ITERATION = 15; // bump when you refine this tool (see the banner above)

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..');
const read = (rel) => (existsSync(join(repoRoot, rel)) ? readFileSync(join(repoRoot, rel), 'utf8') : null);

// ---- the land-a-PR pipeline (the exact sequence agents run before committing) -------------------
export const PIPELINE = [
  ['regen traceability matrix', 'experiments/reqs-coverage/generate-traceability.mjs'],
  ['regen test & assurance report', 'experiments/reqs-coverage/generate-test-report.mjs'],
  ['regen benchmark grid', 'experiments/benchmark-grid/generate-benchmark-grid.mjs'],
  ['regen benchmark observatory', 'experiments/benchmark-observatory/generate-benchmark-observatory.mjs'],
  ['regen compliance scorecard', 'experiments/compliance/verify-compliance-posture.mjs'],
  ['verify correspondences', 'experiments/reqs-coverage/verify-correspondences.mjs'],
  ['verify local gates', 'experiments/verify-local-gates.mjs'],
];

// ---- the governance surfaces a Proven requirement must appear in ---------------------------------
// Each `has(id, text)` answers: does this surface already wire in requirement `id`?
export const GOVERNANCE_SURFACES = [
  { label: 'SRS register row', file: 'docs/requirements/srs.md', has: (id, t) => new RegExp(`^\\| ${id} \\|.*shall`, 'm').test(t) },
  { label: 'SRS requirement section', file: 'docs/requirements/srs.md', has: (id, t) => t.includes(`### ${id}:`) },
  { label: 'SRS traceability row', file: 'docs/requirements/srs.md', has: (id, t) => new RegExp(`^\\| ${id} \\|[^\\n]*\\| T-\\d+ \\|`, 'm').test(t) },
  { label: 'RTM row', file: 'docs/requirements/rtm.csv', has: (id, t) => new RegExp(`^${id},`, 'm').test(t) },
  { label: 'test plan item', file: 'docs/testing/test-plan.md', has: (id, t) => t.includes(`| ${id} |`) },
  { label: 'architecture view (overview.md)', file: 'docs/architecture/overview.md', has: (id, t) => t.includes(id) },
  { label: 'traceability matrix', file: 'docs/requirements/traceability-matrix.md', has: (id, t) => new RegExp(`^\\| ${id} \\|`, 'm').test(t) },
];

// ---- id helpers ---------------------------------------------------------------------------------
function maxNum(text, re) {
  let max = 0;
  for (const m of (text || '').matchAll(re)) max = Math.max(max, Number(m[1]));
  return max;
}
export function nextRequirementId() {
  const n = maxNum(read('docs/requirements/rtm.csv'), /^LBA-REQ-(\d+),/gm);
  return `LBA-REQ-${String(n + 1).padStart(3, '0')}`;
}
export function nextAdrId() {
  let max = 0;
  for (const f of readdirSync(join(repoRoot, 'docs/architecture/adr'))) {
    const m = f.match(/^ADR-(\d{4}).*\.md$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `ADR-${String(max + 1).padStart(4, '0')}`;
}

// This host's execution capabilities (for capability-aware distributed routing, ADR-0029): `node` always,
// `labview` iff LabVIEWCLI is installed. rg-free so it is safe in the gated selftest.
export function hostCapabilities() {
  const caps = ['node'];
  if (existsSync('/usr/local/bin/LabVIEWCLI')) caps.push('labview');
  return caps.sort();
}

// ---- governance completeness for one requirement id ----------------------------------------------
export function governCheck(id) {
  const results = GOVERNANCE_SURFACES.map((s) => ({ label: s.label, file: s.file, present: !!s.has(id, read(s.file) || '') }));
  const missing = results.filter((r) => !r.present);
  return { id, results, ok: missing.length === 0, missing };
}

// ---- release preflight (release doctor) ---------------------------------------------------------
// The extension publish plane is node 24 (extension-release.yml `setup-node '24'`). LESSON FROM 1.1.0: the
// .vsix is byte-reproducible ONLY WITHIN a node major -- a node-22 build has a different sha256 than a node-24
// build, so a review/candidate captured on node 22 fails the reviewed==shipped gate (verify-published-vsix).
// These pure, deterministic checks catch that (+ version/CHANGELOG drift) BEFORE a publish; the `release-preflight`
// command layers the 3 live publish agreement gates on top.
export function releasePreflightStatic({ version, nodeVersion, pkgVersion, changelog, nvmrc, compositeVersion }) {
  const major = Number(String(nodeVersion).replace(/^v/, '').split('.')[0]);
  const escaped = String(version).replace(/\./g, '\\.');
  const localNode = String(nodeVersion).replace(/^v/, '');
  const pinned = (nvmrc == null || String(nvmrc).trim() === '') ? null : String(nvmrc).trim().replace(/^v/, '');
  const checks = [];
  // node identity (#408): when a repo-root .nvmrc pins an EXACT release node version, assert the local node
  // EQUALS it (the .vsix is byte-reproducible only within a node version); otherwise fall back to major==24.
  if (pinned) {
    checks.push({ label: `node version == .nvmrc (${pinned}); .vsix repro is node-version-bound`, ok: localNode === pinned, note: `node ${nodeVersion}` });
  } else {
    checks.push({ label: 'node major is 24 (the CI publish plane; .vsix repro is node-major-bound)', ok: major === 24, note: `node ${nodeVersion}` });
  }
  checks.push({ label: `package.json version == ${version}`, ok: pkgVersion === version, note: `package.json ${pkgVersion}` });
  checks.push({ label: `CHANGELOG has a [${version}] section`, ok: new RegExp(`^## \\[${escaped}\\]`, 'm').test(changelog || ''), note: '' });
  // composite receipt is the single source of truth for the enforced version (#416): the committed receipt's
  // candidate.version must equal the release version, else the publish gates enforce a stale/mismatched version.
  if (compositeVersion !== undefined) {
    checks.push({ label: `composite receipt candidate.version == ${version}`, ok: compositeVersion === version, note: `receipt ${compositeVersion}` });
  }
  return checks;
}

// ---- release plan (#409): the full governed-release phase plan (ordering + dependencies + the 2 signings) ------
// A governed extension release is ~13 phases with an easy-to-miss ordering; missing/mis-ordering any one fails a
// downstream gate (often only at publish). `releasePlan` is the PURE, deterministic phase graph: each phase names
// its kind (auto = agent-runnable deterministically; operator = needs the enrolled reviewer / WIN station / a
// bypass token) and the earlier phases it dependsOn. The composite-assembly phase (#410) depends on ALL FIVE of
// its bound inputs (candidate build, machine attestation, quorum sign-off, WIN stage, visual verdict) -- encoding
// the cross-gate binding the composite receipt enforces. `--dry-run` renders this plan + the current static
// preflight so the operator sees the whole sequence and the two irreducible Ed25519 signings up front.
export function releasePlan(version) {
  const v = String(version);
  const phases = [
    { id: 1, key: 'cut-branch', kind: 'auto', dependsOn: [], title: `cut release/${v} from develop`, command: `git checkout -b release/${v} develop` },
    { id: 2, key: 'bump', kind: 'auto', dependsOn: [1], title: 'bump package.json + stamp CHANGELOG', command: `npm version ${v} --no-git-tag-version  +  stamp CHANGELOG.md [${v}]` },
    { id: 3, key: 'build-vsix', kind: 'auto', dependsOn: [2], title: 'build the node-24 candidate .vsix + capture its sha256', command: 'npm run package  +  sha256sum labview-benchmark-actor.vsix' },
    { id: 4, key: 'dispatch-corroboration', kind: 'auto', dependsOn: [3], title: 'dispatch acg-cross-plane-corroboration.yml at the candidate commit', command: 'gh workflow run acg-cross-plane-corroboration.yml --ref <candidate-commit>' },
    { id: 5, key: 'build-attestation', kind: 'auto', dependsOn: [4], title: 'build the machine attestation from the run witnesses', command: 'node experiments/acg-quorum/cross-plane-attestation.mjs  (from the corroboration run artifacts)' },
    { id: 6, key: 'quorum-signoff', kind: 'operator', signing: true, dependsOn: [5], title: 'Ed25519 quorum sign-off over the attestation (enrolled key)', command: 'lba signing-status  ->  sign-release-quorum.mjs in the VM (#415 render-quorum.sh)' },
    { id: 7, key: 'stage-benchmark', kind: 'operator', dependsOn: [3], title: 'stage + live-benchmark the candidate on the WIN VM (net DONE frame)', command: 'reviewer-workstation/render-verdict.sh set-target --version ' + v + ' … (#411)' },
    { id: 8, key: 'visual-verdict', kind: 'operator', signing: true, dependsOn: [7], title: 'signed reviewer visual verdict of the built candidate (Ed25519)', command: 'run "Render Reviewer Verdict" in the VM  ->  render-verdict.sh collect' },
    { id: 9, key: 'assemble-composite', kind: 'auto', dependsOn: [3, 5, 6, 7, 8], title: 'assemble the composite-release-decision receipt (binds all pieces to one candidate)', command: 'node reviewer-workstation/assemble-composite.mjs --component extension --version ' + v + ' … --out reviewer-workstation/composite-release-decision-receipt.json (#410)' },
    { id: 10, key: 'record-agreement', kind: 'auto', dependsOn: [9], title: 'record WIN+LINUX agreed + visualReview in release-agreement.json', command: 'node tools/collab-cli/record-release-agreement.mjs … (#419)' },
    { id: 11, key: 'merge-main', kind: 'auto', dependsOn: [10], title: `merge release/${v} -> main (--no-ff)`, command: `gh pr merge <n> --merge  (release/${v} -> main, --no-ff)` },
    { id: 12, key: 'cut-gh-release', kind: 'operator', dependsOn: [11], title: 'tag + workflow_dispatch extension-release.yml + cut the immutable GitHub Release', command: `gh workflow run extension-release.yml  ->  gh release create ext-v${v} staging/* (bypass token) (#412)` },
    { id: 13, key: 'publish-backmerge', kind: 'operator', dependsOn: [12], title: 'vsce publish + back-merge to develop (--no-ff)', command: `vsce publish  ->  git merge --no-ff release/${v} into develop (#417)` },
  ];
  return { version: v, phases };
}

// Fail-closed structural check over a release plan: unique ids, every dependency references an EARLIER phase (so
// the array is a valid topological order), and exactly the two Ed25519 signings (quorum + visual) are present.
// Returns an array of problems -- empty iff the plan is well-formed.
export function releasePlanIssues(plan) {
  const problems = [];
  const phases = plan?.phases ?? [];
  const ids = new Set();
  for (const p of phases) {
    if (ids.has(p.id)) problems.push(`duplicate phase id ${p.id}`);
    ids.add(p.id);
  }
  for (const p of phases) {
    for (const d of p.dependsOn ?? []) {
      if (!ids.has(d)) problems.push(`phase ${p.id} (${p.key}) names an unknown dependency ${d}`);
      else if (d >= p.id) problems.push(`phase ${p.id} (${p.key}) has a forward dependency ${d} (a dependency must precede its dependent)`);
    }
  }
  const signings = phases.filter((p) => p.signing);
  if (signings.length !== 2) problems.push(`expected exactly 2 Ed25519 signings (quorum + visual), found ${signings.length}`);
  return problems;
}

// Pure renderer: the phase plan as a readable, numbered checklist with a kind legend + a per-phase command. No I/O.
export function renderReleasePlan(plan) {
  const badge = { auto: 'auto    ', operator: 'OPERATOR' };
  const lines = [];
  lines.push(`governed release plan for ${plan.version}  (${plan.phases.length} phases; the 2 Ed25519 signings are the irreducible human gates)`);
  lines.push('  legend: [auto] agent-runnable deterministically   [OPERATOR] needs the enrolled reviewer / WIN station / release token   (*) Ed25519 signing');
  for (const p of plan.phases) {
    const deps = (p.dependsOn ?? []).length ? ` (after ${p.dependsOn.join(', ')})` : '';
    lines.push(`  ${String(p.id).padStart(2)}. [${badge[p.kind] ?? p.kind}]${p.signing ? ' *' : '  '} ${p.title}${deps}`);
    lines.push(`        ${p.command}`);
  }
  return lines.join('\n');
}

// ---- release-verify-published (#412): confirm the Marketplace listing shows the released version live ----------
// The last mile of a release is off-CI + easy to get subtly wrong; after `vsce publish` nothing confirmed the
// PUBLIC Marketplace listing actually shows the new version. `assertPublished` is a PURE check over a gallery
// extensionquery result; the fetch is the command's live leg. Fails closed unless the queried extension matches the
// expected publisher+name AND lists the target version.
export function assertPublished(queryResult, { publisher, name, version } = {}) {
  const ext = queryResult?.results?.[0]?.extensions?.[0] ?? null;
  if (!ext) return { ok: false, live: false, versions: [], latest: null, reason: 'no extension in the Marketplace query result' };
  const reasons = [];
  const pub = ext.publisher?.publisherName ?? ext.publisher?.publisherId ?? '';
  const nm = ext.extensionName ?? '';
  if (publisher && String(pub).toLowerCase() !== String(publisher).toLowerCase()) reasons.push(`publisher "${pub}" != "${publisher}"`);
  if (name && String(nm).toLowerCase() !== String(name).toLowerCase()) reasons.push(`extension "${nm}" != "${name}"`);
  const versions = Array.isArray(ext.versions) ? ext.versions.map((v) => String(v.version)) : [];
  const live = versions.includes(String(version));
  if (!live) reasons.push(`version ${version} is not live on the Marketplace (latest: ${versions[0] ?? 'none'})`);
  return { ok: reasons.length === 0, live, versions, latest: versions[0] ?? null, reason: reasons.join('; ') };
}

// Live leg: POST the VS Code Marketplace gallery extensionquery for one extension. `fetchImpl` is injectable so the
// pure path stays testable; defaults to the global fetch (Node 18+).
export async function queryMarketplaceExtension({ publisher, name, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=7.2-preview.1' },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: `${publisher}.${name}` }] }], flags: 914 }),
  });
  if (!res.ok) throw new Error(`Marketplace query failed: HTTP ${res.status}`);
  return res.json();
}

// ---- release-cut-github (#412): turn a green extension-release.yml run artifact into the immutable GH release ----
// The publish workflow uploads the signed .vsix + its sigstore bundle (+ the reviewer verdict) as a run ARTIFACT --
// it CANNOT push the ext-v* tag (the org ruleset blocks it), so a maintainer cuts the immutable release locally with
// an authorized bypass token. verifyReleaseAssets is a PURE fail-closed check that the downloaded artifact set is
// COMPLETE before cutting; the gh download + gh release create are the command's live/operator legs.
export function verifyReleaseAssets(fileNames, { version } = {}) {
  const base = (fileNames || []).map((f) => String(f).split('/').pop());
  const reasons = [];
  const vsix = base.filter((f) => /\.vsix$/i.test(f));
  if (vsix.length === 0) reasons.push('no signed .vsix in the artifact');
  const hasSigstore = base.some((f) => /\.sigstore(\.json)?$/i.test(f)) || (base.some((f) => /\.pem$/i.test(f)) && base.some((f) => /\.sig$/i.test(f)));
  if (!hasSigstore) reasons.push('no sigstore bundle (.sigstore/.sigstore.json, or .pem + .sig)');
  const hasVerdict = base.some((f) => /verdict.*\.json$/i.test(f));
  if (!hasVerdict) reasons.push('no reviewer verdict (*verdict*.json)');
  return { ok: reasons.length === 0, reasons, vsix: vsix[0] ?? null, tag: version ? `ext-v${version}` : null };
}

// ---- signing status (#414): discover + report WHERE each release sign-off must run ---------------
// The two operator Ed25519 sign-offs run WHERE the enrolled reviewer key lives. The VISUAL verdict is always
// signed IN the reviewer VM by the extension (it reads labviewBenchmarkActor.reviewerKeyPath there). The QUORUM
// sign-off is a CLI (sign-release-quorum.mjs) that needs an explicit --key <path>; if the enrolled key lives in
// the VM (the common case), the quorum sign-off MUST run in the VM too, not on the host. Surfacing that binding
// stops a release from stalling at "I don't know my enrolled key on this host" (hit live in 1.1.1). The pure
// functions below are deterministic + selftestable; the private key material is NEVER read or printed -- only
// its path + existence + (optionally) the enrollment of its PUBLIC key.
export const STATIONS = { VM: 'WINDOWS_VM', HOST: 'HOST', UNKNOWN: 'UNKNOWN' };

// The enrolled reviewer allowlist (reviewer id -> Ed25519 SPKI public-key PEM). Only PUBLIC material.
export function readReviewerAllowlist() {
  try {
    const raw = JSON.parse(read('tools/collab-cli/reviewer-allowlist.json') || '{}');
    const out = {};
    for (const [k, v] of Object.entries(raw)) if (k !== '_comment' && typeof v === 'string') out[k] = v;
    return out;
  } catch { return {}; }
}

// The exact quorum + visual sign commands, BOUND to the station where the key lives.
export function signingCommands({ station, reviewerId, reviewerKeyPath, version } = {}) {
  const ver = version || 'X.Y.Z';
  const id = reviewerId || '<reviewer-id>';
  const keyPath = reviewerKeyPath || '<enrolled-key.pem>';
  // The visual verdict is ALWAYS rendered + signed in the VM (the extension reads reviewerKeyPath there).
  const visual = `LBA_VM_PASS=… reviewer-workstation/render-verdict.sh set-target --version ${ver} --commit <sha> --vsix-sha256 <sha256>  →  run "Render Reviewer Verdict" in the VM  →  reviewer-workstation/render-verdict.sh collect --version ${ver} --out ~/lba-vm-share/visual-verdict-${ver}.json`;
  let quorum;
  if (station === STATIONS.VM) {
    // Key lives in the VM -> sign IN the VM. Invoke via `cmd /c` from the repo clone so guestcontrol does not
    // eat node's argv[0] as the main module (the MODULE_NOT_FOUND gotcha to be wrapped by render-quorum.sh, #415).
    quorum = `VBoxManage guestcontrol actor --username vagrant --password "$LBA_VM_PASS" run --exe 'C:\\Windows\\System32\\cmd.exe' --wait-stdout --wait-stderr -- cmd /c "cd /d C:\\lba-validate\\repo && node reviewer-workstation\\sign-release-quorum.mjs --key ${keyPath} --reviewer ${id} --station WINDOWS_VM --quorum <attestation-${ver}.json> --out <quorum-signoff-${ver}.json>"`;
  } else {
    // Key lives on this host -> sign on the host directly.
    quorum = `node reviewer-workstation/sign-release-quorum.mjs --key ${keyPath} --reviewer ${id} --station LINUX_CODESPACE --quorum ~/lba-vm-share/attestation-${ver}.json --out ~/lba-vm-share/quorum-signoff-${ver}.json`;
  }
  return { visual, quorum };
}

// Pure signing-status report: given the discovered {reviewerId, reviewerKeyPath, keyExists, station} + the
// enrolled public key (from the allowlist) and optionally the presented public key, decide fail-closed problems.
export function signingStatus({ reviewerId, reviewerKeyPath, keyExists, station, enrolledPublicKey, presentedPublicKey, version } = {}) {
  const problems = [];
  const id = String(reviewerId || '').trim();
  const st = station || STATIONS.UNKNOWN;
  const enrolled = enrolledPublicKey != null && String(enrolledPublicKey).trim() !== '';
  const norm = (k) => String(k || '').replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
  let keyMatch = 'unknown';
  if (presentedPublicKey != null && enrolled) keyMatch = norm(presentedPublicKey) === norm(enrolledPublicKey) ? 'match' : 'mismatch';

  if (!id) problems.push('no reviewerId configured (set labviewBenchmarkActor.reviewerId in the reviewer VM)');
  if (st === STATIONS.UNKNOWN) problems.push('could not locate the signing station or the enrolled key (VM not reachable and no host key configured)');
  else if (keyExists === false) problems.push(`enrolled key not found at ${reviewerKeyPath || '<unset>'} on ${st}`);
  if (id && !enrolled) problems.push(`reviewer ${id} is not enrolled in tools/collab-cli/reviewer-allowlist.json`);
  if (keyMatch === 'mismatch') problems.push(`the presented public key does not match the enrolled allowlist entry for ${id}`);

  const commands = signingCommands({ station: st, reviewerId: id, reviewerKeyPath, version });
  return {
    reviewerId: id,
    reviewerKeyPath: reviewerKeyPath || null,
    keyExists: keyExists === undefined ? null : keyExists,
    station: st,
    enrolled,
    keyMatch,
    commands,
    problems,
    ok: problems.length === 0,
  };
}

// Impure discovery: find the enrolled key + its station. Best-effort + fail-soft (never throws): host env first
// (LBA_REVIEWER_ID + LBA_REVIEWER_KEY for a host-resident key), then the reviewer VM's VS Code settings.json via
// `VBoxManage guestcontrol` when LBA_VM_PASS is set + the VM is reachable. Reads only the key PATH, never the key.
export function discoverSigningStation({ env = process.env, run } = {}) {
  const vm = env.LBA_VM_NAME || 'actor';
  const user = env.LBA_VM_USER || 'vagrant';
  const pass = env.LBA_VM_PASS;
  const exec = run || ((file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  // 1) explicit host config: an enrolled key that lives on THIS host.
  const hostId = String(env.LBA_REVIEWER_ID || '').trim();
  const hostKey = String(env.LBA_REVIEWER_KEY || '').trim();
  if (hostId && hostKey) {
    return { reviewerId: hostId, reviewerKeyPath: hostKey, keyExists: existsSync(hostKey), station: STATIONS.HOST, source: 'host env (LBA_REVIEWER_ID + LBA_REVIEWER_KEY)' };
  }
  // 2) the reviewer VM: read its VS Code settings.json for reviewerId + reviewerKeyPath, then probe the key.
  if (pass) {
    try {
      const settings = `C:\\Users\\${user}\\AppData\\Roaming\\Code\\User\\settings.json`;
      const gc = (inner) => exec('VBoxManage', ['guestcontrol', vm, '--username', user, '--password', pass, 'run', '--exe', 'C:\\Windows\\System32\\cmd.exe', '--wait-stdout', '--', 'cmd', '/c', inner]);
      const cfg = JSON.parse(gc(`type "${settings}"`));
      const reviewerId = String(cfg['labviewBenchmarkActor.reviewerId'] || '').trim();
      const reviewerKeyPath = String(cfg['labviewBenchmarkActor.reviewerKeyPath'] || '').trim();
      let keyExists = null;
      if (reviewerKeyPath) {
        try { keyExists = /(^|\s)YES(\s|$)/.test(gc(`if exist "${reviewerKeyPath}" (echo YES) else (echo NO)`)); } catch { keyExists = null; }
      }
      return { reviewerId, reviewerKeyPath: reviewerKeyPath || null, keyExists, station: STATIONS.VM, source: `reviewer VM "${vm}" VS Code settings.json` };
    } catch { /* VM not reachable / VBoxManage absent -> fall through to UNKNOWN */ }
  }
  return { reviewerId: '', reviewerKeyPath: null, keyExists: null, station: STATIONS.UNKNOWN, source: 'none (set LBA_VM_PASS for the VM, or LBA_REVIEWER_ID + LBA_REVIEWER_KEY for a host key)' };
}

// ---- agent-driven mesh run: chain the governed stages over one dispatch + returned receipts -------
// dispatch (LBA-REQ-074) + returned receipts (agent handoff) --ingest(LBA-REQ-091)--> run-bound collection
//   --corroborate(LBA-REQ-092)--> cross-plane verdict + compare. Pure: chains the governed engines, adds no gating.
export function driveMeshRun({ dispatch, returned, benchmarkId } = {}) {
  const ingest = ingestRun({ dispatch, returned });
  const cor = corroborateRun({ collection: ingest.collection, benchmarkId: benchmarkId || dispatch?.benchmarkId });
  const findings = [...ingest.findings.map((f) => `ingest: ${f}`), ...cor.findings.map((f) => `corroborate: ${f}`)];
  return { ok: ingest.ok && cor.ok, findings, ingest, corroboration: cor.corroboration, comparison: cor.comparison, report: cor.report };
}

// ---- subcommands --------------------------------------------------------------------------------
function runScript(label, rel) {
  process.stdout.write(`\n▶ ${label}  (${rel})\n`);
  execFileSync(process.execPath, [join(repoRoot, rel)], { stdio: 'inherit' });
}

export const COMMANDS = {
  regen: {
    desc: 'regen the generated views only (traceability, test report, scorecard)',
    run: () => { for (const [label, rel] of PIPELINE.slice(0, 3)) runScript(label, rel); },
  },
  verify: {
    desc: 'regen the derived views, then run correspondences + the full gate suite',
    run: () => { for (const [label, rel] of PIPELINE) runScript(label, rel); console.log('\n✓ verify pipeline complete'); },
  },
  'govern-check': {
    desc: 'report which governance surfaces already contain a requirement id',
    run: (args) => {
      const id = args[0];
      if (!/^LBA-REQ-\d+$/.test(id || '')) { console.error('usage: lba govern-check LBA-REQ-NNN'); process.exit(2); }
      const r = governCheck(id);
      for (const s of r.results) console.log(`  ${s.present ? '✓' : '✗'} ${s.label}  (${s.file})`);
      console.log(r.ok ? `\n✓ ${id} is wired into all ${r.results.length} governance surfaces` : `\n✗ ${id} is MISSING from ${r.missing.length}: ${r.missing.map((m) => m.label).join(', ')}`);
      if (!r.ok) process.exit(1);
    },
  },
  'next-ids': {
    desc: 'print the next free requirement id and ADR id',
    run: () => { console.log(`next requirement: ${nextRequirementId()}`); console.log(`next ADR:         ${nextAdrId()}`); },
  },
  'release-preflight': {
    desc: 'release doctor: node major + version + CHANGELOG + the 3 publish agreement gates for a target version',
    run: (args) => {
      const version = args[0];
      if (!/^\d+\.\d+\.\d+/.test(version || '')) { console.error('usage: lba release-preflight X.Y.Z'); process.exit(2); }
      const statics = releasePreflightStatic({
        version,
        nodeVersion: process.version,
        pkgVersion: JSON.parse(read('package.json')).version,
        changelog: read('CHANGELOG.md'),
        nvmrc: read('.nvmrc'),
        compositeVersion: (() => { try { return JSON.parse(read('reviewer-workstation/composite-release-decision-receipt.json')).candidate.version; } catch { return undefined; } })(),
      });
      const gates = [
        ['release-agreement WIN+LINUX agreed', 'tools/collab-cli/verify-release-agreement.mjs'],
        ['signed reviewer visual verdict', 'tools/collab-cli/verify-visual-review.mjs'],
        ['composite release decision', 'tools/collab-cli/verify-composite-release.mjs'],
      ].map(([label, rel]) => {
        let ok = false;
        try { execFileSync(process.execPath, [join(repoRoot, rel), '--component', 'extension', version], { stdio: 'pipe' }); ok = true; } catch { ok = false; }
        return { label, ok, note: ok ? '' : 'not yet satisfied' };
      });
      const all = [...statics, ...gates];
      for (const c of all) console.log(`  ${c.ok ? '\u2713' : '\u2717'} ${c.label}${c.note ? '  (' + c.note + ')' : ''}`);
      // signing readiness (#414): surface a missing/unknown enrolled key BEFORE the release stalls at sign-off.
      // A concrete key/enrollment problem fails preflight; an UNKNOWN station (no VM reachable on this host) is a
      // non-fatal warning (discovery is environment-dependent), not a hard fail.
      const disc = discoverSigningStation();
      const allow = readReviewerAllowlist();
      const signing = signingStatus({ ...disc, enrolledPublicKey: disc.reviewerId ? allow[disc.reviewerId] : null, version });
      // When the station can't be discovered on this host (no VM reachable, no host key), the whole signing block
      // is advisory -- surfaced as a warning, not a hard fail. Only a KNOWN station with a concrete key/enrollment
      // problem (key missing, reviewer not enrolled, public-key mismatch) fails preflight.
      const stationKnown = signing.station !== STATIONS.UNKNOWN;
      if (signing.ok) console.log(`  \u2713 signing key locatable + enrolled (${signing.reviewerId} @ ${signing.station})`);
      else if (stationKnown) console.log(`  \u2717 signing not ready: ${signing.problems.join('; ')}`);
      else console.log(`  \u26a0 signing station unknown on this host (run \`lba signing-status\` where the VM/key lives)`);
      const failed = all.filter((c) => !c.ok);
      const signingFail = stationKnown && !signing.ok;
      const total = failed.length + (signingFail ? 1 : 0);
      console.log(total ? `\n\u2717 release ${version} NOT ready (${total} check(s) failing)` : `\n\u2713 release ${version} preflight all green`);
      if (total) process.exit(1);
    },
  },
  release: {
    desc: 'plan a governed release: --dry-run prints the full phase plan (ordering + deps + the 2 signings) + preflight (#409)',
    run: (args) => {
      const version = args.find((a) => !a.startsWith('--'));
      if (!/^\d+\.\d+\.\d+/.test(version || '')) { console.error('usage: lba release X.Y.Z --dry-run'); process.exit(2); }
      const plan = releasePlan(version);
      const issues = releasePlanIssues(plan);
      if (issues.length) { console.error(`\u2717 internal: release plan malformed: ${issues.join('; ')}`); process.exit(1); }
      if (!args.includes('--dry-run')) {
        console.log('lba release is PLAN-ONLY today. Re-run with --dry-run to see the full phase plan + preflight status.');
        console.log('Live execution composes the operator-gated signings (#411/#415) + the auto-cut release (#412); until those land, drive a release via docs/release/release-runbook.md.');
        return;
      }
      console.log(renderReleasePlan(plan));
      const statics = releasePreflightStatic({
        version,
        nodeVersion: process.version,
        pkgVersion: JSON.parse(read('package.json')).version,
        changelog: read('CHANGELOG.md'),
        nvmrc: read('.nvmrc'),
        compositeVersion: (() => { try { return JSON.parse(read('reviewer-workstation/composite-release-decision-receipt.json')).candidate.version; } catch { return undefined; } })(),
      });
      console.log(`\ncurrent static preflight (run \`lba release-preflight ${version}\` for the live agreement + signing gates):`);
      for (const c of statics) console.log(`  ${c.ok ? '\u2713' : '\u2717'} ${c.label}${c.note ? '  (' + c.note + ')' : ''}`);
      console.log('\nthe two irreducible human gates are phases 6 (quorum sign-off) + 8 (visual verdict); everything else is agent-runnable.');
    },
  },
  'release-verify-published': {
    desc: 'confirm the VS Code Marketplace listing shows X.Y.Z live after publish (#412)',
    run: async (args) => {
      const version = args.find((a) => !a.startsWith('--'));
      if (!/^\d+\.\d+\.\d+/.test(version || '')) { console.error('usage: lba release-verify-published X.Y.Z [--extension <publisher.name>]'); process.exit(2); }
      const extIdx = args.indexOf('--extension');
      const pkg = JSON.parse(read('package.json'));
      const extId = extIdx >= 0 && args[extIdx + 1] ? args[extIdx + 1] : `${pkg.publisher}.${pkg.name}`;
      const [publisher, name] = extId.split('.');
      try {
        const q = await queryMarketplaceExtension({ publisher, name });
        const r = assertPublished(q, { publisher, name, version });
        if (!r.ok) { console.error(`\u2717 ${extId} ${version} NOT confirmed live: ${r.reason}`); process.exit(1); }
        console.log(`\u2713 ${extId} ${version} is LIVE on the Marketplace (latest ${r.latest}; recent: ${r.versions.slice(0, 5).join(', ')})`);
      } catch (e) { console.error(`\u2717 Marketplace query error: ${e.message}`); process.exit(1); }
    },
  },
  'release-cut-github': {
    desc: 'verify a green extension-release.yml run artifact + cut the immutable ext-v* GitHub Release (#412)',
    run: (args) => {
      const version = args.find((a) => !a.startsWith('--'));
      if (!/^\d+\.\d+\.\d+/.test(version || '')) { console.error('usage: lba release-cut-github X.Y.Z (--run <id> | --dir <artifactdir>) [--create]'); process.exit(2); }
      const dirIdx = args.indexOf('--dir'); const runIdx = args.indexOf('--run');
      let dir = dirIdx >= 0 ? args[dirIdx + 1] : null;
      if (!dir) {
        if (runIdx < 0) { console.error('provide --dir <artifactdir> or --run <run-id>'); process.exit(2); }
        dir = execFileSync('mktemp', ['-d']).toString().trim();
        execFileSync('gh', ['run', 'download', String(args[runIdx + 1]), '--dir', dir], { stdio: 'inherit' });
      }
      const files = readdirSync(dir, { recursive: true }).map((f) => join(dir, String(f)));
      const r = verifyReleaseAssets(files, { version });
      if (!r.ok) { console.error(`\u2717 artifact for ${version} is incomplete: ${r.reasons.join('; ')}`); process.exit(1); }
      const assets = files.filter((f) => /\.(vsix|sigstore|sigstore\.json|json|pem|sig)$/i.test(f));
      const quoted = assets.map((a) => `'${a}'`).join(' ');
      if (!args.includes('--create')) {
        console.log(`\u2713 artifact verified for ${r.tag} (vsix ${String(r.vsix)}). DRY-RUN -- re-run with --create (needs your authorized bypass token) to cut it:`);
        console.log(`  gh release create ${r.tag} ${quoted} --title '${r.tag}' --notes 'Immutable release ${version}.'`);
        return;
      }
      execFileSync('gh', ['release', 'create', r.tag, ...assets, '--title', r.tag, '--notes', `Immutable release ${version}.`], { stdio: 'inherit' });
      console.log(`\u2713 cut ${r.tag} with ${assets.length} asset(s).`);
    },
  },
  'signing-status': {
    desc: 'discover + report the enrolled reviewer key location + WHERE each release sign-off must run (#414)',
    run: (args) => {
      const opt = {};
      for (let i = 0; i < args.length; i += 1) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[(i += 1)] : true;
      const version = typeof opt.version === 'string' ? opt.version : undefined;
      const disc = discoverSigningStation();
      const allow = readReviewerAllowlist();
      const s = signingStatus({ ...disc, enrolledPublicKey: disc.reviewerId ? allow[disc.reviewerId] : null, version });
      console.log('signing status (#414) — the two operator Ed25519 sign-offs run WHERE the enrolled key lives:\n');
      console.log(`  reviewerId    : ${s.reviewerId || '(none)'}`);
      console.log(`  reviewerKey   : ${s.reviewerKeyPath || '(unknown)'}`);
      console.log(`  keyExists     : ${s.keyExists === null ? '(unknown)' : s.keyExists}`);
      console.log(`  station       : ${s.station}  (${disc.source})`);
      console.log(`  enrolled      : ${s.enrolled ? 'yes' : 'no'}${s.keyMatch !== 'unknown' ? ` (public-key ${s.keyMatch})` : ''}  [tools/collab-cli/reviewer-allowlist.json]`);
      console.log(`\n  quorum sign-off (machine consensus) — run on ${s.station === STATIONS.VM ? 'the reviewer VM' : s.station === STATIONS.HOST ? 'this host' : 'the station where the key lives'}:\n    ${s.commands.quorum}`);
      console.log(`\n  visual verdict (human PASS) — always rendered + signed in the reviewer VM:\n    ${s.commands.visual}`);
      if (s.ok) { console.log(`\n\u2713 signing ready: ${s.reviewerId} enrolled, key present at ${s.reviewerKeyPath} on ${s.station}`); return; }
      console.log(`\n\u2717 signing NOT ready (${s.problems.length}):`);
      for (const p of s.problems) console.log(`  - ${p}`);
      process.exit(1);
    },
  },
  partition: {
    desc: 'deterministically split the self-test workload into N shards (for parallel/distributed runs)',
    run: (args) => {
      const n = Math.max(2, Number(args[0] || 2));
      const tasks = execFileSync('rg', ['--files', 'experiments'], { cwd: repoRoot, encoding: 'utf8' }).split(/\r?\n/).filter((l) => /\.selftest\.mjs$/.test(l));
      capacityWeightedPartition(tasks, Array.from({ length: n }, () => ({ weight: 1 }))).forEach((s, i) => console.log(`shard ${i}: ${s.length} tasks`));
      console.log(`(${tasks.length} self-tests over ${n} shards — run with experiments/parallel/runParallel.mjs)`);
    },
  },
  caps: {
    desc: "print this host's execution capabilities (labview iff LabVIEWCLI present, node)",
    run: () => console.log(hostCapabilities().join(', ')),
  },
  selftest: {
    desc: 'self-check this tool (run by the agent-tooling-selftest gate)',
    run: () => runSelftest(),
  },
  init: {
    desc: 'plan (or --run) the one-command First Win: personal golden-VM onboarding (LBA-REQ-033)',
    run: (args) => {
      const exists = (rel) => existsSync(join(repoRoot, rel));
      console.log(describeFlow(exists));
      const a = analyzeFlow(exists);
      if (!a.allResolved) { console.error(`\n\u2717 missing realizations: ${a.missing.join(', ')}`); process.exit(1); }
      if (!args.includes('--run')) { console.log('\n(plan only \u2014 re-run with `lba init --run` to provision; set ISO / VM_NAME / BASEFOLDER first)'); return; }
      console.log('\n\u25b6 provisioning the golden VM (cleanroom/ubuntu-labview/build-virtualbox.sh --run)\u2026');
      execFileSync('bash', [join(repoRoot, 'cleanroom/ubuntu-labview/build-virtualbox.sh'), '--run'], { stdio: 'inherit' });
      console.log('\nNEXT (hybrid \u2014 the one human step): activate LabVIEW CE + VIPM in the VM, then confirm + register:');
      console.log('  bash experiments/activation/probe-activation.sh      # headless RunVI probe -> activation-receipt@1');
      console.log('  node experiments/activation/registerMeshActor.mjs    # mint + register the VM as a mesh actor');
    },
  },
  'mesh-run': {
    desc: 'agent-drive one mesh run: ingest a live dispatch + returned receipts, then cross-plane corroborate + compare',
    run: (args) => {
      const opt = {};
      for (let i = 0; i < args.length; i += 1) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[(i += 1)] : true;
      if (typeof opt.dispatch !== 'string' || typeof opt.returned !== 'string') {
        console.error('usage: lba mesh-run --dispatch <dispatch@1.json> --returned <returned-receipts-dir> [--out <report.json>]');
        console.error('  demo: lba mesh-run --dispatch experiments/mesh-fulfillment/mesh-run-dispatch-request.json --returned experiments/mesh-fulfillment/returned-demo');
        process.exit(2);
      }
      const dispatch = JSON.parse(readFileSync(resolve(repoRoot, opt.dispatch), 'utf8'));
      const returned = readReturned(resolve(repoRoot, opt.returned));
      const r = driveMeshRun({ dispatch, returned });
      if (typeof opt.out === 'string') writeFileSync(resolve(repoRoot, opt.out), `${JSON.stringify(r.report, null, 2)}\n`);
      if (!r.ok) { console.error(`\u2717 mesh-run FAILED (dispatch ${dispatch?.dispatchId})`); for (const f of r.findings) console.error(`  - ${f}`); process.exit(1); }
      const d = r.comparison?.deltas?.latest;
      console.log(`\u2713 mesh-run OK: dispatch ${dispatch.dispatchId} \u2014 ingested ${returned.length} receipt(s), cross-plane corroborated across [${r.report.planes.join(', ')}] (all PASS, identity-bound)`);
      if (d) console.log(`  compare: latest launch WIN\u2212LINUX = ${d.delta}ms (${d.pctOfLinux}% of LINUX baseline)`);
    },
  },
  'mesh-live': {
    desc: 'agent-drive the FULL live N=2: run BOTH plane trends, wrap receipts, then cross-plane corroborate + compare (needs both live actor VMs)',
    run: () => runScript('live N-actor mesh (run every rostered actor -> corroborate)', 'experiments/mesh-fulfillment/driveLiveN2.mjs'),
  },
};

// ---- selftest (extend me) -----------------------------------------------------------------------
const SELFTEST = [
  ['every pipeline script exists', () => PIPELINE.every(([, rel]) => existsSync(join(repoRoot, rel)))],
  ['every governance-surface file exists', () => GOVERNANCE_SURFACES.every((s) => existsSync(join(repoRoot, s.file)))],
  ['next requirement id is greater than the current max', () => {
    const cur = maxNum(read('docs/requirements/rtm.csv'), /^LBA-REQ-(\d+),/gm);
    return Number(nextRequirementId().match(/(\d+)$/)[1]) === cur + 1;
  }],
  ['next ADR id is well-formed and unused', () => /^ADR-\d{4}$/.test(nextAdrId()) && !existsSync(join(repoRoot, 'docs/architecture/adr', `${nextAdrId()}.md`))],
  ['govern-check confirms a modern fully-governed requirement across all surfaces', () => governCheck('LBA-REQ-034').ok],
  ['govern-check fails closed for a non-existent requirement', () => governCheck('LBA-REQ-999').ok === false],
  ['release-preflight static checks pass for a consistent node-24 / version / CHANGELOG set', () => {
    const c = releasePreflightStatic({ version: '1.1.1', nodeVersion: 'v24.19.0', pkgVersion: '1.1.1', changelog: '## [1.1.1] - 2026-08-05\n' });
    return c.length === 3 && c.every((x) => x.ok);
  }],
  ['release-preflight static checks fail closed on a node-22 build + version + CHANGELOG mismatch', () => {
    const c = releasePreflightStatic({ version: '1.1.1', nodeVersion: 'v22.22.1', pkgVersion: '1.1.0', changelog: '## [1.1.0]\n' });
    return c.length === 3 && c.every((x) => !x.ok);
  }],
  ['release-preflight pins the EXACT node version when .nvmrc is present (#408): equal clears, a different 24.x fails', () => {
    const base = { version: '1.1.1', pkgVersion: '1.1.1', changelog: '## [1.1.1]\n', nvmrc: '24.19.0\n' };
    const equal = releasePreflightStatic({ ...base, nodeVersion: 'v24.19.0' });
    const drift = releasePreflightStatic({ ...base, nodeVersion: 'v24.20.0' }); // a later 24.x minor
    return equal[0].ok === true && drift[0].ok === false && /node version == \.nvmrc/.test(equal[0].label);
  }],
  ['release-preflight enforces the committed composite receipt version == release version (#416)', () => {
    const base = { nodeVersion: 'v24.19.0', pkgVersion: '1.1.1', changelog: '## [1.1.1]\n', nvmrc: '24.19.0' };
    const match = releasePreflightStatic({ ...base, version: '1.1.1', compositeVersion: '1.1.1' });
    const stale = releasePreflightStatic({ ...base, version: '1.1.1', compositeVersion: '1.1.0' });
    return match.length === 4 && match.every((x) => x.ok) && stale[3].ok === false;
  }],
  ['release plan (#409) is well-formed: unique ids, deps precede dependents, exactly two Ed25519 signings', () => {
    const p = releasePlan('1.2.0');
    return releasePlanIssues(p).length === 0 && p.phases.filter((x) => x.signing).length === 2 && p.phases.length === 13;
  }],
  ['release plan (#409) orders the composite assembly after ALL FIVE of its bound inputs (candidate/attestation/quorum/stage/visual)', () => {
    const p = releasePlan('1.2.0');
    const comp = p.phases.find((x) => x.key === 'assemble-composite');
    return comp.dependsOn.length === 5 && comp.dependsOn.every((d) => d < comp.id);
  }],
  ['release plan (#409) fails closed on a forward/unknown dependency (releasePlanIssues catches mis-ordering)', () => {
    const p = releasePlan('1.2.0');
    p.phases[1].dependsOn = [99]; // unknown
    p.phases[2].dependsOn = [12]; // forward
    const problems = releasePlanIssues(p);
    return problems.some((f) => /unknown dependency/.test(f)) && problems.some((f) => /forward dependency/.test(f));
  }],
  ['release --dry-run render (#409) is pure + names the version, the OPERATOR signings, and the #410 assembler command', () => {
    const out = renderReleasePlan(releasePlan('1.2.0'));
    return /release\/1\.2\.0 from develop/.test(out) && /OPERATOR/.test(out) && /assemble-composite\.mjs/.test(out) && /Ed25519 signings/.test(out);
  }],
  ['release-verify-published (#412) confirms a version present in the Marketplace query result', () => {
    const q = { results: [{ extensions: [{ publisher: { publisherName: 'pub' }, extensionName: 'ext', versions: [{ version: '1.2.0' }, { version: '1.1.1' }] }] }] };
    const r = assertPublished(q, { publisher: 'pub', name: 'ext', version: '1.2.0' });
    return r.ok === true && r.live === true && r.latest === '1.2.0';
  }],
  ['release-verify-published (#412) fails closed on absent version / publisher mismatch / no extension', () => {
    const q = { results: [{ extensions: [{ publisher: { publisherName: 'pub' }, extensionName: 'ext', versions: [{ version: '1.1.1' }] }] }] };
    const absent = assertPublished(q, { publisher: 'pub', name: 'ext', version: '1.2.0' });
    const wrongPub = assertPublished(q, { publisher: 'other', name: 'ext', version: '1.1.1' });
    const noExt = assertPublished({ results: [{ extensions: [] }] }, { publisher: 'pub', name: 'ext', version: '1.1.1' });
    return absent.ok === false && absent.live === false && wrongPub.ok === false && noExt.ok === false;
  }],
  ['release-cut-github (#412) verifyReleaseAssets passes a complete artifact set + names the tag', () => {
    const r = verifyReleaseAssets(['x/labview-benchmark-actor.vsix', 'x/labview-benchmark-actor.vsix.sigstore', 'x/extension-verdict.json'], { version: '1.2.0' });
    return r.ok === true && r.tag === 'ext-v1.2.0' && /\.vsix$/.test(r.vsix);
  }],
  ['release-cut-github (#412) fails closed on a missing vsix / sigstore / verdict; accepts a .pem+.sig bundle', () => {
    const noVsix = verifyReleaseAssets(['a.sigstore', 'x-verdict.json'], { version: '1.2.0' });
    const noSig = verifyReleaseAssets(['a.vsix', 'x-verdict.json'], { version: '1.2.0' });
    const noVerdict = verifyReleaseAssets(['a.vsix', 'a.sigstore'], { version: '1.2.0' });
    const pemSig = verifyReleaseAssets(['a.vsix', 'a.pem', 'a.sig', 'x-verdict.json'], { version: '1.2.0' });
    return noVsix.ok === false && noSig.ok === false && noVerdict.ok === false && pemSig.ok === true;
  }],
  ['signing-status binds the QUORUM sign-off to the VM when the enrolled key lives there (#414), key never read', () => {
    const enrolled = readReviewerAllowlist()['reviewer@vi-tech.nl'];
    const s = signingStatus({ reviewerId: 'reviewer@vi-tech.nl', reviewerKeyPath: 'C:\\lba-review\\reviewer-vitech.pem', keyExists: true, station: STATIONS.VM, enrolledPublicKey: enrolled, version: '1.2.0' });
    // ok, quorum command runs IN the VM (cmd /c from the repo clone), visual uses render-verdict.sh, and the
    // committed private-key PATH is echoed but never its material.
    return s.ok && s.station === STATIONS.VM && /cmd \/c .*sign-release-quorum\.mjs/.test(s.commands.quorum)
      && /render-verdict\.sh/.test(s.commands.visual) && s.commands.quorum.includes('reviewer-vitech.pem') && !/PRIVATE KEY/.test(s.commands.quorum);
  }],
  ['signing-status binds the QUORUM sign-off to the HOST (plain CLI, no cmd /c) when the key is host-resident (#414)', () => {
    const enrolled = readReviewerAllowlist()['reviewer@vi-tech.nl'];
    const s = signingStatus({ reviewerId: 'reviewer@vi-tech.nl', reviewerKeyPath: '/home/rev/enrolled.pem', keyExists: true, station: STATIONS.HOST, enrolledPublicKey: enrolled });
    return s.ok && s.station === STATIONS.HOST && /^node reviewer-workstation\/sign-release-quorum\.mjs/.test(s.commands.quorum) && !/cmd \/c/.test(s.commands.quorum);
  }],
  ['signing-status fails closed on a missing key, an unenrolled reviewer, a public-key mismatch, and an unknown station (#414)', () => {
    const enrolled = readReviewerAllowlist()['reviewer@vi-tech.nl'];
    const missing = signingStatus({ reviewerId: 'reviewer@vi-tech.nl', reviewerKeyPath: 'C:\\lba-review\\reviewer-vitech.pem', keyExists: false, station: STATIONS.VM, enrolledPublicKey: enrolled });
    const unenrolled = signingStatus({ reviewerId: 'stranger@example.com', reviewerKeyPath: '/k.pem', keyExists: true, station: STATIONS.HOST, enrolledPublicKey: null });
    const mismatch = signingStatus({ reviewerId: 'reviewer@vi-tech.nl', reviewerKeyPath: '/k.pem', keyExists: true, station: STATIONS.HOST, enrolledPublicKey: enrolled, presentedPublicKey: '-----BEGIN PUBLIC KEY-----\nDEADBEEF\n-----END PUBLIC KEY-----\n' });
    const unknown = signingStatus({ station: STATIONS.UNKNOWN });
    return missing.ok === false && /not found/.test(missing.problems.join())
      && unenrolled.ok === false && /not enrolled/.test(unenrolled.problems.join())
      && mismatch.ok === false && mismatch.keyMatch === 'mismatch'
      && unknown.ok === false && /could not locate the signing station/.test(unknown.problems.join());
  }],
  ['signing-status confirms a public-key MATCH clears + reports enrolled (#414)', () => {
    const enrolled = readReviewerAllowlist()['reviewer@vi-tech.nl'];
    const s = signingStatus({ reviewerId: 'reviewer@vi-tech.nl', reviewerKeyPath: '/k.pem', keyExists: true, station: STATIONS.HOST, enrolledPublicKey: enrolled, presentedPublicKey: enrolled });
    return s.ok && s.enrolled === true && s.keyMatch === 'match';
  }],
  ['capacity-weighted partition splits a task set disjointly, covers it, and honours weight', () => {
    // rg-free (CI runners have no ripgrep): a synthetic task set exercises the pure partitioner.
    const tasks = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const shards = capacityWeightedPartition(tasks, [{ weight: 3 }, { weight: 1 }]);
    const covered = new Set(shards.flat()).size === tasks.length && shards.reduce((a, s) => a + s.length, 0) === tasks.length;
    return covered && shards.length === 2 && shards[0].length > shards[1].length; // higher weight -> more tasks
  }],
  ['host capabilities always include node (labview iff LabVIEWCLI present)', () => hostCapabilities().includes('node')],
  ['first-win onboarding flow: every step realization resolves on disk (LBA-REQ-033)', () => analyzeFlow((rel) => existsSync(join(repoRoot, rel))).allResolved],
  ['mesh-run driver chains ingest + corroborate over the committed dispatch + returned-demo (LBA-REQ-091/092)', () => {
    const dispatch = JSON.parse(read('experiments/mesh-fulfillment/mesh-run-dispatch-request.json'));
    const returned = readReturned(join(repoRoot, 'experiments/mesh-fulfillment/returned-demo'));
    const r = driveMeshRun({ dispatch, returned });
    return r.ok && r.report.planes.join(',') === 'LINUX,WIN' && r.report.corroboration.crossPlane && r.comparison !== null;
  }],
  ['mesh-run driver corroborates the REAL live N=2 run (n2-live-run: LINUX vbox-vnc 1866ms + WIN vbox-sdk 6919ms, identity-bound)', () => {
    const dispatch = JSON.parse(read('experiments/mesh-fulfillment/n2-live-run/dispatch.json'));
    const returned = readReturned(join(repoRoot, 'experiments/mesh-fulfillment/n2-live-run/returned'));
    const r = driveMeshRun({ dispatch, returned });
    return r.ok && r.report.planes.join(',') === 'LINUX,WIN' && r.report.corroboration.allPass && r.report.corroboration.identityBound && r.comparison !== null;
  }],
  ['assembleLiveN2 wraps the two committed real plane trends into a cross-plane corroborated report (identity-bound, all PASS)', () => {
    const lin = JSON.parse(read('experiments/mesh-fulfillment/n2-live-run/returned/linux.json')).receipt;
    const win = JSON.parse(read('experiments/mesh-fulfillment/n2-live-run/returned/win.json')).receipt;
    const r = assembleLiveN2({ linuxTrend: lin, winTrend: win, dispatchId: 'selftest-live-n2' });
    return r.ok && r.report.planes.join(',') === 'LINUX,WIN' && r.report.corroboration.allPass && r.report.corroboration.identityBound && r.comparison !== null;
  }],
  ['mesh-run driver corroborates the REAL live N=3 run (n3-live-run: 2 LINUX actors clone-01+clone-02 + WIN actor -> quorum)', () => {
    const dispatch = JSON.parse(read('experiments/mesh-fulfillment/n3-live-run/dispatch.json'));
    const returned = readReturned(join(repoRoot, 'experiments/mesh-fulfillment/n3-live-run/returned'));
    const r = driveMeshRun({ dispatch, returned });
    return r.ok && r.report.planes.join(',') === 'LINUX,WIN' && r.report.corroboration.allPass && r.report.corroboration.identityBound
      && r.report.corroboration.quorum.perPlane.LINUX.count === 2 && r.comparison !== null;
  }],
  ['assembleLiveN2 accepts a multi-actor LINUX roster (quorum N>2) from the committed n3 trends', () => {
    const c01 = JSON.parse(read('experiments/mesh-fulfillment/n3-live-run/returned/linux-clone01.json')).receipt;
    const c02 = JSON.parse(read('experiments/mesh-fulfillment/n3-live-run/returned/linux-clone02.json')).receipt;
    const win = JSON.parse(read('experiments/mesh-fulfillment/n3-live-run/returned/win-actor.json')).receipt;
    const r = assembleLiveN2({ linuxActors: [{ actorId: 'clone-01', trend: c01 }, { actorId: 'clone-02', trend: c02 }], winActors: [{ actorId: 'actor', trend: win }], dispatchId: 'selftest-live-n3-roster' });
    return r.ok && r.report.corroboration.quorum.perPlane.LINUX.count === 2 && r.report.corroboration.allPass && r.comparison !== null;
  }],
];
function runSelftest() {
  let passed = 0;
  for (const [name, fn] of SELFTEST) {
    let ok = false;
    try { ok = !!fn(); } catch (e) { ok = false; console.log(`  ERR   ${name}: ${e.message}`); }
    if (ok) { console.log(`  PASS  ${name}`); passed += 1; } else { console.log(`  FAIL  ${name}`); }
  }
  console.log(`\nlba selftest (iteration ${ITERATION}): ${passed}/${SELFTEST.length} checks passed`);
  if (passed !== SELFTEST.length) process.exit(1);
}

// ---- CLI ----------------------------------------------------------------------------------------
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(`lba — agent governance + verification helper (iteration ${ITERATION})\n\nsubcommands:`);
    for (const [name, c] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(14)} ${c.desc}`);
    process.exit(cmd ? 0 : 2);
  }
  const c = COMMANDS[cmd];
  if (!c) { console.error(`unknown subcommand: ${cmd} (try: lba help)`); process.exit(2); }
  c.run(args);
}
