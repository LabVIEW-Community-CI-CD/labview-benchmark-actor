// test/verify-published-vsix.mjs -- proves scripts/verify-published-vsix.mjs enforces reviewed == shipped:
// the packaged .vsix sha256 must equal the reviewed vsixSha256 in release-agreement.json, else it fails closed.
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPublishedVsix, reviewedVsixSha256, sha256File } from '../scripts/verify-published-vsix.mjs';

const dir = mkdtempSync(join(tmpdir(), 'repro-assert-'));
const vsixPath = join(dir, 'labview-benchmark-actor.vsix');
writeFileSync(vsixPath, Buffer.from('a byte-reproducible .vsix payload'));
const builtSha = sha256File(vsixPath).toLowerCase();

let n = 0;
function writeAgreement(releaseEntry) {
  const path = join(dir, `agreement-${(n += 1)}.json`);
  writeFileSync(path, JSON.stringify({ components: { extension: { releases: { '1.2.3': releaseEntry } } } }, null, 2));
  return path;
}

// 1. Match: the reviewed sha equals the built sha -> reviewed == shipped.
const okPath = writeAgreement({ visualReview: { verdict: { target: { vsixSha256: builtSha } } } });
const receipt = verifyPublishedVsix({ agreementPath: okPath, component: 'extension', version: '1.2.3', vsixPath });
assert.strictEqual(receipt.reviewedMatchesShipped, true, 'matching shas -> reviewed==shipped');
assert.strictEqual(receipt.vsixSha256, builtSha);
assert.strictEqual(reviewedVsixSha256(JSON.parse(readFileSync(okPath, 'utf8')), 'extension', '1.2.3'), builtSha, 'reviewedVsixSha256 reads the target hash');

// 2. Mismatch: a DIFFERENT reviewed sha (a review taken on another plane) -> FAIL CLOSED.
const mismatchPath = writeAgreement({ visualReview: { verdict: { target: { vsixSha256: 'b'.repeat(64) } } } });
assert.throws(
  () => verifyPublishedVsix({ agreementPath: mismatchPath, component: 'extension', version: '1.2.3', vsixPath }),
  /reviewed != shipped/,
  'differing shas fail closed (the built artifact was never reviewed)',
);

// 3. No visual review recorded -> FAIL CLOSED (a release must be reviewed).
const noReviewPath = writeAgreement({ signoffs: { LINUX: { agreed: true } } });
assert.throws(
  () => verifyPublishedVsix({ agreementPath: noReviewPath, component: 'extension', version: '1.2.3', vsixPath }),
  /not visually reviewed/,
  'a release with no visualReview fails closed',
);

// 4. No release entry for the version -> FAIL CLOSED.
assert.throws(
  () => verifyPublishedVsix({ agreementPath: okPath, component: 'extension', version: '9.9.9', vsixPath }),
  /no release entry/,
  'a missing release entry fails closed',
);

console.log('verify-published-vsix: PASS -- reviewed==shipped enforced (match ok; mismatch/no-review/no-entry all fail closed)');
