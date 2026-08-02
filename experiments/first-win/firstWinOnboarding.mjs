#!/usr/bin/env node
// first-win-onboarding@1 composer + validator (LBA-REQ-033, realizes ADR-0023 Phase 1 -- the roadmap's
// "First Win"). The umbrella onboarding requirement is delivered by composing its already-Proven slices into
// one `lba init` flow: provision a from-scratch Ubuntu 24.04 golden VM, install LabVIEW 2026 CE + VIPM, hand
// off to the member for activation, confirm activation with a headless LabVIEWCLI probe (activation-receipt@1),
// then mint + register the VM as a mesh actor. This module proves the COMPOSITION: every step of the roadmap
// flow resolves to a real, committed, gated realization on disk, and records the live end-to-end demonstration
// on the lba-golden VM. Pure + rg-free + offline so it validates in CI (which has no VM / LabVIEW).

import { createHash } from 'node:crypto';

export const FIRST_WIN_SCHEMA = 'labview-benchmark-actor/first-win-onboarding@1';

// The roadmap (docs/roadmap.md Sec 4) First Win flow. Each step maps its acceptance criterion to the REAL,
// committed realization + the Proven requirement + the fail-closed gate that already proves that slice.
// `human` steps are the one irreducible hybrid-labor moment (NI-account activation); they have no gate.
export const FIRST_WIN_STEPS = [
  {
    step: 1,
    criterion: 'lba init detects the host + hypervisor and provisions a clean Ubuntu 24.04 (Noble) VM',
    realization: 'cleanroom/ubuntu-labview/build-virtualbox.sh',
    provenReq: 'LBA-REQ-033',
    gate: null,
  },
  {
    step: 2,
    criterion: 'the NI apt repo (committed GPG key) + ni-labview-2026-community + vipm install non-interactively',
    realization: 'cleanroom/ubuntu-labview/provision-guest.sh',
    provenReq: 'LBA-REQ-044',
    gate: 'provisioner-installs-labview-and-vipm',
  },
  {
    step: 3,
    criterion: 'the provisioned VM is headless-LabVIEW ready (Xvfb + VI Server for both exe basenames + reboot)',
    realization: 'experiments/provisioner-readiness/provisionerReadiness.mjs',
    provenReq: 'LBA-REQ-049',
    gate: 'provisioner-headless-readiness',
  },
  {
    step: 4,
    criterion: 'the member signs in to their NI account and activates LabVIEW CE + VIPM (the one hybrid human step)',
    realization: 'docs/architecture/adr/ADR-0023-personal-golden-vm-onboarding.md',
    provenReq: 'LBA-REQ-033',
    gate: null,
    human: true,
  },
  {
    step: 5,
    criterion: 'a headless LabVIEWCLI RunVI probe confirms activation and emits a signed activation-receipt@1',
    realization: 'experiments/activation/probe-activation.sh',
    provenReq: 'LBA-REQ-038',
    gate: 'activation-receipt-confirms-activation',
  },
  {
    step: 6,
    criterion: 'on a confirmed receipt the golden VM is minted locally and registered as an actor in mesh-actors.csv',
    realization: 'experiments/activation/registerMeshActor.mjs',
    provenReq: 'LBA-REQ-039',
    gate: 'mesh-actor-registration-requires-activation',
  },
];

// Resolve each step's realization against a file-existence predicate (existsFn(relPath) -> boolean).
export function analyzeFlow(existsFn) {
  const steps = FIRST_WIN_STEPS.map((s) => ({ ...s, resolved: !!existsFn(s.realization) }));
  const missing = steps.filter((s) => !s.resolved).map((s) => s.realization);
  return { steps, missing, allResolved: missing.length === 0 };
}

// Canonical verdict-bearing view (the digest input): schema + each step's identity/resolution + the flow
// verdict + the live-evidence facts (NOT volatile notes/timestamps).
function canonical(receipt) {
  const le = receipt.liveEvidence || {};
  return JSON.stringify({
    schema: receipt.schema,
    steps: (receipt.steps || []).map((s) => ({ step: s.step, realization: s.realization, provenReq: s.provenReq, gate: s.gate, resolved: s.resolved })),
    complete: receipt.verdict?.complete,
    live: { vm: le.vm, provisioned: le.provisioned, labviewActivated: le.labviewActivated, vipmActivated: le.vipmActivated, activationConfirmed: le.activationConfirmed },
  });
}

