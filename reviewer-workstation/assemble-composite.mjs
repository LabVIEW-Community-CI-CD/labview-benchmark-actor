#!/usr/bin/env node
// assemble-composite.mjs -- one-shot composite-release-decision receipt assembler (issue #410, LBA-REQ-070 /
// ADR-0051). Fuses the four independently-produced release pieces into the committed
// `composite-release-decision-receipt.json` the publish gate (`verify-composite-release.mjs`) requires, and
// FAILS CLOSED WITH A PRECISE PER-FIELD DIFF the instant any piece names a different candidate -- instead of a
// late, opaque gate failure at publish time.
//
// The four pieces, ALL of which must bind the SAME candidate {component, version, commit, vsixSha256}:
//   candidate            -- the node-24 build identity;
//   machine.quorumVerdict-- the acg-quorum-verdict-v2 attestation built from the cross-plane corroboration
//                           witnesses (this is exactly the `.quorum` of a cross-plane-corroboration-attestation@1);
//   machine.signOffs[]   -- the Ed25519 quorum sign-off (enrolled key, ADR-0018);
//   visual               -- the signed reviewer-verdict@1 + its Ed25519 sign-off (LBA-REQ-057);
//   staged               -- the WIN-plane net DONE frame (LBA-REQ-068/069).
//
// The assembly + fail-closed BINDING is a PURE, offline function (`assembleComposite`) proven by the selftest.
// The only live leg is fetching the corroboration run artifacts + building the attestation (CLI, `--corrob-run`),
// which reuses the already-proven cross-plane-attestation builder; that leg is exercised separately.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { buildReceipt as buildComposite, validateReceipt as validateComposite } from './composite-release-decision.mjs';
import { buildReceipt as buildAttestation } from '../experiments/acg-quorum/cross-plane-attestation.mjs';

// The four candidate-identity fields every piece must agree on.
const CANDIDATE_FIELDS = ['component', 'version', 'commit', 'vsixSha256'];

// Compute the PRECISE per-field binding diff between the candidate and each piece that names it. Returns an array
// of `{ source, field, expected, got }` -- empty iff every piece names the SAME candidate. This is the value-add
// over the composite verifier's opaque reason strings: the operator sees exactly which field of which piece drifted.
export function computeBindingDiffs({ candidate, machine, visual, staged }) {
  const diffs = [];
  const c = candidate ?? {};

  // visual verdict target -- all four fields.
  const target = visual?.verdict?.target ?? {};
  for (const f of CANDIDATE_FIELDS) {
    if (String(c[f]) !== String(target[f])) {
      diffs.push({ source: 'visual.verdict.target', field: f, expected: c[f] ?? null, got: target[f] ?? null });
    }
  }

  // machine quorum consensus -- version + sourceCommit (the two identity fields a quorum consensus carries).
  const consensus = machine?.quorumVerdict?.consensus ?? {};
  if (String(c.version) !== String(consensus.version)) {
    diffs.push({ source: 'machine.quorumVerdict.consensus', field: 'version', expected: c.version ?? null, got: consensus.version ?? null });
  }
  if (String(c.commit) !== String(consensus.sourceCommit)) {
    diffs.push({ source: 'machine.quorumVerdict.consensus', field: 'sourceCommit', expected: c.commit ?? null, got: consensus.sourceCommit ?? null });
  }

  // staged candidate -- component + version (what the WIN VM reported it staged over net).
  const stagedCandidate = staged?.candidate ?? {};
  for (const f of ['component', 'version']) {
    if (String(c[f]) !== String(stagedCandidate[f])) {
      diffs.push({ source: 'staged.candidate', field: f, expected: c[f] ?? null, got: stagedCandidate[f] ?? null });
    }
  }

  return diffs;
}

// Assemble a composite-release-decision receipt from the four pieces, failing closed with a precise diff when any
// piece names a different candidate. Pure + offline. Returns:
//   { ok, proofOk, receipt, diffs, findings, summary }
// `ok` is true only when the candidate binding holds AND the composite verifier validates the built receipt.
export function assembleComposite({ candidate, machine, visual, staged, reviewerAllowlist, minReviewers = 1, minVisualReviewers = 1 }) {
  const diffs = computeBindingDiffs({ candidate, machine, visual, staged });
  if (diffs.length > 0) {
    const findings = diffs.map((d) => `candidate binding mismatch: ${d.source}.${d.field} is ${JSON.stringify(d.got)} but the candidate is ${JSON.stringify(d.expected)}`);
    return { ok: false, proofOk: false, receipt: null, diffs, findings, summary: null };
  }
  const receipt = buildComposite({ candidate, staged, machine, visual, reviewerAllowlist, minReviewers, minVisualReviewers });
  const v = validateComposite(receipt);
  const c = candidate ?? {};
  const summary = `${c.component} ${c.version} @ ${String(c.commit).slice(0, 9)} (vsix ${String(c.vsixSha256).slice(0, 12)}): machine=${receipt.binding.machinePublish} visual=${receipt.binding.visualPublish} bound=${receipt.binding.machineConsensusBound && receipt.binding.visualTargetBound && receipt.binding.stagedOverNet} -> compositeReleaseProven=${receipt.verdict.compositeReleaseProven}`;
  return { ok: v.ok, proofOk: v.proofOk, receipt, diffs: [], findings: v.findings, summary };
}

