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
//   selftest                     self-check this tool (run by the `agent-tooling-selftest` gate)

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { capacityWeightedPartition } from '../experiments/parallel/parallelWorkload.mjs';
import { describeFlow, analyzeFlow } from '../experiments/first-win/firstWinOnboarding.mjs';

export const ITERATION = 4; // bump when you refine this tool (see the banner above)

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
  ['capacity-weighted partition splits a task set disjointly, covers it, and honours weight', () => {
    // rg-free (CI runners have no ripgrep): a synthetic task set exercises the pure partitioner.
    const tasks = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const shards = capacityWeightedPartition(tasks, [{ weight: 3 }, { weight: 1 }]);
    const covered = new Set(shards.flat()).size === tasks.length && shards.reduce((a, s) => a + s.length, 0) === tasks.length;
    return covered && shards.length === 2 && shards[0].length > shards[1].length; // higher weight -> more tasks
  }],
  ['host capabilities always include node (labview iff LabVIEWCLI present)', () => hostCapabilities().includes('node')],
  ['first-win onboarding flow: every step realization resolves on disk (LBA-REQ-033)', () => analyzeFlow((rel) => existsSync(join(repoRoot, rel))).allResolved],
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
