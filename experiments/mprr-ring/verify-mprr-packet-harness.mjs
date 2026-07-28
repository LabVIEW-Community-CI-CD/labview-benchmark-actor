#!/usr/bin/env node
// Gate: the mprr packet-harness rate profiles (MPRR-REQ-115-119) drive the absorbed ring across load shapes.
// Proves each profile generates a deterministic, monotonic stream the ring ingests, and that the profiles
// exercise distinct ring behavior (steady is authoritative; reclaim-pressure trips admission on a small ring;
// boundary-crossing spans multiple blocks). Exit 0 = pass.
//
// Run: node experiments/mprr-ring/verify-mprr-packet-harness.mjs

import {
  MPRR_HARNESS_SCHEMA,
  RATE_PROFILES,
  generateProfile,
  runProfile,
} from './mprrPacketHarness.mjs';

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, pass: true });
  } catch (err) {
    checks.push({ name, pass: false, err: err.message });
  }
}
function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg || 'assertion failed');
  }
}

// Test params: a small block duration so a modest stream spans several blocks; aligned interval so 'steady' is
// authoritative.
const P = { count: 24, frameIntervalTicks: 1_000_000, baseBytes: 120, blockDurationTicks: 3_000_000 };

// 1. Every profile generates a DETERMINISTIC, MONOTONIC, non-empty stream.
check('profiles-generate-deterministic-monotonic-streams', () => {
  assert(RATE_PROFILES.length === 5, 'five rate profiles');
  for (const name of RATE_PROFILES) {
    const a = generateProfile(name, P);
    const b = generateProfile(name, P);
    assert(JSON.stringify(a) === JSON.stringify(b), `${name} is deterministic`);
    assert(a.length === P.count, `${name} yields ${P.count} packets`);
    for (let i = 1; i < a.length; i += 1) {
      assert(a[i].timingTicks64 >= a[i - 1].timingTicks64, `${name} is monotonic at ${i}`);
      assert(a[i].bytes > 0, `${name} packet ${i} has bytes`);
    }
  }
});

// 2. Every profile runs through the ring without throwing (the ring holds under every load shape).
check('every-profile-runs-through-the-ring', () => {
  for (const name of RATE_PROFILES) {
    const r = runProfile(name, P);
    assert(r.schema === MPRR_HARNESS_SCHEMA && r.profile === name, `${name} result identity`);
    assert(r.packetCount === P.count && r.blockCount >= 1, `${name} ingested`);
  }
});

// 3. 'steady' with a block-aligned interval is authoritative (0 boundary variation, admitted).
check('steady-is-authoritative', () => {
  const r = runProfile('steady', P);
  assert(r.worstBoundaryVariationPct === 0, `steady boundary variation 0, got ${r.worstBoundaryVariationPct}`);
  assert(r.admission.admitted === true && r.authoritative === true, 'steady authoritative');
});

// 4. 'reclaim-pressure' trips admission control on a SMALL ring but is admitted on an ample ring.
check('reclaim-pressure-trips-admission-on-small-ring', () => {
  const small = runProfile('reclaim-pressure', { ...P, capacityBytes: 4096 });
  assert(small.admission.admitted === false && small.admission.outcome === 'admission-control-blocked',
    `small ring must block reclaim-pressure, got ${small.admission.outcome}`);
  const ample = runProfile('reclaim-pressure', { ...P, capacityBytes: 200_000 });
  assert(ample.admission.admitted === true, 'ample ring admits reclaim-pressure');
});

// 5. 'boundary-crossing' spans multiple blocks (the crossing behavior it is named for).
check('boundary-crossing-spans-multiple-blocks', () => {
  const r = runProfile('boundary-crossing', P);
  assert(r.blockCount >= 3, `boundary-crossing should span >=3 blocks, got ${r.blockCount}`);
});

// 6. Teeth: an unknown profile name is rejected.
check('rejects-unknown-profile', () => {
  let threw = false;
  try {
    generateProfile('chaos', P);
  } catch (err) {
    threw = /unknown rate profile/.test(err.message);
  }
  assert(threw, 'unknown profile rejected');
});

const passed = checks.filter((c) => c.pass).length;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.err ? `  -- ${c.err}` : ''}`);
}
console.log(`\n${passed}/${checks.length} mprr-packet-harness checks passed`);
process.exit(passed === checks.length ? 0 : 1);
