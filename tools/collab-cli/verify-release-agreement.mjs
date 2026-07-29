#!/usr/bin/env node
// Fail-closed release gate: a collab-cli-vX.Y.Z release may publish only after BOTH the WIN and
// LINUX planes have committed an explicit agreed:true sign-off for that exact version in
// release-agreement.json. Encodes the operator directive: publishing shall occur only after
// bidirectional WIN<->LINUX agreement. Run in the collab-cli-release workflow before the publish
// job (release: needs: [harness, agreement]); also runnable locally by either plane to check status.
//
// Usage:  node tools/collab-cli/verify-release-agreement.mjs <version>     (e.g. 0.8.2)
// Exit:   0 = both planes agreed (cleared to publish); 1 = fail-closed (missing/withheld); 2 = usage.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const version = (process.argv[2] || '').trim().replace(/^collab-cli-v/, '');
if (!version) {
  console.error('usage: verify-release-agreement.mjs <version>   (e.g. 0.8.2 or collab-cli-v0.8.2)');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, 'release-agreement.json');

let doc;
try {
  doc = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`FAIL (fail-closed): cannot read/parse ${file}: ${err.message}`);
  process.exit(1);
}

const required = Array.isArray(doc.requiredPlanes) && doc.requiredPlanes.length
  ? doc.requiredPlanes
  : ['WIN', 'LINUX'];

const rel = doc.releases && doc.releases[version];
if (!rel || typeof rel !== 'object') {
  console.error(`FAIL (fail-closed): no release-agreement entry for version ${version}.`);
  console.error(`Publishing requires bidirectional agreement from ${required.join(' + ')} (both agreed:true).`);
  process.exit(1);
}

const signoffs = rel.signoffs || {};
const missing = [];
for (const plane of required) {
  const s = signoffs[plane];
  if (!s || s.agreed !== true) missing.push(plane);
}

if (missing.length) {
  console.error(`FAIL (fail-closed): collab-cli-v${version} is NOT cleared to publish.`);
  console.error(`Missing or withheld agreement from: ${missing.join(', ')}.`);
  console.error('Publishing shall occur only after bidirectional WIN<->LINUX agreement (every required plane agreed:true).');
  process.exit(1);
}

console.log(`OK: collab-cli-v${version} has bidirectional agreement from ${required.join(' + ')}:`);
for (const plane of required) {
  const s = signoffs[plane];
  const when = s.at ? ` @ ${s.at}` : '';
  const sha = s.reviewedCommit ? ` (reviewed ${String(s.reviewedCommit).slice(0, 12)})` : '';
  const note = s.note ? ` -- ${s.note}` : '';
  console.log(`  - ${plane}: agreed${when}${sha}${note}`);
}
process.exit(0);
