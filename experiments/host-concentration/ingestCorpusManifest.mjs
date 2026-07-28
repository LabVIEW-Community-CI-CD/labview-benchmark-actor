#!/usr/bin/env node
// Corpus-manifest ingestion (LBA-REQ-010): the CONTRACT BOUNDARY between the multi-VM topology's
// run-topology.ps1 output (WIN plane) and the host-concentration core (LINUX plane). It reads a corpus
// manifest FILE, normalizes it (accepting either a bare per-actor array OR a { corpora: [...] } envelope
// that carries topology metadata), validates every entry against the concentrate() input shape, and feeds
// it into the host-concentration + ollama-comparison layers. This is the glue that turns a REAL 2-actor
// topology run into a concentrate -> compare proof: WIN emits the manifest from the golden-box VMs, and this
// module ingests it on the operator host WITHOUT any hand editing. Dependency-free ESM; deterministic.
//
// The validation has TEETH: a drift in the PowerShell output (a missing actorId or runId, a non-array runs
// field, a non-manifest object) surfaces here with a clear, entry-scoped message instead of failing deep
// inside concentrate() -- so WIN gets fast, actionable feedback if run-topology.ps1 output shape ever moves.

import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { concentrate } from './hostConcentration.mjs';

export const MANIFEST_SCHEMA = 'labview-benchmark-actor/corpus-manifest@v1';

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

/**
 * Normalize a raw parsed manifest into the corpora array that concentrate() expects. Accepts either a bare
 * array of per-actor corpora OR an envelope { corpora: [...] } (what run-topology.ps1 emits with topology
 * metadata). Validates every entry carries a non-empty string actorId + a runs array whose runs each carry a
 * non-empty string runId, so a drift in the emitted shape surfaces here with a clear message.
 */
export function normalizeManifest(raw) {
  let corpora;
  if (Array.isArray(raw)) {
    corpora = raw;
  } else if (raw && typeof raw === 'object' && Array.isArray(raw.corpora)) {
    corpora = raw.corpora;
  } else {
    throw new Error('manifest must be a per-actor corpora array or an { corpora: [...] } envelope');
  }
  assert(corpora.length > 0, 'manifest carries no per-actor corpora');
  corpora.forEach((c, i) => {
    assert(c && typeof c.actorId === 'string' && c.actorId, `corpus[${i}] needs a non-empty string actorId`);
    assert(Array.isArray(c.runs), `corpus[${i}] (${c.actorId}) needs a runs array`);
    c.runs.forEach((r, j) => {
      assert(
        r && typeof r.runId === 'string' && r.runId,
        `corpus[${i}].runs[${j}] (${c.actorId}) needs a non-empty string runId`
      );
    });
  });
  return corpora;
}

/** Read + parse + normalize a manifest FILE into the corpora array. */
export function ingestFile(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read/parse corpus manifest at ${path}: ${err.message}`);
  }
  return normalizeManifest(raw);
}

/**
 * Ingest a manifest (a file path or an already-parsed manifest/corpora) and concentrate it into the single
 * per-actor-isolated host corpus. This is the one call the maintainer/live driver makes to turn WIN's
 * emitted manifest into the corpus that feeds buildComparisonPlan + the live ollama drive.
 */
export function concentrateManifest(source, opts = {}) {
  const corpora = typeof source === 'string' ? ingestFile(source) : normalizeManifest(source);
  return concentrate(corpora, opts);
}

/**
 * Dereference each run's VM-local metricsRef (a path, relative to baseDir) into a compact metric summary
 * string in place, so buildComparisonPlan embeds the REAL metric values in each prompt. This is the host-side
 * out-of-band read: the manifest carries a PATH to VM-local run data, and the host resolves + reads it here
 * before prompting -- run data never travels over the coordination bus (ADR-0006 / ADR-0008). A missing or
 * unreadable metrics file throws with the offending actor/run/path so a broken export surfaces clearly.
 */
export function dereferenceMetrics(corpus, baseDir) {
  for (const run of corpus.runs) {
    if (!run.metricsRef) {
      continue;
    }
    const metricsPath = isAbsolute(run.metricsRef) ? run.metricsRef : join(baseDir, run.metricsRef);
    let m;
    try {
      m = JSON.parse(readFileSync(metricsPath, 'utf8'));
    } catch (err) {
      throw new Error(
        `cannot dereference metricsRef for ${run.actorId}/${run.runId} at ${metricsPath}: ${err.message}`
      );
    }
    run.metricsRef =
      `cpuMean=${m.cpuMeanPct}pct, ramMeanMiB=${m.ramMeanMiB}, durationMs=${m.durationMs}` +
      (m.framesRendered != null ? `, framesRendered=${m.framesRendered}` : '');
  }
  return corpus;
}
