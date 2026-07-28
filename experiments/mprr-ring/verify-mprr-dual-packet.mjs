#!/usr/bin/env node
// Gate: mprr dual-packet correlation + degradation policy has TEETH. Proves short-packet continuity is
// preserved BEFORE long-packet completeness (MPRR-REQ-094/110/111). Exit 0 = pass.
//
// Run: node experiments/mprr-ring/verify-mprr-dual-packet.mjs

import { MPRR_DUAL_PACKET_SCHEMA, correlateDualStream } from './mprrDualPacket.mjs';

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

const frames = (n, shortB, longB) =>
  Array.from({ length: n }, (_, i) => ({ frameIndex: i, shortBytes: shortB, longBytes: longB }));

// 1. No pressure: every frame's long is admitted -> authoritative, driftClass none.
check('all-fit-authoritative', () => {
  const r = correlateDualStream(frames(8, 100, 400), { capacityBytes: 100000 });
  assert(r.schema === MPRR_DUAL_PACKET_SCHEMA, 'schema');
  assert(r.authoritative === true && r.outcome === 'authoritative', 'all authoritative');
  assert(r.frames.every((f) => f.driftClass === 'none'), 'no drift');
  assert(r.admittedLong === 8 * 400, 'all longs admitted');
});

// 2. Long pressure: SHORTS stay fully protected while some LONGS are deferred (missing-long-payload).
check('long-pressure-defers-long-not-short', () => {
  // shorts: 8*100=800 (all protected). budget only fits 800 + 3 longs of 400 (=2000) -> capacity 2000.
  const r = correlateDualStream(frames(8, 100, 400), { capacityBytes: 2000 });
  assert(r.shortTotal === 800, 'every short is still counted (protected, none dropped)');
  assert(r.authoritative === false && r.outcome === 'degraded-long-deferred', 'degraded');
  assert(r.admittedLong === 1200, `only 3 longs admitted (1200), got ${r.admittedLong}`);
  const deferred = r.frames.filter((f) => f.driftClass === 'missing-long-payload');
  assert(deferred.length === 5, `5 longs deferred, got ${deferred.length}`);
  // The deferred frames still carry their short bytes -> short continuity intact.
  assert(deferred.every((f) => f.shortBytes === 100), 'deferred-long frames keep their short');
});

// 3. A frame with no long payload is failed/missing-long-payload (not authoritative).
check('missing-long-payload-frame', () => {
  const f = [
    { frameIndex: 0, shortBytes: 100, longBytes: 400 },
    { frameIndex: 1, shortBytes: 100, longBytes: 0 },
    { frameIndex: 2, shortBytes: 100, longBytes: 400 },
  ];
  const r = correlateDualStream(f, { capacityBytes: 100000 });
  assert(r.authoritative === false, 'a missing long => not authoritative');
  assert(r.frames[1].driftClass === 'missing-long-payload' && r.frames[1].outcome === 'failed', 'frame 1 failed');
  assert(r.frames[0].outcome === 'authoritative' && r.frames[2].outcome === 'authoritative', 'others authoritative');
});

// 4. Shorts alone over capacity -> fail closed at the short-protection boundary (never overwrite a short).
check('short-protection-fails-closed', () => {
  const r = correlateDualStream(frames(10, 500, 100), { capacityBytes: 4096 }); // shorts 5000 > 4096
  assert(r.outcome === 'short-protection-blocked' && r.authoritative === false, 'fail closed');
  assert(r.admittedLong === 0 && r.frames.length === 0, 'no long admitted when shorts do not fit');
});

// 5. Deterministic: identical frames -> identical receipt.
check('deterministic', () => {
  const a = correlateDualStream(frames(6, 120, 300), { capacityBytes: 3000 });
  const b = correlateDualStream(frames(6, 120, 300), { capacityBytes: 3000 });
  assert(JSON.stringify(a) === JSON.stringify(b), 'deterministic receipt');
});

// 6. A short packet is mandatory (shortBytes <= 0 is rejected).
check('short-mandatory', () => {
  let threw = false;
  try {
    correlateDualStream([{ frameIndex: 0, shortBytes: 0, longBytes: 400 }]);
  } catch (err) {
    threw = /short packet is always present/.test(err.message);
  }
  assert(threw, 'expected short-mandatory rejection');
});

const passed = checks.filter((c) => c.pass).length;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.err ? `  -- ${c.err}` : ''}`);
}
console.log(`\n${passed}/${checks.length} mprr-dual-packet checks passed`);
process.exit(passed === checks.length ? 0 : 1);
