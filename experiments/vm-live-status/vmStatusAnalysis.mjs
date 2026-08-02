#!/usr/bin/env node
// vm-status-timeline@1 analyzer + validator (LBA-REQ-047, realizes ADR-0023 Phase 1 -- live golden-VM
// visibility). The human-assisted golden-VM workflow has long stretches where neither human nor agent can
// see what the VM is doing (e.g. LabVIEW sits idle while VIPM silently waits to connect) -- "dead time".
// The live monitor (experiments/vm-live-status/vm-live-status.sh) samples the VM's overall CPU busy% (plus
// LabVIEW cpu/mem + vipm/Xvfb presence) on a fixed cadence; THIS module turns a captured sample series into
// a deterministic idle-time analysis: contiguous idle vs busy spans, idle %, and the longest idle run.
//
// Pure + rg-free + offline: a committed timeline receipt re-derives its analysis byte-stably in CI (which
// has no VM / ssh). The digest seals the raw samples + the derived analysis; the gate fails closed if the
// committed analysis does not match a fresh re-derivation from the samples, or the digest is tampered.

import { createHash } from 'node:crypto';

export const TIMELINE_SCHEMA = 'labview-benchmark-actor/vm-status-timeline@1';

const round1 = (x) => Math.round(x * 10) / 10;

// A sample is IDLE when overall CPU busy% is below the threshold, else BUSY.
export function classifySample(sample, idleCpuThreshold) {
  return (Number(sample?.cpuPct) || 0) < idleCpuThreshold ? 'idle' : 'busy';
}

// Turn a sample series into an idle-time analysis. Each sample represents `sampleIntervalSec` seconds.
// Consecutive same-class samples form a span; idle spans are the "dead time" we want to surface.
// samples: [{ t, cpuPct, ... }] with t = seconds since capture start (monotonic non-decreasing).
export function analyzeTimeline({ samples, sampleIntervalSec, idleCpuThreshold }) {
  const s = Array.isArray(samples) ? samples : [];
  const dt = Number(sampleIntervalSec) || 0;
  const thr = Number(idleCpuThreshold) || 0;
  const n = s.length;

  const spans = [];
  let idleSamples = 0;
  let busySamples = 0;
  for (let i = 0; i < n; i++) {
    const kind = classifySample(s[i], thr);
    if (kind === 'idle') idleSamples += 1; else busySamples += 1;
    const last = spans[spans.length - 1];
    if (last && last.kind === kind) {
      last.sampleCount += 1;
    } else {
      spans.push({ kind, startT: s[i].t, sampleCount: 1 });
    }
  }
  for (const sp of spans) sp.durSec = round1(sp.sampleCount * dt);

  const idleSpans = spans
    .filter((sp) => sp.kind === 'idle')
    .map((sp) => ({ startT: sp.startT, durSec: sp.durSec, sampleCount: sp.sampleCount }));
  const totalSec = round1(n * dt);
  const idleSec = round1(idleSamples * dt);
  const busySec = round1(busySamples * dt);
  const idlePct = totalSec > 0 ? round1((100 * idleSec) / totalSec) : 0;
  const longestIdleRunSec = idleSpans.reduce((m, sp) => Math.max(m, sp.durSec), 0);

  return {
    totalSamples: n,
    sampleIntervalSec: dt,
    idleCpuThreshold: thr,
    totalSec,
    idleSec,
    busySec,
    idlePct,
    longestIdleRunSec,
    transitions: Math.max(0, spans.length - 1),
    idleSpans,
  };
}

// Canonical deterministic view: the raw samples (t + cpuPct) + params + the derived analysis.
function canonical(receipt) {
  const samples = (receipt.samples || []).map((p) => ({ t: p.t, cpuPct: p.cpuPct }));
  return JSON.stringify({
    schema: receipt.schema,
    sampleIntervalSec: receipt.sampleIntervalSec ?? null,
    idleCpuThreshold: receipt.idleCpuThreshold ?? null,
    samples,
    analysis: receipt.analysis ?? null,
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build a vm-status-timeline@1 receipt from a captured sample series (deterministic + digest-sealed).
export function buildStatusTimelineReceipt(capture) {
  const samples = (capture.samples || []).map((p) => ({
    t: p.t,
    cpuPct: p.cpuPct,
    lvCpuPct: p.lvCpuPct ?? null,
    lvMemMb: p.lvMemMb ?? null,
    vipm: p.vipm ?? null,
    xvfb: p.xvfb ?? null,
  }));
  const sampleIntervalSec = capture.sampleIntervalSec ?? 0;
  const idleCpuThreshold = capture.idleCpuThreshold ?? 5;
  const analysis = analyzeTimeline({ samples, sampleIntervalSec, idleCpuThreshold });
  const receipt = {
    schema: TIMELINE_SCHEMA,
    vm: capture.vm ?? null,
    note: capture.note ?? null,
    sampleIntervalSec,
    idleCpuThreshold,
    samples,
    analysis,
  };
  receipt.digest = digestReceipt(receipt);
  return receipt;
}

// Validate a committed receipt: schema, non-trivial series, that the committed analysis matches a fresh
// re-derivation from the samples (drift = tampered/stale), and that the digest is intact.
export function validateStatusTimelineReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== TIMELINE_SCHEMA) findings.push(`schema must be ${TIMELINE_SCHEMA}`);
  const samples = Array.isArray(receipt?.samples) ? receipt.samples : [];
  if (samples.length < 2) findings.push('timeline must have >= 2 samples');
  for (let i = 1; i < samples.length; i++) {
    if (!(samples[i].t >= samples[i - 1].t)) { findings.push('sample times must be monotonic non-decreasing'); break; }
  }
  const expected = analyzeTimeline({
    samples,
    sampleIntervalSec: receipt?.sampleIntervalSec,
    idleCpuThreshold: receipt?.idleCpuThreshold,
  });
  if (JSON.stringify(expected) !== JSON.stringify(receipt?.analysis)) {
    findings.push('committed analysis does not match a fresh re-derivation from the samples (stale/tampered)');
  }
  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match the sealed fields (tampered)');
  return { ok: findings.length === 0, analysis: receipt?.analysis || null, findings };
}
