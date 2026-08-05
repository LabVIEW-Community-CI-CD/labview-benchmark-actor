#!/usr/bin/env node
// verify-published-vsix.mjs -- assert the CI-built .vsix IS the reviewed .vsix (reviewed == shipped).
//
// WHY (ADR-0066 follow-on / LBA-REQ-085): the .vsix is byte-reproducible on the publish (Linux) plane, so the
// artifact a human reviewed on that plane must equal the artifact CI ships. This computes the sha256 of the
// freshly packaged .vsix and asserts it equals the reviewed vsixSha256 recorded in release-agreement.json
// (components.<component>.releases.<version>.visualReview.verdict.target.vsixSha256 -- the enrolled human's
// signed visual verdict target, LBA-REQ-068/069). It FAILS CLOSED when they differ, so a release cannot publish
// an artifact that was never the one reviewed (e.g. a review taken on a DIFFERENT plane than the publish plane).
//
// A "plane" is the OS the extension runs in (windows | linux); CI publishes on linux, so the reviewed artifact
// must be the linux build. Pure Node (no deps): sha256 via node:crypto, JSON via node:fs.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** The reviewed vsixSha256 for a component+version = the signed visual-verdict target hash. Throws if absent. */
export function reviewedVsixSha256(agreement, component, version) {
  const rel = agreement?.components?.[component]?.releases?.[version];
  if (!rel) throw new Error(`verify-published-vsix: no release entry for component=${component} version=${version} in release-agreement`);
  const sha = rel?.visualReview?.verdict?.target?.vsixSha256;
  if (!sha || !/^[0-9a-f]{64}$/i.test(String(sha))) {
    throw new Error(`verify-published-vsix: no reviewed vsixSha256 for ${component} ${version} (release-agreement visualReview.verdict.target.vsixSha256) -- the release is not visually reviewed`);
  }
  return String(sha).toLowerCase();
}

/** sha256 (hex) of a file's bytes. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Assert the built .vsix sha256 equals the reviewed one. Returns the receipt; throws (fail-closed) on mismatch. */
export function verifyPublishedVsix({ agreementPath, component = 'extension', version, vsixPath }) {
  const agreement = JSON.parse(readFileSync(agreementPath, 'utf8'));
  const reviewed = reviewedVsixSha256(agreement, component, version);
  const built = sha256File(vsixPath).toLowerCase();
  if (built !== reviewed) {
    throw new Error(
      `verify-published-vsix: the packaged .vsix is NOT the reviewed artifact (reviewed != shipped)\n` +
      `  component/version : ${component} ${version}\n` +
      `  built  (${vsixPath}): ${built}\n` +
      `  reviewed           : ${reviewed}\n` +
      `The reviewer must review the artifact built on the PUBLISH plane (linux). Because the .vsix is ` +
      `byte-reproducible (ADR-0066), a matching build proves reviewed == shipped.`,
    );
  }
  return { component, version, vsixSha256: built, reviewedMatchesShipped: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
  const positionals = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  const version = flag('--version', positionals[0]);
  const vsixPath = flag('--vsix', positionals[1] || 'labview-benchmark-actor.vsix');
  const component = flag('--component', 'extension');
  const agreementPath = flag('--agreement', 'tools/collab-cli/release-agreement.json');
  if (!version) {
    console.error('usage: node scripts/verify-published-vsix.mjs <version> [vsix-path] [--component extension] [--agreement <path>]');
    process.exit(2);
  }
  try {
    const receipt = verifyPublishedVsix({ agreementPath, component, version, vsixPath });
    console.log(`verify-published-vsix: reviewed == shipped for ${receipt.component} ${receipt.version} (sha256 ${receipt.vsixSha256})`);
  } catch (error) {
    console.error(String(error && error.message ? error.message : error));
    process.exit(1);
  }
}
