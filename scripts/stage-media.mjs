#!/usr/bin/env node
// Build step: stage the shipped media/ assets for the extension package.
//   (1) Copy the unit-tested viewer cursor core (media/viewerCursor.mjs) that media/viewer.js imports verbatim.
//   (2) Generate media/mprr-series.json from the committed mprr short-packet fixture via the absorbed ring
//       core, so the DEPLOYED viewer renders REAL mprr ring-buffer data (operator: "absorb mprr on the
//       extension so once its deployed ... leverage deterministic screenshots ... to compare both results").
// Both staged files are build outputs (gitignored); the .vsix bundles them. Deterministic: identical fixture
// => identical media/mprr-series.json, so the deployed viewer + the screenshot harness render the same series.

import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ingestShortPackets } from '../experiments/mprr-ring/mprrRing.mjs';
import { projectViewerSeries } from '../experiments/mprr-ring/mprrViewerSeries.mjs';
import { verifyManifest } from './agentsManifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
mkdirSync(join(repo, 'media'), { recursive: true });

// 1. Viewer cursor core (unchanged behavior; media/viewer.js imports this verbatim).
copyFileSync(
  join(repo, 'experiments', 'viewer-cursor', 'viewerCursor.mjs'),
  join(repo, 'media', 'viewerCursor.mjs')
);

// 2. Real mprr ring-buffer series for the deployed viewer.
const fixture = JSON.parse(
  readFileSync(join(repo, 'experiments', 'mprr-ring', 'fixtures', 'short-packet-run.json'), 'utf8')
);
const ingest = ingestShortPackets(fixture.packets, {
  blockDurationTicks: fixture.blockDurationTicks,
  capacityBytes: fixture.capacityBytes,
});
const series = projectViewerSeries(ingest, { metric: 'cumulativeBytes' });
writeFileSync(join(repo, 'media', 'mprr-series.json'), `${JSON.stringify(series)}\n`);

// 3. Extension-embedded AGENTS.md (issue #98) + its integrity manifest. The .vsix ships both so the
//    "Write/Check Agent Instructions" commands can materialize + verify them. Fail the build fast if the
//    manifest sha256 has drifted from AGENTS.md (edit AGENTS.md -> bump version -> agentsManifest.mjs --refresh).
const agents = verifyManifest();
if (!agents.ok) {
  console.error('stage-media: extension AGENTS.md manifest is invalid:');
  for (const e of agents.errors) {
    console.error('  - ' + e);
  }
  process.exit(1);
}
copyFileSync(join(repo, 'extension-agents', 'AGENTS.md'), join(repo, 'media', 'AGENTS.md'));
copyFileSync(join(repo, 'extension-agents', 'agents.manifest.json'), join(repo, 'media', 'agents.manifest.json'));

console.log(`staged media/viewerCursor.mjs + media/mprr-series.json (${series.length} points) + media/AGENTS.md`);
