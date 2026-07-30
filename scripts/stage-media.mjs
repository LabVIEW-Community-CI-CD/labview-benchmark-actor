#!/usr/bin/env node
// Build step: stage the shipped media/ assets for the extension package.
//   (1) Copy the unit-tested viewer cursor core (media/viewerCursor.mjs) that media/viewer.js imports verbatim.
//   (2) Generate media/mprr-series.json from the committed mprr short-packet fixture via the absorbed ring
//       core, so the DEPLOYED viewer renders REAL mprr ring-buffer data (operator: "absorb mprr on the
//       extension so once its deployed ... leverage deterministic screenshots ... to compare both results").
// Both staged files are build outputs (gitignored); the .vsix bundles them. Deterministic: identical fixture
// => identical media/mprr-series.json, so the deployed viewer + the screenshot harness render the same series.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ingestShortPackets } from '../experiments/mprr-ring/mprrRing.mjs';
import { projectViewerSeries } from '../experiments/mprr-ring/mprrViewerSeries.mjs';
import { verifyManifest } from './agentsManifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
mkdirSync(join(repo, 'media'), { recursive: true });

// 1. Viewer cursor core (unchanged behavior; media/viewer.js imports this verbatim).
//    Staged via read+write rather than copyFileSync: on the Windows devcontainer's 9p/drvfs bind mount,
//    copyFileSync's reflink/copy_file_range fast path can throw a transient EPERM when writing into the
//    just-created media/ dir on a cold mount. read+write avoids that path and is deterministic everywhere.
writeFileSync(
  join(repo, 'media', 'viewerCursor.mjs'),
  readFileSync(join(repo, 'experiments', 'viewer-cursor', 'viewerCursor.mjs'))
);

// 1b. Viewer monotonic-counter renderer (manual-procedure-record on-screen anchor); media/viewer.js imports
//     it verbatim. Self-contained (inline glyphs) so it is stageable; verify-counter.mjs guards those glyphs
//     stay byte-identical to the known-digit-reader, so a captured frame's counter reads back exactly.
writeFileSync(
  join(repo, 'media', 'counter-render.mjs'),
  readFileSync(join(repo, 'experiments', 'manual-procedure-record', 'counter-render.mjs'))
);

// 1c. Benchmark UI builders + the real committed benchmark fixtures for the shipped webview commands
//     (Open Benchmark Run / Open Benchmark Trend / Open Frame Correlator). The extension host imports the two
//     PURE builders (both self-contained ESM, gated by verify-benchmark-panels.mjs + verify-scrubber.mjs) and
//     feeds them the staged REAL LabVIEW launch record + 5-run trend, so the deployed extension renders the
//     same real benchmark evidence the local gates re-validate.
writeFileSync(
  join(repo, 'media', 'benchmark-panels.mjs'),
  readFileSync(join(repo, 'experiments', 'mprr-capture-ring', 'benchmark-panels.mjs'))
);
writeFileSync(
  join(repo, 'media', 'buildBenchmarkFrameScrubberHtml.mjs'),
  readFileSync(join(repo, 'experiments', 'dashboard-slider', 'buildBenchmarkFrameScrubberHtml.mjs'))
);
writeFileSync(
  join(repo, 'media', 'labview-launch-record.json'),
  readFileSync(join(repo, 'experiments', 'mprr-capture-ring', 'fixtures', 'labview-launch-record.json'))
);
writeFileSync(
  join(repo, 'media', 'labview-launch-trend.json'),
  readFileSync(join(repo, 'experiments', 'mprr-capture-ring', 'fixtures', 'labview-launch-trend.json'))
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
// Staged via read+write (same 9p/drvfs EPERM avoidance as media/viewerCursor.mjs above).
writeFileSync(join(repo, 'media', 'AGENTS.md'), readFileSync(join(repo, 'extension-agents', 'AGENTS.md')));
writeFileSync(join(repo, 'media', 'agents.manifest.json'), readFileSync(join(repo, 'extension-agents', 'agents.manifest.json')));

console.log(`staged media/viewerCursor.mjs + media/counter-render.mjs + media/benchmark-panels.mjs + media/buildBenchmarkFrameScrubberHtml.mjs + media/mprr-series.json (${series.length} points) + benchmark fixtures + media/AGENTS.md`);
