#!/usr/bin/env node
// independence.selftest.mjs -- dependency-free self-test for the CROSS-PLANE witness-independence engine
// (LBA-REQ-026, corrected by ADR-0068). A plane is the OS the extension runs in (linux|windows); a quorum is
// independent only when it spans >= quorumMin DISTINCT enrolled PLANES (linux AND windows), each with a recorded
// identity. N witnesses on the SAME plane (even different hypervisor contexts) are ONE plane, not independent.

import assert from 'node:assert/strict';
import { assessIndependence, assertIndependentQuorum, planeOf, environmentOf, enrolledEnvironmentSet } from './independence.mjs';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };

const enrolled = enrolledEnvironmentSet({ planes: [{ plane: 'linux' }, { plane: 'windows' }] });
const W = (context, os, identity) => ({ bundle: { plane: context, os }, identity });

// 1. A quorum spanning BOTH planes (linux + windows), each with a recorded identity, is cross-plane independent.
ok('two distinct planes (linux + windows) -> independent', () => {
  const v = assessIndependence([W('VBOX', 'linux', 'acg-witness:vbox'), W('WIN', 'windows', 'acg-witness:win')], { enrolledEnvironments: enrolled });
  assert.equal(v.independent, true, v.reasons.join('; '));
  assert.equal(v.crossPlane, true);
  assert.deepEqual(v.distinctPlanes.sort(), ['linux', 'windows']);
  assert.equal(v.counted.length, 2);
});

// 2. Two witnesses on the SAME plane (two linux contexts) are ONE plane -> NOT independent (the core correction).
ok('two linux contexts are one plane -> NOT independent', () => {
  const v = assessIndependence([W('CODESPACE', 'linux', 'acg-witness:codespace'), W('LINUX', 'linux', 'acg-witness:host-linux')], { enrolledEnvironments: enrolled });
  assert.equal(v.independent, false);
  assert.equal(v.crossPlane, false);
  assert.deepEqual(v.distinctPlanes, ['linux']);
  assert.match(v.excluded.map((e) => e.reason).join(' '), /duplicates an already-counted OS-plane/);
});

// 3. A witness on a non-enrolled plane does not count.
ok('a non-enrolled plane does not count', () => {
  const v = assessIndependence([W('WIN', 'windows', 'acg-witness:win'), W('ROGUE', 'freebsd', 'acg-witness:rogue')], { enrolledEnvironments: enrolled });
  assert.equal(v.independent, false);
  assert.equal(v.counted.length, 1);
  assert.match(v.excluded.map((e) => e.reason).join(' '), /not enrolled/);
});

// 4. A duplicate plane collapses; adding the OTHER plane completes the cross-plane quorum.
ok('duplicate plane collapses; the other plane completes the quorum', () => {
  const v = assessIndependence([
    W('CODESPACE', 'linux', 'acg-witness:codespace'),
    W('LINUX', 'linux', 'acg-witness:host-linux'),
    W('WIN', 'windows', 'acg-witness:win'),
  ], { enrolledEnvironments: enrolled });
  assert.equal(v.independent, true);
  assert.deepEqual(v.distinctPlanes.sort(), ['linux', 'windows']);
  assert.equal(v.excluded.length, 1);
});

// 5. A witness whose identity is not recorded does not count (AC #3).
ok('an identity-less witness does not count', () => {
  const v = assessIndependence([W('LINUX', 'linux', 'acg-witness:host-linux'), W('WIN', 'windows', null)], { enrolledEnvironments: enrolled });
  assert.equal(v.independent, false);
  assert.equal(v.counted.length, 1);
  assert.match(v.excluded.map((e) => e.reason).join(' '), /identity is not recorded/);
});

// 6. A single witness is not an independent quorum.
ok('a single witness is not independent', () => {
  const v = assessIndependence([W('LINUX', 'linux', 'acg-witness:host-linux')], { enrolledEnvironments: enrolled });
  assert.equal(v.independent, false);
});

// 7. assertIndependentQuorum throws on a single-plane set, returns the verdict on a cross-plane one.
ok('assertIndependentQuorum fails closed on single-plane', () => {
  assert.throws(() => assertIndependentQuorum([W('CODESPACE', 'linux', 'acg-witness:codespace'), W('LINUX', 'linux', 'acg-witness:host-linux')], { enrolledEnvironments: enrolled }), /REJECTED \(not cross-plane independent\)/);
  const v = assertIndependentQuorum([W('LINUX', 'linux', 'acg-witness:host-linux'), W('WIN', 'windows', 'acg-witness:win')], { enrolledEnvironments: enrolled });
  assert.equal(v.independent, true);
});

// 8. helpers: planeOf/environmentOf return the OS-plane; enrolledEnvironmentSet reads planes or legacy environments.
ok('planeOf + enrolledEnvironmentSet', () => {
  assert.equal(planeOf({ plane: 'CODESPACE', os: 'linux' }), 'linux');
  assert.equal(environmentOf({ plane: 'VMWARE', os: 'linux' }), 'linux'); // a VMware Ubuntu guest = the linux plane
  const s = enrolledEnvironmentSet({ planes: [{ plane: 'linux' }, { plane: 'windows' }] });
  assert.equal(s.has('linux'), true);
  assert.equal(s.has('windows'), true);
  const legacy = enrolledEnvironmentSet({ environments: [{ os: 'linux' }, { id: 'windows' }] });
  assert.equal(legacy.has('linux') && legacy.has('windows'), true);
});

console.log(`independence self-test: ${pass}/${pass} PASS`);
