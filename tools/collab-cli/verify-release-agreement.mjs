#!/usr/bin/env node
// Fail-closed release gate: a component release may publish only after BOTH the WIN and LINUX planes
// have committed an explicit agreed:true sign-off for that exact <component, version> in
// release-agreement.json. Encodes the operator directive: publishing shall occur only after
// bidirectional WIN<->LINUX agreement. Run in each release workflow before its publish job; also
// runnable locally by either plane to check status.
//
// Usage:
//   node tools/collab-cli/verify-release-agreement.mjs <version>                    (collab-cli, default)
//   node tools/collab-cli/verify-release-agreement.mjs --component <name> <version>  (e.g. --component extension 0.1.0)
// <version> accepts the bare SemVer or the tagged form (collab-cli-vX.Y.Z / ext-vX.Y.Z).
// Exit:   0 = both planes agreed (cleared to publish); 1 = fail-closed (missing/withheld); 2 = usage.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Parse an optional --component/-c <name> (default collab-cli), then the <version>.
let component = 'collab-cli';
let versionArg = '';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--component' || a === '-c') {
    component = (argv[++i] || '').trim();
  } else if (a.startsWith('--component=')) {
    component = a.slice('--component='.length).trim();
  } else if (!versionArg && !a.startsWith('-')) {
    versionArg = a;
  }
}

if (!component) {
  console.error('usage: verify-release-agreement.mjs [--component <name>] <version>');
  process.exit(2);
}

// Normalize: strip a leading "<prefix>-v" (collab-cli-v / ext-v / any <name>-v that precedes a digit).
const version = (versionArg || '').trim().replace(/^[a-z][a-z0-9-]*-v(?=\d)/i, '');
if (!version) {
  console.error('usage: verify-release-agreement.mjs [--component <name>] <version>   (e.g. 0.8.2, collab-cli-v0.8.2, --component extension ext-v0.1.0)');
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

// Resolve the releases map for this component. collab-cli keeps the legacy top-level `releases`
// (backward-compatible); other components live under `components.<name>.releases`.
let releasesMap;
if (component === 'collab-cli') {
  releasesMap = (doc.components && doc.components['collab-cli'] && doc.components['collab-cli'].releases) || doc.releases;
} else {
  releasesMap = doc.components && doc.components[component] && doc.components[component].releases;
}

// Human-readable tag label for messages (collab-cli-v* / ext-v* / <component>-v*).
const tagPrefix = component === 'collab-cli' ? 'collab-cli-v' : component === 'extension' ? 'ext-v' : `${component}-v`;
const label = `${tagPrefix}${version}`;

const rel = releasesMap && releasesMap[version];
if (!rel || typeof rel !== 'object') {
  console.error(`FAIL (fail-closed): no release-agreement entry for ${component} version ${version} (${label}).`);
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
  console.error(`FAIL (fail-closed): ${label} is NOT cleared to publish.`);
  console.error(`Missing or withheld agreement from: ${missing.join(', ')}.`);
  console.error('Publishing shall occur only after bidirectional WIN<->LINUX agreement (every required plane agreed:true).');
  process.exit(1);
}

console.log(`OK: ${label} has bidirectional agreement from ${required.join(' + ')}:`);
for (const plane of required) {
  const s = signoffs[plane];
  const when = s.at ? ` @ ${s.at}` : '';
  const sha = s.reviewedCommit ? ` (reviewed ${String(s.reviewedCommit).slice(0, 12)})` : '';
  const note = s.note ? ` -- ${s.note}` : '';
  console.log(`  - ${plane}: agreed${when}${sha}${note}`);
}
process.exit(0);
