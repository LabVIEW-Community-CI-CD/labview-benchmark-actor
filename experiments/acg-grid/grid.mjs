#!/usr/bin/env node
// grid.mjs -- Actor Corroboration Grid end-to-end gate (ADR-0014, LBA-REQ-023, the umbrella).
//
// Composes EVERY proven sub-engine into one release gate: a governed release is corroborated + releasable ONLY
// when all stages hold --
//   1. INDEPENDENCE (ADR-0017 / LBA-REQ-026): the witnesses span distinct enrolled environments with recorded ids.
//   2. QUORUM       (ADR-0015 / LBA-REQ-024): a majority agree on the tiered deterministic anchors (verdict pass).
//   3. ATTESTATION  (ADR-0016 / LBA-REQ-025): every witness's signed bundle verifies + the re-computed quorum passes.
//   4. MESH         (ADR-0019 / LBA-REQ-028): each verdict beacons over the bus + the ledger re-derives the quorum.
//   5. HUMAN SIGN-OFF (ADR-0018 / LBA-REQ-027): a recorded, enrolled, approving human sign-off accompanies the verdict.
// machineCorroborated = stages 1-4; released = machineCorroborated AND the human sign-off. Any failing stage BLOCKS
// (fail closed) with a named reason. Dependency-free (composes the grid engines).

import { compareWitnesses } from '../acg-quorum/compare-witnesses.mjs';
import { verifyBeforeConsume, bundleDigest } from '../acg-provenance/attest.mjs';
import { assessIndependence, enrolledEnvironmentSet } from '../acg-independence/independence.mjs';
import { buildVerdictBeacon, MeshLedger, quorumFromLedger } from '../acg-mesh/verdict-beacon.mjs';
import { gateReleasePublish } from '../acg-reviewer/sign-off.mjs';

// witnesses = [{ bundle, attestation }] (the attestation supplies the recorded identity + signature).
export function runGrid({ witnesses = [], allowlist = {}, enrollment = { environments: [] }, signOffs = [], reviewerAllowlist = {}, minReviewers = 1, quorumMin = 2, threshold = 0.5 } = {}) {
  const bundles = witnesses.map((w) => w.bundle);
  const reasons = [];

  // 1. Independence (ADR-0017).
  const independence = assessIndependence(
    witnesses.map((w) => ({ bundle: w.bundle, identity: w.attestation?.witnessIdentity })),
    { enrolledEnvironments: enrolledEnvironmentSet(enrollment), quorumMin }
  );
  if (!independence.independent) reasons.push(`independence: ${independence.reasons.join('; ')}`);

  // 2. Machine quorum (ADR-0015).
  const quorum = compareWitnesses(bundles, { threshold });
  if (quorum.verdict !== 'pass') reasons.push(`quorum: ${quorum.reason ?? 'not pass'}`);

  // 3. Provenance / verify-before-consume (ADR-0016).
  const attestation = verifyBeforeConsume({ witnesses, allowlist, quorumMin, threshold });
  if (!attestation.consume) reasons.push(`attestation: ${attestation.reasons.join('; ')}`);

  // 4. Mesh delivery (ADR-0019): beacon each verdict, collect in the ledger, re-derive the quorum from it.
  const ledger = new MeshLedger();
  const bundlesByDigest = {};
  witnesses.forEach((w, i) => {
    const digest = bundleDigest(w.bundle);
    bundlesByDigest[digest] = w.bundle;
    ledger.record(buildVerdictBeacon({ identity: w.attestation?.witnessIdentity ?? w.bundle.plane, plane: w.bundle.plane, os: w.bundle.os, verdict: w.bundle.gate?.verdict, digest }, { seq: i + 1 }));
  });
  const mesh = quorumFromLedger(ledger, { bundlesByDigest, threshold });
  if (mesh.quorum.verdict !== 'pass') reasons.push(`mesh: quorum ${mesh.quorum.verdict}`);

  const machineCorroborated = independence.independent && quorum.verdict === 'pass' && attestation.consume && mesh.quorum.verdict === 'pass';

  // 5. Human sign-off (ADR-0018), layered on top of the machine grid.
  const humanSignOff = gateReleasePublish({ quorumVerdict: quorum, signOffs, reviewerAllowlist, minReviewers });
  if (!humanSignOff.publish) reasons.push(`human sign-off: ${humanSignOff.reasons.join('; ')}`);

  return {
    schema: 'labview-benchmark-actor/acg-grid-run-v1',
    released: machineCorroborated && humanSignOff.publish,
    machineCorroborated,
    witnesses: witnesses.length,
    stages: {
      independence: { ok: independence.independent, planes: independence.distinctPlanes },
      quorum: { ok: quorum.verdict === 'pass', verdict: quorum.verdict, confidence: quorum.confidence },
      attestation: { ok: attestation.consume },
      mesh: { ok: mesh.quorum.verdict === 'pass', ledgerHash: mesh.ledgerHash },
      humanSignOff: { ok: humanSignOff.publish, approvals: humanSignOff.approvals },
    },
    reasons,
  };
}
