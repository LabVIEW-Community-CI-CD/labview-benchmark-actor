#!/usr/bin/env node
// Delegate an "uplift domain" or documentation-drafting task to a provider (Ollama / Copilot CLI / Codex /
// mock) and produce a VALIDATED receipt. This is the unit a cleanroom actor runs after it self-certifies
// (gate suite): it takes a task-spec (lba-uplift-task@v1), drives the chosen provider, applies a
// DETERMINISTIC acceptance gate to the output, writes the drafted artifact + a receipt
// (lba-uplift-delegation-receipt@v1), and -- optionally -- announces the receipt over the lbabus bus
// (ADR-0003 DONE frame) so a host observer collects distributed cleanroom results over TCP.
//
// Provider output is non-deterministic, but the TASK-SPEC, the ACCEPTANCE GATE, and the RECEIPT are
// deterministic, so the harness is proven with a mock provider (verify-provider-delegation.mjs), no GPU.

import fs from 'node:fs';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { selectAdapter } from './providerAdapters.mjs';
import { buildCoverageLiftPrompt, acceptanceCoverageLift } from './coverageLift.mjs';
import { buildRiskyTestPrompt, acceptanceRiskyTest } from './riskyTest.mjs';
import { buildEvidencePrompt, acceptanceEvidence } from './evidenceGate.mjs';
import { qualityPreGate } from './qualityGate.mjs';

export const TASK_SCHEMA = 'labview-benchmark-actor/lba-uplift-task@v1';
export const RECEIPT_SCHEMA = 'labview-benchmark-actor/lba-uplift-delegation-receipt@v1';
const BUS_SCHEMA = 'labview-benchmark-actor/bus-msg@1';
export const DOMAINS = ['doc-draft', 'coverage-lift', 'risky-test', 'evidence'];

export function validateTask(task) {
  if (!task || task.schema !== TASK_SCHEMA) throw new Error(`task.schema must be ${TASK_SCHEMA}`);
  if (!DOMAINS.includes(task.domain)) throw new Error(`task.domain must be one of ${DOMAINS.join('|')}`);
  if (!task.id || typeof task.id !== 'string') throw new Error('task.id (string) required');
  if (!task.brief || typeof task.brief !== 'string') throw new Error('task.brief (string) required');
  return true;
}

// Build the provider prompt from the task-spec: the brief + an explicit output contract (required sections +
// minimum length) so a REAL provider is steered to satisfy the SAME acceptance gate the mock satisfies.
export function buildPrompt(task) {
  if (task.domain === 'coverage-lift') return buildCoverageLiftPrompt(task);
  if (task.domain === 'risky-test') return buildRiskyTestPrompt(task);
  if (task.domain === 'evidence') return buildEvidencePrompt(task);
  const sections = Array.isArray(task.requiredSections) ? task.requiredSections : [];
  const min = Number.isFinite(task.minChars) ? task.minChars : 200;
  let p = `You are a ${task.domain} agent for the labview-benchmark-actor project. `;
  p += `Task ${task.id}. ${task.brief}\n\n`;
  if (sections.length) p += `Your output MUST be Markdown containing a level-2 heading (## <name>) for each of these sections: ${sections.join(', ')}.\n`;
  p += `Write at least ${min} characters. Output only the Markdown document, no preamble.`;
  return p;
}

