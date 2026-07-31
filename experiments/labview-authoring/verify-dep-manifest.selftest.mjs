// verify-dep-manifest.selftest.mjs — self-test for the authoring dependency-manifest verifier (LBA-REQ-017).
// Asserts the committed dep-manifest.json passes, and that the verifier FAILS CLOSED on each class of defect
// (bad schema, malformed SHA, unknown plane, missing python bitness, bad pinStatus, resolved-but-empty version),
// while allowing tbd-* pins to omit their concrete value. Pure + offline; runnable standalone or subprocessed.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDepManifest } from './verify-dep-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let planned = 0;
const check = (name, fn) => {
  planned += 1;
  try { fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`  FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const clone = (o) => JSON.parse(JSON.stringify(o));

const real = JSON.parse(readFileSync(join(here, 'dep-manifest.json'), 'utf8'));

check('the committed dep-manifest.json validates', () => {
  const r = verifyDepManifest(real);
  assert(r.ok, `expected ok, got errors: ${r.errors.join('; ')}`);
  assert(r.summary.gitRepos === 2 && r.summary.pipTools === 2 && r.summary.vipmPackages === 1, 'expected 2 gitRepos / 2 pipTools / 1 vipmPackage');
  assert(r.summary.resolved >= 3 && r.summary.tbd >= 2, 'expected the resolved (labview_assistant, icon-editor, lvkit) + tbd (pylabview, dqmh) split');
});

check('the resolved git pins are real 40-hex SHAs', () => {
  const shas = real.gitRepos.map((g) => g.pin);
  assert(shas.every((s) => /^[0-9a-f]{40}$/.test(s)), 'both gitRepos pinned to 40-hex SHAs');
});

check('non-object manifest fails closed', () => {
  assert(!verifyDepManifest(null).ok, 'null');
  assert(!verifyDepManifest([]).ok, 'array');
});

check('a wrong schema fails closed', () => {
  const m = clone(real); m.schema = 'nope@9';
  assert(!verifyDepManifest(m).ok, 'bad schema should fail');
});

check('a malformed pin (resolved) fails closed', () => {
  // the verifier accepts a 40-hex SHA OR a taglike ref; a pin with spaces/invalid chars is neither
  const m = clone(real); m.gitRepos[0].pin = 'bad sha!';
  assert(!verifyDepManifest(m).ok, 'a malformed pin should fail');
  const m2 = clone(real); m2.gitRepos[0].pin = '';
  assert(!verifyDepManifest(m2).ok, 'an empty resolved pin should fail');
});

check('an unknown plane fails closed', () => {
  const m = clone(real); m.pipTools[0].planes = ['mac'];
  assert(!verifyDepManifest(m).ok, 'unknown plane should fail');
});

check('a missing/invalid pythonBitness fails closed', () => {
  const m = clone(real); delete m.pipTools[0].pythonBitness;
  assert(!verifyDepManifest(m).ok, 'missing pythonBitness should fail');
  const m2 = clone(real); m2.pipTools[0].pythonBitness = 16;
  assert(!verifyDepManifest(m2).ok, 'bitness 16 should fail');
});

check('a resolved pip tool with an empty version fails closed', () => {
  const m = clone(real); m.pipTools[0].version = ''; // lvkit is pinStatus verified
  assert(!verifyDepManifest(m).ok, 'resolved pip tool must carry a pinned version');
});

check('an unpinned pip range (not == / ~=) fails closed', () => {
  const m = clone(real); m.pipTools[0].version = '>=0.5.0';
  assert(!verifyDepManifest(m).ok, 'a floating range is not a pin');
});

check('a bad pinStatus value fails closed', () => {
  const m = clone(real); m.vipmPackages[0].pinStatus = 'maybe';
  assert(!verifyDepManifest(m).ok, 'pinStatus must be verified or tbd*');
});

check('a bad labviewBitness fails closed', () => {
  const m = clone(real); m.vipmPackages[0].labviewBitness = 48;
  assert(!verifyDepManifest(m).ok, 'labviewBitness must be 32 or 64');
});

check('tbd-* pins may omit their concrete value (pylabview / dqmh)', () => {
  // pylabview (tbd-linux-verify) has an empty version, dqmh (tbd-linux-owns-vipc) is fine -> still ok overall
  const r = verifyDepManifest(real);
  const pylabview = real.pipTools.find((t) => t.name === 'pylabview');
  assert(pylabview.pinStatus === 'tbd-linux-verify' && pylabview.version === '', 'pylabview is a tbd pin with an empty version');
  assert(r.ok, 'a manifest with tbd pins still validates');
});

console.log(`verify-dep-manifest self-test: ${pass}/${planned} PASS`);
if (pass !== planned) process.exitCode = 1;