export function digestFirstWinReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// The First Win is COMPLETE iff every flow step resolves to a real realization AND the live demonstration
// confirmed activation (the functional proof) on a real VM.
export function decideComplete({ allResolved, activationConfirmed }) {
  return allResolved === true && activationConfirmed === true;
}

// Build a first-win-onboarding@1 receipt: the composed flow + the live lba-golden demonstration.
export function buildFirstWinReceipt({ existsFn, liveEvidence }) {
  const { steps, missing, allResolved } = analyzeFlow(existsFn);
  const le = liveEvidence || {};
  const complete = decideComplete({ allResolved, activationConfirmed: !!le.activationConfirmed });
  const receipt = {
    schema: FIRST_WIN_SCHEMA,
    requirement: 'LBA-REQ-033',
    steps,
    missing,
    liveEvidence: le,
    verdict: {
      complete,
      reason: complete
        ? `all ${steps.length} First Win flow steps resolve to committed realizations and activation was confirmed live on ${le.vm}`
        : allResolved
          ? 'the flow composes but no live activation was confirmed'
          : `the flow is missing realizations: ${missing.join(', ')}`,
    },
  };
  receipt.digest = digestFirstWinReceipt(receipt);
  return receipt;
}

// Validate a committed receipt against the ACTUAL repo (existsFn): re-derive each step's resolution, assert
// every step maps to a Proven requirement + resolves, the completeness verdict matches, activation was
// confirmed, and the digest is intact. Fail-closed -- a dropped realization, a forged verdict, an
// unconfirmed activation, or a tampered digest yields ok=false.
export function validateFirstWinReceipt(receipt, existsFn) {
  const findings = [];
  if (!receipt || receipt.schema !== FIRST_WIN_SCHEMA) findings.push(`schema must be ${FIRST_WIN_SCHEMA}`);
  if (!receipt || !Array.isArray(receipt.steps) || !receipt.verdict || !receipt.liveEvidence) {
    return { ok: false, complete: false, findings: findings.concat('missing steps/verdict/liveEvidence') };
  }
  const derived = analyzeFlow(existsFn);
  if (receipt.steps.length !== derived.steps.length) findings.push('receipt records a different step set than the flow');
  for (const d of derived.steps) {
    const rec = receipt.steps.find((s) => s.step === d.step);
    if (!rec) { findings.push(`receipt is missing flow step ${d.step}`); continue; }
    if (rec.realization !== d.realization) findings.push(`step ${d.step} realization drifted from the flow`);
    if (rec.resolved !== d.resolved) findings.push(`step ${d.step} resolved=${rec.resolved} contradicts the repo (${d.resolved})`);
    if (!/^LBA-REQ-\d+$/.test(rec.provenReq || '')) findings.push(`step ${d.step} has no Proven requirement`);
    if (!d.resolved) findings.push(`step ${d.step} realization ${d.realization} is missing on disk`);
  }
  const activationConfirmed = !!receipt.liveEvidence.activationConfirmed;
  if (!activationConfirmed) findings.push('liveEvidence.activationConfirmed must be true (the functional activation proof)');
  const expectedComplete = decideComplete({ allResolved: derived.allResolved, activationConfirmed });
  if (receipt.verdict.complete !== expectedComplete) findings.push(`verdict.complete=${receipt.verdict.complete} contradicts the flow (${expectedComplete})`);
  if (!expectedComplete) findings.push('the First Win is not complete: a missing realization or an unconfirmed activation');
  if (receipt.digest !== digestFirstWinReceipt(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, complete: !!receipt.verdict.complete && findings.length === 0, findings };
}

// Human-readable flow description for `lba init` (plan mode).
export function describeFlow(existsFn) {
  const { steps, allResolved } = analyzeFlow(existsFn);
  const lines = ['First Win — one-command personal golden-VM onboarding (LBA-REQ-033, roadmap Sec 4):', ''];
  for (const s of steps) {
    const mark = s.human ? 'HUMAN' : s.resolved ? 'ok   ' : 'MISS ';
    lines.push(`  ${mark} step ${s.step}: ${s.criterion}`);
    lines.push(`         -> ${s.realization}  [${s.provenReq}${s.gate ? ' / ' + s.gate : ''}]`);
  }
  lines.push('');
  lines.push(allResolved ? 'All flow steps resolve to committed realizations.' : 'Some realizations are missing.');
  return lines.join('\n');
}
