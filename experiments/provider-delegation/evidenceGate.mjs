#!/usr/bin/env node
// evidence domain: gather the delegation receipts produced by prior uplift tasks, VALIDATE them, and gate a
// provider's evidence SUMMARY for accuracy. This is the meta-domain that keeps the evidence trail honest:
//   - gather:  read each receipt path, schema-check it (lba-uplift-delegation-receipt@v1), tally by verdict;
//   - gate:    every receipt is valid + count >= minReceipts;
//   - ground:  the provider's Markdown summary must state the TRUE total + pass counts (anti-hallucination).
// Dependency-free (node: builtins only). The provider summarizes; the numbers are checked against ground truth.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RECEIPT_SCHEMA = 'labview-benchmark-actor/lba-uplift-delegation-receipt@v1';
export const EVIDENCE_BUNDLE_SCHEMA = 'labview-benchmark-actor/lba-evidence-bundle@v1';

// Read + schema-validate each receipt path. Returns { valid, invalid[], byVerdict, receipts[] }.
export function gatherReceipts(paths, baseDir = REPO) {
  const receipts = [];
  const invalid = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.resolve(baseDir, p);
    try {
      const r = JSON.parse(fs.readFileSync(abs, 'utf8'));
      if (r && r.schema === RECEIPT_SCHEMA && typeof r.verdict === 'string' && r.task && typeof r.task.id === 'string') {
        receipts.push(r);
      } else {
        invalid.push({ path: p, reason: 'not a valid lba-uplift-delegation-receipt@v1' });
      }
    } catch (e) {
      invalid.push({ path: p, reason: String(e && e.message ? e.message : e) });
    }
  }
  const byVerdict = {};
  for (const r of receipts) byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
  return { valid: receipts.length, invalid, byVerdict, receipts };
}

// A durable evidence bundle (a receipt-of-receipts) tallying the gathered delegation receipts.
export function buildEvidenceBundle(gathered, task) {
  return {
    schema: EVIDENCE_BUNDLE_SCHEMA,
    generatedAt: new Date().toISOString(),
    id: task.id,
    total: gathered.valid + gathered.invalid.length,
    valid: gathered.valid,
    invalid: gathered.invalid.length,
    byVerdict: gathered.byVerdict,
    ids: gathered.receipts.map((r) => r.task.id),
  };
}

// Prompt: give the provider the per-receipt verdicts and ask it to state the total + pass counts, so the
// grounding gate can check it reported the evidence accurately (not hallucinated numbers).
export function buildEvidencePrompt(task, opts = {}) {
  const gathered = gatherReceipts(Array.isArray(task.receipts) ? task.receipts : [], opts.baseDir || REPO);
  const verdicts = gathered.receipts.map((r) => `${r.task.id}=${r.verdict}`).join(', ');
  return (
    `You are an evidence agent for the labview-benchmark-actor project. Task ${task.id}. ` +
    `${task.brief || ''}\n\nHere are ${gathered.valid} delegation receipts and their verdicts: ${verdicts}.\n` +
    `Write a short Markdown summary that STATES the total number of receipts and how many PASSED (as digits). ` +
    `Output only the Markdown summary.`
  );
}

function mentionsNumber(text, n) {
  return new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(String(text || ''));
}

// Acceptance: the receipts gather + validate (all valid, count >= minReceipts) AND, when a provider summary
// is supplied, it accurately states the true total + pass counts. Returns { checks, verdict, evidence }.
export function acceptanceEvidence(task, providerText, opts = {}) {
  const baseDir = opts.baseDir || REPO;
  const paths = Array.isArray(task.receipts) ? task.receipts : [];
  const gathered = gatherReceipts(paths, baseDir);
  const bundle = buildEvidenceBundle(gathered, task);
  const minReceipts = Number.isFinite(task.minReceipts) ? task.minReceipts : 1;
  const passCount = gathered.byVerdict.pass || 0;
  const checks = [
    { name: `receipts>=${minReceipts}`, ok: gathered.valid >= minReceipts },
    { name: 'all-receipts-valid', ok: gathered.invalid.length === 0 },
  ];
  if (typeof providerText === 'string' && providerText.length > 0) {
    checks.push({ name: `summary-states-total:${gathered.valid}`, ok: mentionsNumber(providerText, gathered.valid) });
    checks.push({ name: `summary-states-pass:${passCount}`, ok: mentionsNumber(providerText, passCount) });
  }
  const verdict = checks.every((c) => c.ok) ? 'pass' : 'fail';
  return { checks, verdict, evidence: bundle };
}
