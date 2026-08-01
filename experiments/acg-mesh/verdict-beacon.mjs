#!/usr/bin/env node
// verdict-beacon.mjs -- ACG mesh verdict beacon + ledger (ADR-0019, LBA-REQ-028).
//
// Witnesses beacon their corroboration verdict over the EXISTING lbabus mesh -- reusing the ADR-0003 `bus-msg@1`
// wire (4-byte BE length-prefixed JSON, via the shared busFrame) and the gate-suite verdict-beacon pattern, with
// NO new transport. Per the bus comms-only doctrine (ADR-0003 §5 / LBA-REQ-007) the beacon carries only the small
// verdict NOTE + the witness-bundle DIGEST (which binds it to the bundle the attestation signs) -- never the
// bundle or receipts. A mesh LEDGER records the beaconed verdicts (append-only, dedup by witness, tamper-evident)
// so a bus observer sees each witness's outcome live, and the ledger feeds the provenance store. Dependency-free.

import { createHash } from 'node:crypto';
import { makeEnvelope, BUS_SCHEMA } from '../provider-delegation/busFrame.mjs';
import { compareWitnesses } from '../acg-quorum/compare-witnesses.mjs';
import { bundleDigest } from '../acg-provenance/attest.mjs';

export const VERDICT_TASK = 'acg-verdict';

// Build a `bus-msg@1` verdict-beacon envelope for a witness -- the small comms-only NOTE the mesh carries.
export function buildVerdictBeacon(witness, { sessionId = 'acg-grid', seq = 0 } = {}) {
  if (!witness || !witness.identity) throw new Error('buildVerdictBeacon: witness.identity is required');
  const payload = {
    witnessIdentity: witness.identity,
    plane: witness.plane ?? null,
    os: witness.os ?? null,
    verdict: witness.verdict ?? null, // the witness's gate verdict (pass/fail)
    digest: witness.digest ?? null, // the acg-witness-bundle digest -- binds the beacon to the bundle the attestation signs
    seriesHash: witness.seriesHash ?? null,
    sourceCommit: witness.sourceCommit ?? null,
  };
  return makeEnvelope({ senderId: witness.identity, sessionId, seq, type: 'NOTE', task: VERDICT_TASK, payload });
}

// Parse + validate a verdict-beacon envelope; fails closed on a wrong schema/task or a missing witness/digest/verdict.
export function parseVerdictBeacon(env) {
  if (!env || env.schema !== BUS_SCHEMA) throw new Error('not a bus-msg@1 envelope');
  if (env.task !== VERDICT_TASK) throw new Error(`not an ${VERDICT_TASK} beacon (task=${env.task ?? 'none'})`);
  const p = env.payload || {};
  if (!p.witnessIdentity) throw new Error('verdict beacon missing witnessIdentity');
  if (!p.digest) throw new Error('verdict beacon missing bundle digest');
  if (!p.verdict) throw new Error('verdict beacon missing verdict');
  return {
    witnessIdentity: p.witnessIdentity, plane: p.plane ?? null, os: p.os ?? null,
    verdict: p.verdict, digest: p.digest, seriesHash: p.seriesHash ?? null, sourceCommit: p.sourceCommit ?? null,
    senderId: env.senderId ?? null, seq: env.seq ?? 0,
  };
}

// Append-only mesh ledger of beaconed verdicts. Dedup by witnessIdentity (keeps the highest seq -- rejects replays
// and stale seqs); tamper-evident ledgerHash over the ordered accepted log. Feeds the provenance store (ADR-0016).
export class MeshLedger {
  constructor() {
    this.log = [];
    this.byWitness = new Map();
  }

  // Record a raw envelope from the bus. Returns { accepted, reason?, notice? }.
  record(env) {
    let notice;
    try {
      notice = parseVerdictBeacon(env);
    } catch (e) {
      return { accepted: false, reason: e.message };
    }
    const prev = this.byWitness.get(notice.witnessIdentity);
    if (prev && notice.seq <= prev.seq) return { accepted: false, reason: `stale seq ${notice.seq} <= ${prev.seq}`, notice };
    this.byWitness.set(notice.witnessIdentity, notice);
    this.log.push({ witnessIdentity: notice.witnessIdentity, verdict: notice.verdict, digest: notice.digest, seq: notice.seq });
    return { accepted: true, notice };
  }

  witnesses() {
    return [...this.byWitness.values()];
  }

  verdicts() {
    return Object.fromEntries([...this.byWitness].map(([k, v]) => [k, v.verdict]));
  }

  // Tamper-evident hash over the ordered accepted log (the ledger digest the provenance store records).
  ledgerHash() {
    return createHash('sha256').update(JSON.stringify(this.log)).digest('hex');
  }
}

// Compose the mesh with the quorum: resolve each ledger witness to its bundle (by digest), FAIL CLOSED on a
// missing or digest-mismatched bundle (a beacon cannot corroborate a bundle it did not produce), then run the
// quorum over the resolved bundles. `bundlesByDigest` maps a bundle digest -> the acg-witness-bundle.
export function quorumFromLedger(ledger, { bundlesByDigest = {}, threshold = 0.5 } = {}) {
  const resolved = [];
  const missing = [];
  const mismatched = [];
  for (const w of ledger.witnesses()) {
    const bundle = bundlesByDigest[w.digest];
    if (!bundle) {
      missing.push({ witnessIdentity: w.witnessIdentity, digest: w.digest });
    } else if (bundleDigest(bundle) !== w.digest) {
      mismatched.push({ witnessIdentity: w.witnessIdentity, digest: w.digest });
    } else {
      resolved.push(bundle);
    }
  }
  const quorum = resolved.length >= 2
    ? compareWitnesses(resolved, { threshold })
    : { verdict: 'error', reason: 'fewer than two resolved witnesses', confidence: 0, witnesses: resolved.length };
  return {
    schema: 'labview-benchmark-actor/acg-mesh-quorum-v1',
    ledgerHash: ledger.ledgerHash(),
    beaconed: ledger.witnesses().length,
    resolved: resolved.length,
    missing,
    mismatched,
    quorum,
  };
}
