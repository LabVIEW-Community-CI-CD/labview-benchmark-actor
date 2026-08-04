#!/usr/bin/env node
// independence.mjs -- Actor Corroboration Grid witness-independence engine (ADR-0017, LBA-REQ-026).
//
// A quorum only means something if its witnesses are genuinely independent: N look-alike nodes are not N
// independent witnesses. This engine enforces ADR-0017 provider/OS diversity + allowlist enrollment: a valid
// quorum must span DISTINCT ENROLLED environments; a witness that is not enrolled, that duplicates an
// already-counted environment, or whose identity is not recorded in the provenance DOES NOT count toward the
// quorum. Dependency-free (Node builtins only).

import { readFileSync } from 'node:fs';

// A witness's PLANE is the OS the extension runs in -- exactly two: 'windows' | 'linux'. This is the ONLY axis
// corroboration independence is measured on (ADR-0068 corrects ADR-0017): two witnesses are independent only if
// they run on DIFFERENT OS-planes. The bundle's `plane` field is a CONTEXT/hypervisor label (codespace, vbox,
// vmware, ...) and does NOT by itself establish diversity -- N linux contexts (codespace + vbox + a native host)
// are ONE linux plane, not N independent witnesses. Hypervisor is a provisioning attribute, never a plane.
export function planeOf(bundle) {
  return String(bundle?.os ?? '?').toLowerCase();
}

// Back-compat alias: environmentOf now returns the OS-plane (was `${plane}/${os}`).
export const environmentOf = planeOf;

// The set of enrolled OS-planes from an enrollment doc ({ planes: [{ plane }] } or legacy { environments: [{ os }] }).
// The enrolled key is the OS-plane, so prefer an entry's `os`, then a bare `plane` (already an os value), then `id`.
export function enrolledEnvironmentSet(enrollment) {
  const entries = enrollment?.planes ?? enrollment?.environments ?? [];
  return new Set(entries.map((e) => String(e.os ?? e.plane ?? e.id ?? '?').toLowerCase()));
}

// Assess the CROSS-PLANE independence of a witness set. witnesses = [{ bundle, identity }] where `identity` is the
// recorded provenance identity (ADR-0016 attestation). A witness counts toward the quorum ONLY if its OS-plane is
// enrolled, its identity is recorded, and that plane has not already been counted (a second witness on the same
// plane is redundant for plane diversity -- it collapses). Independent iff >= quorumMin DISTINCT enrolled planes
// are counted (with only two planes, that means BOTH linux AND windows).
export function assessIndependence(witnesses, { enrolledEnvironments, quorumMin = 2 } = {}) {
  const enrolled = enrolledEnvironments instanceof Set ? enrolledEnvironments : enrolledEnvironmentSet(enrolledEnvironments);
  const seenPlanes = new Set();
  const counted = [];
  const excluded = [];
  const list = Array.isArray(witnesses) ? witnesses : [];
  list.forEach((w, i) => {
    const context = w?.bundle?.plane ?? `#${i}`; // hypervisor/context label (recorded, NOT the plane)
    const plane = planeOf(w?.bundle);
    const identity = w?.identity ?? null;
    if (!enrolled.has(plane)) {
      excluded.push({ witness: context, plane, reason: 'OS-plane is not enrolled' });
    } else if (!identity) {
      excluded.push({ witness: context, plane, reason: 'witness identity is not recorded in the provenance' });
    } else if (seenPlanes.has(plane)) {
      excluded.push({ witness: context, plane, reason: 'duplicates an already-counted OS-plane (same OS = one plane)' });
    } else {
      seenPlanes.add(plane);
      counted.push({ witness: context, plane, identity });
    }
  });
  const distinctPlanes = [...seenPlanes];
  const crossPlane = distinctPlanes.length >= quorumMin;
  const independent = crossPlane;
  const reasons = [];
  if (!independent) {
    reasons.push(`only ${distinctPlanes.length} distinct enrolled OS-plane(s) with a recorded identity (${distinctPlanes.join(', ') || 'none'}); a cross-plane quorum needs >= ${quorumMin} (linux AND windows)`);
  }
  return {
    schema: 'labview-benchmark-actor/acg-independence-verdict-v2',
    independent,
    crossPlane,
    quorumMin,
    distinctPlanes,
    counted,
    excluded,
    reasons,
  };
}

// Fail-closed helper: reject the quorum (throw) unless it spans distinct OS-planes (cross-plane independent).
export function assertIndependentQuorum(witnesses, opts = {}) {
  const verdict = assessIndependence(witnesses, opts);
  if (!verdict.independent) {
    throw new Error(`quorum REJECTED (not cross-plane independent): ${verdict.reasons.join('; ')}`);
  }
  return verdict;
}

// CLI: independence.mjs --enrollment <f> --witness <bundle.json>[:<attestation.json>] [--witness ...]
// The optional attestation supplies the recorded identity; without it, the bundle's plane is used as a fallback label
// but counts as an UNRECORDED identity (excluded) unless --identity-from-plane is given.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opt = {};
  const witnessArgs = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--witness') witnessArgs.push(argv[(i += 1)]);
    else if (a.startsWith('--')) opt[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  }
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  if (!opt.enrollment || witnessArgs.length === 0) {
    console.error('usage: independence.mjs --enrollment <f> --witness <bundle>[:<attestation>] [--witness ...]');
    process.exit(2);
  }
  const enrolledEnvironments = enrolledEnvironmentSet(readJson(opt.enrollment));
  const witnesses = witnessArgs.map((w) => {
    const [bundlePath, attPath] = w.split(':');
    return { bundle: readJson(bundlePath), identity: attPath ? readJson(attPath).witnessIdentity : null };
  });
  const verdict = assessIndependence(witnesses, { enrolledEnvironments });
  console.log(JSON.stringify(verdict, null, 2));
  process.exit(verdict.independent ? 0 : 1);
}
