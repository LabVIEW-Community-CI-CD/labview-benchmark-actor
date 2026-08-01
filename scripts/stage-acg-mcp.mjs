#!/usr/bin/env node
// Build step: stage the ACG MCP grid-tools .mjs import closure into out/acg-mcp-bundle/, preserving the
// relative directory structure the engines import, so the SHIPPED extension MCP server
// (out/mcp/runBenchmarkActorMcpServer.js) can dynamically import it and expose the corroboration-grid tools
// from the single extension binary -- instead of a sibling experiments/acg-mcp/server.mjs (LBA-REQ-029
// packaging follow-up). Build output (out/ is gitignored); the .vsix bundles out/** (experiments/** is
// .vscodeignore'd, so the engines must be copied here to ship). The closure is dependency-free (Node
// built-ins only); this script re-verifies it imports cleanly after staging, failing the build on drift.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const bundle = join(repo, 'out', 'acg-mcp-bundle');

// The exact grid-tools import closure (7 files across 4 dirs). Keep in sync with grid-tools.mjs's imports;
// the post-copy import check below fails the build if a relative dependency is missing or added.
const CLOSURE = [
  'acg-mcp/grid-tools.mjs',
  'acg-quorum/compare-witnesses.mjs',
  'acg-quorum/assemble-witness.mjs',
  'acg-provenance/attest.mjs',
  'acg-independence/independence.mjs',
  'acg-transparency/transparency-log.mjs',
  'acg-transparency/verify-release-inclusion.mjs',
];

for (const rel of CLOSURE) {
  const dst = join(bundle, rel);
  mkdirSync(dirname(dst), { recursive: true });
  // read+write (not copyFileSync): avoids the Windows devcontainer 9p/drvfs EPERM fast-path (see stage-media).
  writeFileSync(dst, readFileSync(join(repo, 'experiments', rel)));
}

// Self-validate: the staged closure must import cleanly (catches a missing/added relative dependency).
const grid = await import(pathToFileURL(join(bundle, 'acg-mcp', 'grid-tools.mjs')).href);
if (!Array.isArray(grid.ACG_GRID_TOOLS) || typeof grid.dispatchGridTool !== 'function') {
  console.error('stage-acg-mcp: bundled grid-tools.mjs did not export ACG_GRID_TOOLS + dispatchGridTool');
  process.exit(1);
}
console.log(`staged out/acg-mcp-bundle/ (${CLOSURE.length} files); grid exposes ${grid.ACG_GRID_TOOLS.length} tools`);
