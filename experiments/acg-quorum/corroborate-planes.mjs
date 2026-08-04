#!/usr/bin/env node
// corroborate-planes.mjs -- assert that N plane witnesses CROSS-PLANE corroborate: the corrected quorum
// (compare-witnesses.mjs, ADR-0068) must PASS and span distinct OS-planes (crossPlane). Used by the
// acg-cross-plane-corroboration workflow to gate a genuine two-plane (linux + windows) corroboration.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compareWitnesses } from './compare-witnesses.mjs';

/** True iff the witnesses concur AND span distinct OS-planes (genuine cross-plane corroboration). */
export function corroboratePlanes(bundles, opts = {}) {
  const verdict = compareWitnesses(bundles, opts);
  return { ok: verdict.verdict === 'pass' && verdict.crossPlane === true, verdict };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (paths.length < 2) {
    console.error('usage: corroborate-planes.mjs <witness.bundle.json> <witness.bundle.json> [...]');
    process.exit(2);
  }
  const bundles = paths.map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const { ok, verdict } = corroboratePlanes(bundles);
  console.log(JSON.stringify(verdict, null, 2));
  if (!ok) {
    console.error(`::error::cross-plane corroboration FAILED (verdict=${verdict.verdict}, crossPlane=${verdict.crossPlane}); divergences=${JSON.stringify(verdict.divergences)}`);
    process.exit(1);
  }
  const planes = [...new Set(bundles.map((b) => b.os))].sort().join(' + ');
  console.log(`cross-plane corroborated: ${planes} agree (confidence ${verdict.confidence}) on version/sourceCommit/verdict/seriesHash`);
}
