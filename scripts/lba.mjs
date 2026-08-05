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

export const ITERATION = 12; // bump when you refine this tool (see the banner above)

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
