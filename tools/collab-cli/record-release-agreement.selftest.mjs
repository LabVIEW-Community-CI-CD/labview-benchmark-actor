#!/usr/bin/env node
// record-release-agreement.selftest.mjs -- gated selftest for the release-agreement recorder (#419).
//
// Proves, over a throwaway fixture agreement file (never the committed one):
//   1. one call records a release entry that passes BOTH release gates (agreement + signed visual verdict);
//   2. the edit is MINIMAL -- every pre-existing line survives verbatim except the previous last entry's `}`
//      (which gains a trailing comma), and unrelated entries are byte-identical (no whole-file reformat);
//   3. it REFUSES to clobber an existing version;
//   4. it seeds an EMPTY releases map correctly.
// Run: `node tools/collab-cli/record-release-agreement.selftest.mjs`.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordReleaseAgreement, insertReleaseEntry, buildReleaseEntry } from './record-release-agreement.mjs';
import { generateEnrolledKeypair, buildReviewerVerdict, signReviewerVerdict } from '../../experiments/handoff-beacon/reviewerVerdict.mjs';

const cases = [];
const ok = (name, fn) => cases.push({ name, fn });

const dir = mkdtempSync(join(tmpdir(), 'lba-record-agreement-'));
const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };

// A signed, enrolled reviewer verdict record for the fixture version (self-contained -- no real keys).
function makeSignedVerdict({ version, commit }) {
  const { publicKeyPem, privateKeyPem } = generateEnrolledKeypair();
  const reviewer = 'selftest-reviewer@example.com';
  const verdict = buildReviewerVerdict({
    target: { component: 'extension', version, commit, vsixSha256: 'a'.repeat(64) },
    verdict: 'pass', reviewer, station: 'WINDOWS_VM', notes: '',
    evidence: [{ kind: 'win-plane-validation', ref: `${version}@${commit.slice(0, 8)} winPlaneReady=true` }],
    renderedAt: new Date().toISOString(),
  });
  const signOff = signReviewerVerdict(verdict, { privateKeyPem, reviewer, station: 'WINDOWS_VM' });
  return { record: { verdict, signOff }, allowlist: { [reviewer]: publicKeyPem } };
}

function fixtureDoc(releases = {}) {
  return {
    schema: 'release-agreement@v2',
    policy: 'selftest fixture',
    requiredPlanes: ['WIN', 'LINUX'],
    components: { extension: { releases } },
  };
}

// A committed prior release entry so the "append after last entry (minimal edit)" path is exercised.
const priorEntry = buildReleaseEntry({
  summary: 'prior 1.0.0 { with a brace in the note } to fool naive scanners',
  commit: 'b'.repeat(40), at: '2026-01-01T00:00:00.000Z',
  linuxNote: 'prior LINUX note', winNote: 'prior WIN note',
  visualReview: { verdict: { schema: 'x', verdict: 'pass', target: { version: '1.0.0' } } },
});

ok('records a release entry that passes both release gates (agreement + signed visual verdict)', () => {
  const { record, allowlist } = makeSignedVerdict({ version: '9.9.9', commit: 'c'.repeat(40) });
  const file = join(dir, 'agreement-a.json');
  const allowFile = join(dir, 'allowlist-a.json');
  const verdictFile = join(dir, 'visual-9.9.9.json');
  writeFileSync(file, `${JSON.stringify(fixtureDoc({ '1.0.0': priorEntry }), null, 2)}\n`);
  writeFileSync(allowFile, `${JSON.stringify(allowlist, null, 2)}\n`);
  writeFileSync(verdictFile, `${JSON.stringify(record, null, 2)}\n`);

  const report = recordReleaseAgreement({
    file, allowlist: allowFile, component: 'extension', version: '9.9.9', commit: 'c'.repeat(40),
    linuxNote: 'LINUX validated at 9.9.9', winNote: 'WIN validated at 9.9.9', visualVerdictPath: verdictFile,
    summary: 'selftest 9.9.9', at: '2026-08-05T00:00:00.000Z',
  });
  assert.equal(report.ok, true, `both gates must pass: ${JSON.stringify(report)}`);

  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(doc.components.extension.releases['9.9.9'].signoffs.WIN.agreed, true);
  assert.equal(doc.components.extension.releases['9.9.9'].signoffs.LINUX.agreed, true);
  assert.deepEqual(doc.components.extension.releases['9.9.9'].visualReview, record, 'visualReview embedded verbatim');
});

