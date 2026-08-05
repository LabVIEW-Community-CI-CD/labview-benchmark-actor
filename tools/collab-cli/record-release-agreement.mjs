#!/usr/bin/env node
// record-release-agreement.mjs -- turnkey recorder for a component release entry in release-agreement.json (#419).
//
// WHY: recording a new release used to mean hand-editing release-agreement.json (in 1.1.1, a throwaway /tmp
// script that JSON.parse -> mutate -> JSON.stringify the whole file). That is error-prone: easy to mis-nest or
// duplicate a version key, a full re-serialize risks reformatting unrelated entries, and the signed visualReview
// must be dropped in verbatim. This helper inserts the `components.<comp>.releases.<version>` entry with BOTH
// planes agreed:true + the embedded signed visualReview, as a MINIMAL structured text edit (no whole-file
// reformat -- unchanged entries stay byte-identical), refuses to clobber an existing version, then immediately
// runs verify-release-agreement + verify-visual-review for that version and fails closed on any problem.
//
// Usage:
//   node tools/collab-cli/record-release-agreement.mjs \
//     --component extension --version X.Y.Z --commit <sha> \
//     --linux-note "..." --win-note "..." \
//     --visual-verdict ~/lba-vm-share/visual-verdict-X.Y.Z.json \
//     [--summary "..."] [--at <iso8601>] [--min 1] [--dry-run] \
//     [--file <release-agreement.json>] [--allowlist <reviewer-allowlist.json>]
//
// The --visual-verdict file is the collected reviewer verdict record: { verdict, signOff | signOffs } (the exact
// object embedded as releases.<version>.visualReview). Exit: 0 = recorded + both gates pass; 1 = fail-closed; 2 = usage.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { verifyReleaseAgreement } from './verify-release-agreement.mjs';
import { verifyVisualReview } from './verify-visual-review.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Parse a string-aware brace-matched object body: return the [openIdx, closeIdx] of the object that starts at
 *  the first `{` at or after `fromIdx`. Strings (and their escapes) are skipped so braces inside notes/PEMs
 *  never perturb the depth count. */
function matchObject(text, fromIdx) {
  const openIdx = text.indexOf('{', fromIdx);
  if (openIdx < 0) throw new Error('record-release-agreement: could not find the releases object');
  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastDepth1Close = -1; // index of the last `}` that closed a direct child (depth 2 -> 1)
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 1) lastDepth1Close = i;
      if (depth === 0) return { openIdx, closeIdx: i, lastDepth1Close };
    }
  }
  throw new Error('record-release-agreement: unbalanced braces in the releases object');
}

/** Build the release entry object (stable key order): summary, both-plane signoffs, embedded visualReview. */
export function buildReleaseEntry({ summary, commit, at, linuxNote, winNote, visualReview, requiredPlanes = ['WIN', 'LINUX'] }) {
  const noteByPlane = { LINUX: linuxNote, WIN: winNote };
  const signoffs = {};
  for (const plane of requiredPlanes) {
    signoffs[plane] = { agreed: true, reviewedCommit: commit, at, note: noteByPlane[plane] ?? '' };
  }
  return { summary, signoffs, visualReview };
}

/**
 * Insert a new `releases.<version>` entry into the release-agreement text with a MINIMAL structured edit:
 * the new entry is appended (stable key order) after the last existing release, unchanged entries stay
 * byte-identical (no whole-file re-serialize). Refuses to clobber an existing version. Returns the new text.
 */
export function insertReleaseEntry({ text, component, version, entry }) {
  const doc = JSON.parse(text);
  const releasesMap = doc?.components?.[component]?.releases;
  if (!releasesMap || typeof releasesMap !== 'object') {
    throw new Error(`record-release-agreement: no components.${component}.releases map in the agreement file`);
  }
  if (Object.prototype.hasOwnProperty.call(releasesMap, version)) {
    throw new Error(`record-release-agreement: refusing to clobber existing ${component} release ${version}`);
  }

  // Locate the component's releases object (string-aware) so braces inside notes/PEMs cannot fool the scan.
  const compKey = `"${component}"`;
  const compIdx = text.indexOf(compKey, text.indexOf('"components"'));
  if (compIdx < 0) throw new Error(`record-release-agreement: could not locate component "${component}"`);
  const releasesKeyIdx = text.indexOf('"releases"', compIdx);
  if (releasesKeyIdx < 0) throw new Error('record-release-agreement: could not locate the releases key');
  const { closeIdx, lastDepth1Close } = matchObject(text, releasesKeyIdx);

  // Serialize the new { version: entry } and re-indent to sit at the release-key depth (8 spaces).
  const block = JSON.stringify({ [version]: entry }, null, 2)
    .replace(/^\{\n/, '')
    .replace(/\n\}\s*$/, '')
    .split('\n')
    .map((l) => (l.length ? `      ${l}` : l))
    .join('\n');

  let out;
  if (lastDepth1Close >= 0) {
    // Append after the last existing release: add a comma to its closing brace, then the new block.
    const insertAt = lastDepth1Close + 1;
    out = `${text.slice(0, insertAt)},\n${block}${text.slice(insertAt)}`;
  } else {
    // Empty releases map `{}` (or `{ }`): drop the block between the braces.
    const before = text.slice(0, closeIdx);
    out = `${before}\n${block}\n      ${text.slice(closeIdx)}`;
  }

  // Structural guard: the result must be valid JSON that deep-equals the doc plus exactly the new entry.
  const reparsed = JSON.parse(out);
  const expected = JSON.parse(text);
  expected.components[component].releases[version] = entry;
  if (JSON.stringify(reparsed) !== JSON.stringify(expected)) {
    throw new Error('record-release-agreement: the structured edit did not produce the expected document');
  }
  return out;
}

