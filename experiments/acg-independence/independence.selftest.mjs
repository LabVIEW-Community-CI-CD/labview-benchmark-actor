#!/usr/bin/env node
// independence.selftest.mjs -- dependency-free self-test for the witness-independence engine (LBA-REQ-026).
// Proves a quorum is independent only when it spans >= quorumMin DISTINCT ENROLLED environments each with a
// recorded identity, and that non-enrolled, duplicate-environment, and identity-less witnesses do not count.

import assert from 'node:assert/strict';
import { assessIndependence, assertIndependentQuorum, environmentOf, enrolledEnvironmentSet } from './independence.mjs';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };

const enrolled = enrolledEnvironmentSet({
  environments: [
    { id: 'CODESPACE/linux' }, { id: 'VBOX/linux' }, { id: 'WIN/windows' }, { id: 'LINUX/linux' },
  ],
});
const W = (plane, os, identity) => ({ bundle: { plane, os }, identity });

// 1. A quorum spanning two distinct enrolled environments, each with a recorded identity, is independent.
ok('two distinct enrolled environments -> independent', () => {
  const v = assessIndependence([W('CODESPACE', 'linux', 'acg-witness:codespace'), W('VBOX', 'linux', 'acg-witness:vbox')], { enrolledEnvironments: enrolled });
  assert.equal(v.independent, true, v.reasons.join('; '));
  assert.equal(v.distinctEnrolledEnvironments.length, 2);
  assert.equal(v.counted.length, 2);
});

// 2. N-of-a-kind (two witnesses of the SAME environment) is rejected.
ok('N-of-a-kind (same environment twice) -> rejected', () => {
  const v = assessIndependence([W('CODESPACE', 'linux', 'acg-witness:codespace'), W('CODESPACE', 'linux', 'acg-witness:codespace-2')], { enrolledEnvironments: enrolled });
  assert.equal(v.independent, false);
  assert.equal(v.distinctEnrolledEnvironments.length, 1);
  assert.match(v.excluded.map((e) => e.reason).join(' '), /duplicates an already-counted environment/);
});

// 3. A non-enrolled witness does not count toward the quorum.
ok('a non-enrolled environment does not count', () => {
  const v = assessIndependence([W('CODESPACE', 'linux', 'acg-witness:codespace'), W('ROGUE', 'linux', 'acg-witness:rogue')], { enrolledEnvironments: enrolled });
  assert.equal(v.independent, false);
  assert.equal(v.counted.length, 1);
  assert.match(v.excluded.map((e) => e.reason).join(' '), /not enrolled/);
});

// 4. A duplicate environment collapses (counts once); a third distinct environment still yields independence.
ok('duplicate environment collapses; distinct third still counts', () => {
  const v = assessIndependence([
    W('CODESPACE', 'linux', 'acg-witness:codespace'),
    W('CODESPACE', 'linux', 'acg-witness:codespace-2'),
    W('VBOX', 'linux', 'acg-witness:vbox'),
  ], { enrolledEnvironments: enrolled });
  assert.equal(v.independent, true);
  assert.deepEqual(v.distinctEnrolledEnvironments.sort(), ['CODESPACE/linux', 'VBOX/linux']);
  assert.equal(v.excluded.length, 1);
});

// 5. A witness whose identity is not recorded in the provenance does not count (AC #3).
ok('an identity-less witness does not count', () => {
  const v = assessIndependence([W('CODESPACE', 'linux', 'acg-witness:codespace'), W('VBOX', 'linux', null)], { enrolledEnvironments: enrolled });
  assert.equal(v.independent, false);
  assert.equal(v.counted.length, 1);
  assert.match(v.excluded.map((e) => e.reason).join(' '), /identity is not recorded/);
});

// 6. Provider/OS diversity across OSes is independent (Linux codespace + Windows plane).
ok('cross-OS witnesses are independent', () => {
  const v = assessIndependence([W('CODESPACE', 'linux', 'acg-witness:codespace'), W('WIN', 'windows', 'acg-witness:win')], { enrolledEnvironments: enrolled });
  assert.equal(v.independent, true);
  assert.equal(v.counted.length, 2);
});

// 7. A single witness is not an independent quorum.
ok('a single witness is not independent', () => {
  const v = assessIndependence([W('CODESPACE', 'linux', 'acg-witness:codespace')], { enrolledEnvironments: enrolled });
  assert.equal(v.independent, false);
});

// 8. assertIndependentQuorum throws on a non-independent set, returns the verdict on an independent one.
ok('assertIndependentQuorum fails closed', () => {
  assert.throws(() => assertIndependentQuorum([W('CODESPACE', 'linux', 'acg-witness:codespace'), W('CODESPACE', 'linux', 'acg-witness:codespace-2')], { enrolledEnvironments: enrolled }), /REJECTED \(not independent\)/);
  const v = assertIndependentQuorum([W('CODESPACE', 'linux', 'acg-witness:codespace'), W('LINUX', 'linux', 'acg-witness:host-linux')], { enrolledEnvironments: enrolled });
  assert.equal(v.independent, true);
});

// 9. helpers.
ok('environmentOf + enrolledEnvironmentSet', () => {
  assert.equal(environmentOf({ plane: 'CODESPACE', os: 'linux' }), 'CODESPACE/linux');
  const s = enrolledEnvironmentSet({ environments: [{ plane: 'CODESPACE', os: 'linux' }, { id: 'WIN/windows' }] });
  assert.equal(s.has('CODESPACE/linux'), true);
  assert.equal(s.has('WIN/windows'), true);
});

console.log(`independence self-test: ${pass}/${pass} PASS`);
