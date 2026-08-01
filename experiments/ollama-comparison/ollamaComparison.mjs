#!/usr/bin/env node
// Ollama-comparison core (LBA-REQ-010 AC #3): the host-side layer that compares an actor's previous runs
// over a concentrated corpus (from experiments/host-concentration) to improve the analysis. Dependency-free
// ESM; the ollama DRIVE is injected (a mock in the self-test, the #22 ollama-drive relay in production), so
// the deterministic PLANNING + output contract are proven with no GPU / no live ollama.
//
// Runs on the operator HOST (not inside an actor VM) and operates on RUN DATA only -- never the coordination
// bus (ADR-0006 / ADR-0008). Comparisons stay within each actor's OWN run history (LBA-REQ-010 AC #1: no
// cross-VM run comparison); the concentrated corpus keeps per-actor isolation, so a plan never pairs runs
// from different actors.

import { SCHEMA as CORPUS_SCHEMA } from '../host-concentration/hostConcentration.mjs';

export const SCHEMA = 'labview-benchmark-actor/ollama-comparison@v1';

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

/**
 * Build a deterministic comparison plan from a concentrated host corpus: for each actor, pair its runs
 * consecutively (previous -> next) so the ollama layer explains the run-over-run change. Same-actor pairs
 * only (isolation); an actor with a single run yields no comparison. Each item carries a deterministic
 * prompt referencing the two runs' metrics/frames refs for the host ollama layer to compare over.
 */
export function buildComparisonPlan(corpus) {
  assert(corpus && corpus.schema === CORPUS_SCHEMA, 'input must be a host-concentration corpus');
  assert(Array.isArray(corpus.runs), 'corpus needs a runs array');
  const byActor = new Map();
  for (const run of corpus.runs) {
    if (!byActor.has(run.actorId)) {
      byActor.set(run.actorId, []);
    }
    byActor.get(run.actorId).push(run);
  }
  const comparisons = [];
  for (const actorId of [...byActor.keys()].sort()) {
    const runs = byActor.get(actorId).slice().sort((a, b) => a.runId.localeCompare(b.runId));
    for (let i = 1; i < runs.length; i += 1) {
      const baseline = runs[i - 1];
      const candidate = runs[i];
      comparisons.push({
        actorId,
        baselineRunId: baseline.runId,
        candidateRunId: candidate.runId,
        prompt:
          `Compare benchmark runs for actor ${actorId}: baseline ${baseline.runId} ` +
          `(metrics ${baseline.metricsRef ?? 'n/a'}, frames ${baseline.framesRef ?? 'n/a'}) ` +
          `vs candidate ${candidate.runId} ` +
          `(metrics ${candidate.metricsRef ?? 'n/a'}, frames ${candidate.framesRef ?? 'n/a'}). ` +
          `Summarize the run-over-run change in performance.`,
      });
    }
  }
  return { schema: SCHEMA, comparisonCount: comparisons.length, comparisons };
}

/**
 * Execute a comparison plan by driving each prompt through the injected ollama driver (a mock in tests, the
 * ollama-drive relay in production). Returns the plan enriched with each comparison's verdict. The driver
 * sees ONLY the run-derived prompt -- never bus traffic.
 */
export async function compareOverCorpus(corpus, driveFn) {
  assert(typeof driveFn === 'function', 'driveFn must be a function (a mock or the ollama-drive relay)');
  const plan = buildComparisonPlan(corpus);
  const results = [];
  for (const c of plan.comparisons) {
    // eslint-disable-next-line no-await-in-loop -- deterministic sequential drive keeps the receipt stable.
    const verdict = await driveFn(c.prompt);
    results.push({ actorId: c.actorId, baselineRunId: c.baselineRunId, candidateRunId: c.candidateRunId, verdict });
  }
  return { schema: SCHEMA, comparisonCount: results.length, results };
}

// --- Faithfulness scoring (shared with the maintainer model-faithfulness-sweep AND the provider-delegation
// quality pre-gate) -----------------------------------------------------------------------------------------
// A model reads a run-over-run change and describes its DIRECTION; these word classes let us score whether the
// text faithfully reports "up" (regression / higher) vs "down" (improvement / lower) -- a deterministic,
// model-free faithfulness signal.
export const FAITHFULNESS_UP = /\b(increas\w*|higher|rose|grew|grow\w*|greater|regress\w*|worse\w*|degrad\w*|climb\w*|jump\w*)/gi;
export const FAITHFULNESS_DOWN = /\b(decreas\w*|lower|fell|drop\w*|reduc\w*|improv\w*|better|gain\w*|declin\w*|less\b|fewer)/gi;

// Score one verdict: which direction does the text predict (majority of direction words), and is it correct?
export function scoreDirection(text, expectedDir) {
  const up = (String(text).match(FAITHFULNESS_UP) || []).length;
  const down = (String(text).match(FAITHFULNESS_DOWN) || []).length;
  const predicted = up === down ? 'tie' : up > down ? 'up' : 'down';
  return { predicted, correct: predicted === expectedDir, up, down };
}