/**
 * Record a release entry end-to-end: read the agreement file, insert the entry (minimal edit), write it (unless
 * dryRun), then run BOTH release gates for that version and fail closed on any problem. Returns a report.
 */
export function recordReleaseAgreement({
  file, allowlist, component = 'extension', version, commit, linuxNote, winNote, visualVerdictPath, summary, at, minReviewers = 1, dryRun = false, verify = true,
}) {
  if (!/^\d+\.\d+\.\d+/.test(version || '')) throw new Error('record-release-agreement: --version X.Y.Z is required');
  if (!commit) throw new Error('record-release-agreement: --commit <sha> is required');
  if (!visualVerdictPath) throw new Error('record-release-agreement: --visual-verdict <record.json> is required');

  const agreementFile = file ? resolve(file) : join(HERE, 'release-agreement.json');
  const text = readFileSync(agreementFile, 'utf8');
  const doc = JSON.parse(text);
  const requiredPlanes = Array.isArray(doc.requiredPlanes) && doc.requiredPlanes.length ? doc.requiredPlanes : ['WIN', 'LINUX'];

  const visualReview = JSON.parse(readFileSync(resolve(visualVerdictPath), 'utf8'));
  if (!visualReview || typeof visualReview !== 'object' || !visualReview.verdict) {
    throw new Error(`record-release-agreement: ${visualVerdictPath} is not a { verdict, signOff|signOffs } record`);
  }

  const entry = buildReleaseEntry({
    summary: summary || `${component} ${version} release agreement`,
    commit,
    at: at || new Date().toISOString(),
    linuxNote: linuxNote || '',
    winNote: winNote || '',
    visualReview,
    requiredPlanes,
  });

  const out = insertReleaseEntry({ text, component, version, entry });
  if (!dryRun) writeFileSync(agreementFile, out);

  const report = { file: agreementFile, component, version, written: !dryRun, agreement: null, visual: null };
  if (verify && !dryRun) {
    // Verify against the JUST-WRITTEN document via the real gate logic (exported functions), so this works over
    // the committed file OR a fixture -- and fails closed exactly as the CI publish gates would.
    const writtenDoc = JSON.parse(readFileSync(agreementFile, 'utf8'));
    const agreement = verifyReleaseAgreement({ doc: writtenDoc, component, version, requiredPlanes });
    report.agreement = { ok: agreement.ok, output: agreement.ok ? '' : `missing/withheld agreement from: ${agreement.missing.join(', ')}` };

    const reviewerAllowlist = JSON.parse(readFileSync(allowlist ? resolve(allowlist) : join(HERE, 'reviewer-allowlist.json'), 'utf8'));
    const record = writtenDoc.components[component].releases[version].visualReview;
    const visual = verifyVisualReview({ record, reviewerAllowlist, minReviewers });
    report.visual = { ok: visual.publish, output: visual.publish ? '' : visual.reasons.join('; ') };

    report.ok = report.agreement.ok && report.visual.ok;
  } else {
    report.ok = true;
    report.text = out;
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opt[key] = true;
      else { opt[key] = next; i += 1; }
    }
  }
  if (opt.help) {
    console.log('usage: record-release-agreement.mjs --component extension --version X.Y.Z --commit <sha> --linux-note "..." --win-note "..." --visual-verdict <record.json> [--summary "..."] [--at <iso>] [--min 1] [--dry-run]');
    process.exit(0);
  }
  try {
    const report = recordReleaseAgreement({
      file: typeof opt.file === 'string' ? opt.file : undefined,
      allowlist: typeof opt.allowlist === 'string' ? opt.allowlist : undefined,
      component: typeof opt.component === 'string' ? opt.component : 'extension',
      version: typeof opt.version === 'string' ? opt.version : '',
      commit: typeof opt.commit === 'string' ? opt.commit : '',
      linuxNote: typeof opt['linux-note'] === 'string' ? opt['linux-note'] : '',
      winNote: typeof opt['win-note'] === 'string' ? opt['win-note'] : '',
      visualVerdictPath: typeof opt['visual-verdict'] === 'string' ? opt['visual-verdict'] : '',
      summary: typeof opt.summary === 'string' ? opt.summary : '',
      at: typeof opt.at === 'string' ? opt.at : '',
      minReviewers: opt.min ? Number(opt.min) : 1,
      dryRun: !!opt['dry-run'],
    });
    if (report.written === false) {
      console.log(`DRY-RUN: would record ${report.component} ${report.version} into ${report.file} (no gates run).`);
      process.exit(0);
    }
    const tag = report.component === 'extension' ? `ext-v${report.version}` : `${report.component}-v${report.version}`;
    if (report.ok) {
      console.log(`OK: recorded ${tag} in ${report.file}; both release gates pass (agreement + signed visual verdict).`);
      process.exit(0);
    }
    console.error(`FAIL (fail-closed): recorded ${tag} but a release gate did NOT pass:`);
    if (report.agreement && !report.agreement.ok) console.error(`  - verify-release-agreement:\n${report.agreement.output}`);
    if (report.visual && !report.visual.ok) console.error(`  - verify-visual-review:\n${report.visual.output}`);
    process.exit(1);
  } catch (e) {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  }
}
