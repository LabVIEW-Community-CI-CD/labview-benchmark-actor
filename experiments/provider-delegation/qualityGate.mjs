#!/usr/bin/env node
// Quality PRE-gate: score a provider DRAFT for faithfulness to the task BEFORE running the (expensive) domain
// acceptance gate, so a weak / off-topic / hallucinated / refusal draft is caught early -- and the coverage
// measurement / tool run / etc. is short-circuited. Reuses the ollama-comparison FAITHFULNESS scorer
// (scoreDirection) so the direction-faithfulness signal has a single source of truth. Dependency-free.
//
// The gate is LIGHT by default (non-empty + not-a-refusal) so existing domains are unaffected; it tightens
// when a task carries `quality { expectTerms, expectDirection, minFaithfulness, minChars }`.

import { scoreDirection } from '../ollama-comparison/ollamaComparison.mjs';

const REFUSAL = /\b(I can'?t|I cannot|I'?m sorry|I am sorry|as an AI|unable to (?:help|assist|comply))\b/i;

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Faithfulness score in [0,1]: the fraction of the task's expected terms that appear in the draft (1 when no
// terms are declared). A model-free, deterministic proxy for "does the draft address the actual brief".
export function scoreFaithfulness(output, expectTerms = []) {
  const text = String(output || '');
  if (!Array.isArray(expectTerms) || expectTerms.length === 0) return { score: 1, hit: 0, total: 0 };
  const hit = expectTerms.filter((t) => new RegExp(escapeRe(t), 'i').test(text)).length;
  return { score: Math.round((hit / expectTerms.length) * 100) / 100, hit, total: expectTerms.length };
}

// Pre-gate a draft. Returns { ok, score, checks, refusal, ... }. ok=false -> reject before the domain gate.
export function qualityPreGate(task, output, opts = {}) {
  const q = (task && task.quality) || {};
  const text = String(output || '');
  const minChars = Number.isFinite(q.minChars) ? q.minChars : 1;
  const minFaithfulness = Number.isFinite(q.minFaithfulness) ? q.minFaithfulness : (opts.minFaithfulness ?? 0.5);
  const nonEmpty = text.trim().length >= minChars;
  const refusal = REFUSAL.test(text);
  const f = scoreFaithfulness(text, q.expectTerms);
  const checks = [
    { name: `non-empty>=${minChars}`, ok: nonEmpty },
    { name: 'not-a-refusal', ok: !refusal },
    { name: `faithfulness>=${minFaithfulness}`, ok: f.score >= minFaithfulness },
  ];
  if (q.expectDirection) {
    checks.push({ name: `direction:${q.expectDirection}`, ok: scoreDirection(text, q.expectDirection).correct });
  }
  const ok = checks.every((c) => c.ok);
  return { ok, score: f.score, termsHit: f.hit, termsTotal: f.total, refusal, minFaithfulness, checks };
}
