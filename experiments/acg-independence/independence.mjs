#!/usr/bin/env node
// independence.mjs -- Actor Corroboration Grid witness-independence engine (ADR-0017, LBA-REQ-026).
//
// A quorum only means something if its witnesses are genuinely independent: N look-alike nodes are not N
// independent witnesses. This engine enforces ADR-0017 provider/OS diversity + allowlist enrollment: a valid
// quorum must span DISTINCT ENROLLED environments; a witness that is not enrolled, that duplicates an
// already-counted environment, or whose identity is not recorded in the provenance DOES NOT count toward the
// quorum. Dependency-free (Node builtins only).

import { readFileSync } from 'node:fs';

// A witness's environment signature = its plane + os (the provider/OS axis ADR-0017 requires diversity across).
export function environmentOf(bundle) {
  return `${bundle?.plane ?? '?'}/${bundle?.os ?? '?'}`;
}

// The set of enrolled environment ids from an enrollment doc ({ environments: [{ id | plane, os }] }).
export function enrolledEnvironmentSet(enrollment) {
  return new Set((enrollment?.environments ?? []).map((e) => e.id ?? `${e.plane}/${e.os}`));
}

// Assess the independence of a witness set. witnesses = [{ bundle, identity }] where `identity` is the recorded
// provenance identity (ADR-0016 attestation). A witness counts toward the quorum ONLY if its environment is
// enrolled, its identity is recorded, and its environment has not already been counted (duplicates collapse).
export function assessIndependence(witnesses, { enrolledEnvironments, quorumMin = 2 } = {}) {
  const enrolled = enrolledEnvironments instanceof Set ? enrolledEnvironments : enrolledEnvironmentSet(enrolledEnvironments);
  const seen = new Set();
  const counted = [];
  const excluded = [];
  const list = Array.isArray(witnesses) ? witnesses : [];
  list.forEach((w, i) => {
    const label = w?.bundle?.plane ?? `#${i}`;
    const environment = environmentOf(w?.bundle);
    const identity = w?.identity ?? null;
    if (!enrolled.has(environment)) {
      excluded.push({ witness: label, environment, reason: 'environment is not enrolled' });
    } else if (!identity) {
      excluded.push({ witness: label, environment, reason: 'witness identity is not recorded in the provenance' });
    } else if (seen.has(environment)) {
      excluded.push({ witness: label, environment, reason: 'duplicates an already-counted environment' });
    } else {
      seen.add(environment);
      counted.push({ witness: label, environment, identity });
    }
  });
  const distinctEnrolledEnvironments = [...seen];
  const independent = distinctEnrolledEnvironments.length >= quorumMin;
  const reasons = [];
  if (!independent) {
    reasons.push(`only ${distinctEnrolledEnvironments.length} distinct enrolled environment(s) with a recorded identity; need >= ${quorumMin}`);
  }
  return {
    schema: 'labview-benchmark-actor/acg-independence-verdict-v1',
    independent,
    quorumMin,
    distinctEnrolledEnvironments,
    counted,
    excluded,
    reasons,
  };
}

// Fail-closed helper: reject the quorum (throw) unless it is independent.
export function assertIndependentQuorum(witnesses, opts = {}) {
  const verdict = assessIndependence(witnesses, opts);
  if (!verdict.independent) {
    throw new Error(`quorum REJECTED (not independent): ${verdict.reasons.join('; ')}`);
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