// Deterministic acceptance gate over the provider output. Domain-aware but STRUCTURAL (needs no model), so
// a well-formed draft passes and an unmeetable brief fails -- the gate that makes delegation trustworthy.
export function acceptance(task, text) {
  const body = text || '';
  const checks = [];
  const min = Number.isFinite(task.minChars) ? task.minChars : 200;
  checks.push({ name: `min-chars>=${min}`, ok: body.length >= min });
  const sections = Array.isArray(task.requiredSections) ? task.requiredSections : [];
  for (const s of sections) {
    checks.push({ name: `section:${s}`, ok: new RegExp(`(^|\\n)#{1,6}\\s+.*${escapeRe(s)}`, 'i').test(body) });
  }
  const verdict = checks.every((c) => c.ok) ? 'pass' : 'fail';
  return { checks, verdict };
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Run one delegation. `drive` may be injected (the mock in the self-test); otherwise the named provider's
// adapter is selected. Returns a receipt object; captures the raw draft via the optional onText callback.
export async function runDelegation(task, { provider = 'ollama', model, drive, adapterOpts = {}, onText } = {}) {
  validateTask(task);
  const driveFn = drive || selectAdapter(provider, adapterOpts);
  const prompt = buildPrompt(task);
  const sections = Array.isArray(task.requiredSections) ? task.requiredSections : [];
  const t0 = performance.now();
  const res = await driveFn(prompt, { model: model || task.model, sections });
  const ms = Math.round(performance.now() - t0);
  if (typeof onText === 'function') onText(res.text || '');
  // Quality PRE-gate: score the draft's faithfulness before the (expensive) domain gate; a weak / off-topic /
  // refusal draft is rejected here and the domain gate is SHORT-CIRCUITED (no coverage measure / tool run).
  const pre = res.ok ? qualityPreGate(task, res.text) : null;
  const acc = !res.ok
    ? { checks: [{ name: 'provider-ok', ok: false }], verdict: 'fail' }
    : !pre.ok
      ? { checks: [{ name: 'quality-pregate', ok: false }, ...pre.checks], verdict: 'fail' }
      : task.domain === 'coverage-lift'
        ? await acceptanceCoverageLift(task, res.text)
        : task.domain === 'risky-test'
          ? await acceptanceRiskyTest(task, res.text)
          : task.domain === 'evidence'
            ? acceptanceEvidence(task, res.text)
            : acceptance(task, res.text);
  const verdict = !res.ok ? 'fail' : acc.verdict === 'pass' ? 'pass' : acc.verdict === 'skip' ? 'skip' : 'fail';
  const receipt = {
    schema: RECEIPT_SCHEMA,
    generatedAt: new Date().toISOString(),
    task: { domain: task.domain, id: task.id, provider: res.provider ?? provider, model: res.model ?? (model || task.model) ?? null },
    provider: { ok: res.ok, error: res.error ?? null, ms: res.ms ?? ms },
    output: { chars: (res.text || '').length },
    acceptance: acc,
    verdict,
  };
  if (pre) receipt.quality = { ok: pre.ok, score: pre.score, termsHit: pre.termsHit, termsTotal: pre.termsTotal, refusal: pre.refusal };
  if (acc.coverage) receipt.coverage = acc.coverage;
  if (acc.tool) receipt.tool = acc.tool;
  if (acc.evidence) receipt.evidence = acc.evidence;
  return receipt;
}

// Optional: announce the receipt over lbabus as an ADR-0003-framed DONE frame (4-byte BE length + one
// bus-msg@1 JSON envelope) to a host observer/listener -- so a cleanroom's delegation outcome is collectable
// over TCP with `lbabus net listen`. Best-effort: resolves {announced:false,error} instead of throwing.
export function announceOverBus(receipt, { host = '127.0.0.1', port = 7420, sessionId = 'uplift', senderId = 'uplift-actor', timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const env = {
      schema: BUS_SCHEMA, sessionId, senderId, seq: 0,
      ts: { wall: new Date().toISOString(), run: 0 },
      type: 'DONE', task: `uplift:${receipt.task.domain}`,
      payload: JSON.stringify(receipt), ackOf: null,
    };
    const json = Buffer.from(JSON.stringify(env), 'utf8');
    const len = Buffer.alloc(4); len.writeUInt32BE(json.length, 0);
    const sock = net.connect({ host, port }, () => sock.write(Buffer.concat([len, json]), () => sock.end()));
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error('bus announce timeout')));
    sock.on('close', () => resolve({ announced: true, host, port }));
    sock.on('error', (e) => resolve({ announced: false, error: e.message }));
  });
}

// ---- CLI ---------------------------------------------------------------------------------------------
async function main(argv) {
  const args = parseArgs(argv);
  if (!args.task) {
    console.error('usage: node delegateUplift.mjs --task <task.json> [--provider ollama|copilot-cli|codex|mock]');
    console.error('       [--model M] [--out draft.md] [--receipt receipt.json] [--announce host:port]');
    process.exit(2);
  }
  const task = JSON.parse(fs.readFileSync(args.task, 'utf8'));
  let captured = '';
  const receipt = await runDelegation(task, {
    provider: args.provider || 'ollama',
    model: args.model,
    onText: (t) => { captured = t; },
  });
  if (args.out) { fs.writeFileSync(args.out, captured); receipt.output.artifact = args.out; }
  if (args.announce) {
    const [h, p] = String(args.announce).split(':');
    receipt.announce = await announceOverBus(receipt, { host: h, port: Number(p) });
  }
  const receiptPath = args.receipt || `uplift-${task.domain}-${task.id}.receipt.json`;
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  console.log(`[delegate] domain=${task.domain} id=${task.id} provider=${receipt.task.provider} verdict=${receipt.verdict} chars=${receipt.output.chars} -> ${receiptPath}`);
  process.exit(receipt.verdict === 'pass' || receipt.verdict === 'skip' ? 0 : 1);
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const key = k.slice(2);
      const v = argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[++i] : true;
      a[key] = v;
    }
  }
  return a;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => { console.error(`[delegate] ${e.message}`); process.exit(1); });
}