// ---- CLI ------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; } else { args[key] = next; i += 1; }
    }
  }
  return args;
}

// Build the acg-quorum-verdict-v2 attestation from the corroboration witnesses. Sources, in order of precedence:
//   --attestation <file>   -- a pre-built cross-plane-corroboration-attestation@1 (use its `.quorum` directly);
//   --witnesses-dir <dir>  -- a directory of witness JSONs (build the attestation locally);
//   --corrob-run <run-id>  -- `gh run download` the corroboration run's artifacts, then build from the witnesses.
// Returns the acg-quorum-verdict-v2 object (the attestation `.quorum`).
function resolveQuorumVerdict(args) {
  if (args.attestation) {
    const att = JSON.parse(readFileSync(args.attestation, 'utf8'));
    if (!att.quorum) throw new Error(`--attestation ${args.attestation} has no .quorum (not a cross-plane attestation)`);
    return att.quorum;
  }
  let witnessDir = args['witnesses-dir'];
  if (!witnessDir && args['corrob-run']) {
    witnessDir = mkdtempSync(join(tmpdir(), 'lba-corrob-'));
    execFileSync('gh', ['run', 'download', String(args['corrob-run']), '--dir', witnessDir], { stdio: 'inherit' });
  }
  if (!witnessDir) throw new Error('provide one of --attestation <file>, --witnesses-dir <dir>, or --corrob-run <run-id>');
  const witnesses = readdirSync(witnessDir, { recursive: true })
    .filter((f) => String(f).endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(witnessDir, f), 'utf8')))
    .filter((w) => w && (w.version !== undefined || w.sourceCommit !== undefined || w.os !== undefined));
  const provenance = { workflow: 'acg-cross-plane-corroboration', runId: args['corrob-run'] ?? null, commit: args.commit ?? null, capturedAt: new Date().toISOString() };
  const attestation = buildAttestation({ provenance, witnesses });
  return attestation.quorum;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const req of ['component', 'version', 'commit', 'vsix256', 'quorum-signoff', 'visual-verdict', 'staged-frame', 'out']) {
    if (!args[req]) { console.error(`usage: node reviewer-workstation/assemble-composite.mjs --component <c> --version <X.Y.Z> --commit <sha> --vsix256 <sha256> (--attestation <f> | --witnesses-dir <d> | --corrob-run <id>) --quorum-signoff <f> --visual-verdict <f> --staged-frame <f> [--reviewer-allowlist <f>] --out <f>\nmissing --${req}`); process.exit(2); }
  }
  const candidate = { component: String(args.component), version: String(args.version), commit: String(args.commit), vsixSha256: String(args.vsix256) };
  const quorumVerdict = resolveQuorumVerdict(args);
  const quorumSignOff = JSON.parse(readFileSync(args['quorum-signoff'], 'utf8'));
  const visualBundle = JSON.parse(readFileSync(args['visual-verdict'], 'utf8'));
  const visual = (visualBundle.verdict && visualBundle.signOff) ? visualBundle : { verdict: visualBundle, signOff: visualBundle.signOff };
  const staged = JSON.parse(readFileSync(args['staged-frame'], 'utf8'));
  const here = dirname(fileURLToPath(import.meta.url));
  const allowlistPath = args['reviewer-allowlist'] ?? join(here, '..', 'docs', 'release', 'reviewer-allowlist.json');
  let reviewerAllowlist = {};
  try { reviewerAllowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')); } catch { /* an empty allowlist fails the gate closed, as intended */ }

  const result = assembleComposite({ candidate, machine: { quorumVerdict, signOffs: [quorumSignOff] }, visual, staged, reviewerAllowlist });
  if (!result.ok) {
    console.error('[assemble-composite] FAIL -- the composite receipt does not bind one candidate:');
    for (const f of result.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  writeFileSync(args.out, JSON.stringify(result.receipt, null, 2) + '\n');
  console.log(`[assemble-composite] OK ${result.summary}`);
  console.log(`[assemble-composite] wrote ${args.out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