ok('the edit is minimal: every pre-existing line survives except the previous last entry gains a comma', () => {
  const { record, allowlist } = makeSignedVerdict({ version: '2.0.0', commit: 'd'.repeat(40) });
  const file = join(dir, 'agreement-b.json');
  const verdictFile = join(dir, 'visual-2.0.0.json');
  const before = `${JSON.stringify(fixtureDoc({ '1.0.0': priorEntry }), null, 2)}\n`;
  writeFileSync(file, before);
  writeFileSync(join(dir, 'allowlist-b.json'), `${JSON.stringify(allowlist, null, 2)}\n`);
  writeFileSync(verdictFile, `${JSON.stringify(record, null, 2)}\n`);

  recordReleaseAgreement({
    file, allowlist: join(dir, 'allowlist-b.json'), component: 'extension', version: '2.0.0', commit: 'd'.repeat(40),
    linuxNote: 'L', winNote: 'W', visualVerdictPath: verdictFile, at: '2026-08-05T00:00:00.000Z',
  });
  const after = readFileSync(file, 'utf8');

  const bLines = before.split('\n');
  const aLines = after.split('\n');
  // POSITIONAL minimal-edit proof: identical prefix, exactly one line changed (the previous last entry's `}`
  // gains a trailing comma), then the new block is inserted, and the tail is byte-identical -- i.e. no
  // reformatting of any unrelated entry.
  let i = 0;
  while (i < bLines.length && bLines[i] === aLines[i]) i += 1;
  assert.ok(i < bLines.length, 'files must differ (an entry was added)');
  assert.equal(`${bLines[i]},`, aLines[i], 'the first changed line only gains a trailing comma');
  assert.match(bLines[i], /^\s*}$/, 'that changed line is a closing brace (the previous last entry)');
  const tail = bLines.slice(i + 1);
  assert.deepEqual(aLines.slice(aLines.length - tail.length), tail, 'the tail after the insertion is byte-identical (no reformat)');
  assert.ok(after.includes('to fool naive scanners'), 'prior entry stays byte-identical');
});

ok('refuses to clobber an existing version entry', () => {
  const { record, allowlist } = makeSignedVerdict({ version: '1.0.0', commit: 'e'.repeat(40) });
  const file = join(dir, 'agreement-c.json');
  const verdictFile = join(dir, 'visual-clobber.json');
  writeFileSync(file, `${JSON.stringify(fixtureDoc({ '1.0.0': priorEntry }), null, 2)}\n`);
  writeFileSync(join(dir, 'allowlist-c.json'), `${JSON.stringify(allowlist, null, 2)}\n`);
  writeFileSync(verdictFile, `${JSON.stringify(record, null, 2)}\n`);
  assert.throws(() => recordReleaseAgreement({
    file, allowlist: join(dir, 'allowlist-c.json'), component: 'extension', version: '1.0.0', commit: 'e'.repeat(40),
    linuxNote: 'L', winNote: 'W', visualVerdictPath: verdictFile,
  }), /refusing to clobber/, 'must refuse to overwrite an existing version');
});

ok('seeds an EMPTY releases map correctly (valid JSON, entry present)', () => {
  const text = `${JSON.stringify(fixtureDoc({}), null, 2)}\n`;
  const entry = buildReleaseEntry({ summary: 's', commit: 'f'.repeat(40), at: 'now', linuxNote: 'L', winNote: 'W', visualReview: { verdict: { verdict: 'pass' } } });
  const out = insertReleaseEntry({ text, component: 'extension', version: '0.0.1', entry });
  const doc = JSON.parse(out);
  assert.deepEqual(doc.components.extension.releases['0.0.1'], entry, 'entry seeded into an empty releases map');
});

let n = 0;
try {
  for (const c of cases) { c.fn(); n += 1; console.log(`ok ${n} - ${c.name}`); }
  console.log(`# record-release-agreement selftest ${n}/${cases.length} passed`);
} finally {
  cleanup();
}
if (n !== cases.length) process.exit(1);
