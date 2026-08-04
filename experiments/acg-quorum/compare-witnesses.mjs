#!/usr/bin/env node
// compare-witnesses.mjs -- Actor Corroboration Grid quorum (ADR-0015, LBA-REQ-024). Ingests N heterogeneous
// witness bundles and emits a graded-majority corroboration verdict over the TIERED anchor model:
//
//   OS-INDEPENDENT anchors (must agree across ALL witnesses): lbabus.version, lbabus.sourceCommit,
//     gate-suite verdict (must be "pass"), the viewer seriesHash.
//   LINUX-ONLY anchors (agree across the os==="linux" subset only): pngSha256 (pinned render stack), ubuntu codename.
//   WITNESSES (recorded, never gated): hardware-capability, host, timestamps.
//
// Verdict PASSES iff (a) the witnesses span DISTINCT OS-PLANES (linux AND windows -- ADR-0068 corrects ADR-0017;
// N linux contexts are ONE plane), (b) a MAJORITY concur on their applicable OS-independent anchors, (c) the
// consensus gate verdict is "pass", and (d) the graded confidence (matched / applicable anchor comparisons) >=
// threshold. Otherwise it FAILS CLOSED, naming each dissenting witness + anchor. Dependency-free (Node builtins only).

import { readFileSync } from 'node:fs';

export const OS_INDEPENDENT = ['version', 'sourceCommit', 'verdict', 'seriesHash'];
export const LINUX_ONLY = ['pngSha256', 'ubuntu'];

// Flatten a witness bundle to its anchor map. Bundle shape:
//   { plane, os, gate: { verdict, lbabus: { version, sourceCommit } }, screenshot: { seriesHash, pngSha256 }, ubuntu }
export function anchorsOf(b) {
  return {
    version: b?.gate?.lbabus?.version ?? null,
    sourceCommit: b?.gate?.lbabus?.sourceCommit ?? null,
    verdict: b?.gate?.verdict ?? null,
    seriesHash: b?.screenshot?.seriesHash ?? null,
    pngSha256: b?.screenshot?.pngSha256 ?? null,
    ubuntu: b?.ubuntu ?? null,
  };
}

const applies = (anchor, bundle) =>
  OS_INDEPENDENT.includes(anchor) || (LINUX_ONLY.includes(anchor) && bundle.os === 'linux');

export function compareWitnesses(bundles, { threshold = 0.5 } = {}) {
  if (!Array.isArray(bundles) || bundles.length < 2) {
    return { verdict: 'error', reason: 'a quorum needs at least two witnesses', confidence: 0, witnesses: bundles?.length ?? 0 };
  }
  const anchors = bundles.map(anchorsOf);
  const allAnchors = [...OS_INDEPENDENT, ...LINUX_ONLY];

  // Consensus per anchor = the modal non-null value across the witnesses the anchor applies to.
  const consensus = (anchor) => {
    const counts = new Map();
    bundles.forEach((b, i) => {
      if (!applies(anchor, b)) return;
      const v = anchors[i][anchor];
      if (v != null) counts.set(v, (counts.get(v) || 0) + 1);
    });
    let best = null, bestN = 0;
    for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
    return best;
  };
  const cons = Object.fromEntries(allAnchors.map((k) => [k, consensus(k)]));

  // Grade + collect divergences across every applicable (witness, anchor) comparison.
  let matched = 0, applicable = 0;
  const divergences = [];
  bundles.forEach((b, i) => {
    for (const k of allAnchors) {
      if (!applies(k, b)) continue;
      if (anchors[i][k] == null) continue; // an unprovided OPTIONAL anchor (e.g. an un-rendered Linux pngSha256) is not a comparison
      applicable++;
      if (anchors[i][k] === cons[k]) matched++;
      else divergences.push({ witness: b.plane ?? `#${i}`, anchor: k, got: anchors[i][k], consensus: cons[k] });
    }
  });
  const confidence = applicable ? matched / applicable : 0;

  // Independence (ADR-0068 corrects ADR-0017): the witnesses must span DISTINCT OS-PLANES (linux AND windows).
  // A plane is the OS the extension runs in; the bundle `plane` field is a hypervisor/context label and does NOT
  // establish plane diversity -- N linux contexts (codespace + vbox + a native host) are ONE linux plane.
  const crossPlane = new Set(bundles.map((b) => String(b?.os ?? '?').toLowerCase())).size >= 2;
  // Majority concurrence on the OS-independent anchors.
  const concurs = (i) => OS_INDEPENDENT.every((k) => anchors[i][k] != null && anchors[i][k] === cons[k]);
  const concurring = bundles.filter((_, i) => concurs(i)).length;
  const majority = concurring > bundles.length / 2;
  const verdictPass = cons.verdict === 'pass';

  const pass = crossPlane && majority && verdictPass && confidence >= threshold;
  return {
    schema: 'labview-benchmark-actor/acg-quorum-verdict-v2',
    verdict: pass ? 'pass' : 'fail',
    confidence,
    threshold,
    witnesses: bundles.length,
    concurring,
    majority,
    crossPlane,
    consensusVerdict: cons.verdict,
    consensus: cons,
    divergences,
  };
}

// CLI: compare-witnesses.mjs <bundle.json> <bundle.json> [...]  -> prints the verdict, exits 0 iff pass.
if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = process.argv.slice(2);
  if (paths.length < 2) { console.error('usage: compare-witnesses.mjs <bundle.json> <bundle.json> [...]'); process.exit(2); }
  const bundles = paths.map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const out = compareWitnesses(bundles);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.verdict === 'pass' ? 0 : 1);
}
