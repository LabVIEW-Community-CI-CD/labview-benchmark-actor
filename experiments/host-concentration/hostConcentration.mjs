#!/usr/bin/env node
// Host-concentration core (LBA-REQ-010): concentrate each actor's OWN completed-run corpus onto the
// operator host OUT-OF-BAND (never over the coordination bus), preserving strict per-actor isolation, to
// feed the host-side ollama comparison layer. Dependency-free ESM; deterministic; no GPU / no live ollama.
//
// Separation of concerns (ADR-0006 / ADR-0008): the coordination BUS carries comms only; RUN DATA lives
// VM-local and reaches the host only by this explicit out-of-band concentration step. This module operates
// on run-data corpora ONLY and REJECTS any bus-shaped envelope, enforcing that invariant in code rather
// than by convention.

export const SCHEMA = 'labview-benchmark-actor/host-concentration@v1';

// Substrings that mark a coordination-bus message; if an input carries any, it is bus traffic, not run
// data, and MUST be rejected (the bus is never a run-data channel).
const BUS_MARKERS = ['vihs-collab-msg', 'ackOf', 'senderId'];

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

function isBusShaped(obj) {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  const json = JSON.stringify(obj);
  return BUS_MARKERS.some((m) => json.includes(m));
}

/** A stable dep-free content digest (FNV-1a 32-bit, hex) for determinism assertions. */
export function digest(value) {
  const s = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Concentrate per-actor corpora into a single host corpus. Each input corpus is
 * { actorId, runs: [{ runId, completedAt?, metricsRef?, framesRef? }] }. Every concentrated run RETAINS
 * its source actorId (isolation), runs are ordered deterministically (actorId, runId), and the corpus
 * carries a content digest. Throws on a bus-shaped input (run data only), a duplicate actorId (each VM
 * concentrates once), or a malformed corpus.
 */
export function concentrate(corpora, { concentratedAt = '1970-01-01T00:00:00.000Z' } = {}) {
  assert(Array.isArray(corpora), 'corpora must be an array');
  const runs = [];
  const actors = [];
  for (const corpus of corpora) {
    assert(corpus && typeof corpus.actorId === 'string' && corpus.actorId, 'each corpus needs an actorId');
    assert(!isBusShaped(corpus), `corpus for ${corpus.actorId} is bus-shaped: run data only, never bus traffic`);
    assert(Array.isArray(corpus.runs), `corpus for ${corpus.actorId} needs a runs array`);
    actors.push(corpus.actorId);
    for (const run of corpus.runs) {
      assert(run && typeof run.runId === 'string' && run.runId, `a run in ${corpus.actorId} needs a runId`);
      // Stamp the source actor onto every run so ownership is never ambiguous after the merge.
      runs.push({
        actorId: corpus.actorId,
        runId: run.runId,
        completedAt: run.completedAt ?? null,
        metricsRef: run.metricsRef ?? null,
        framesRef: run.framesRef ?? null,
      });
    }
  }
  const uniqueActors = [...new Set(actors)];
  assert(uniqueActors.length === actors.length, 'duplicate actorId in corpora (each actor concentrates once)');
  runs.sort((a, b) => (a.actorId === b.actorId ? a.runId.localeCompare(b.runId) : a.actorId.localeCompare(b.actorId)));
  const corpus = {
    schema: SCHEMA,
    concentratedAt,
    actors: uniqueActors.slice().sort(),
    runCount: runs.length,
    runs,
  };
  corpus.corpusDigest = digest({ actors: corpus.actors, runs: corpus.runs });
  return corpus;
}

/**
 * An actor reviews only its OWN runs (LBA-REQ-010 AC #1: no cross-VM comparison at the actor level).
 * Returns exactly the runs whose source actorId matches, from the concentrated corpus.
 */
export function reviewOwnRuns(corpus, actorId) {
  assert(corpus && corpus.schema === SCHEMA, 'not a host-concentration corpus');
  return corpus.runs.filter((r) => r.actorId === actorId);
}
