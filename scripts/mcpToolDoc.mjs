#!/usr/bin/env node
// Generate (or drift-check) the MCP tool reference from the AUTHORITATIVE compiled tool registry
// (out/mcp/benchmarkActorMcpServer.js), so the doc can never drift from what `tools/list` actually
// publishes. ci-docs-style: `--write <path>` regenerates; `--check <path>` fails (exit 3) on drift.
//
// Needs `npm run compile` first (loads the compiled core). Wired into `npm test`, which compiles.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = join(here, '..');

const corePath = join(root, 'out', 'mcp', 'benchmarkActorMcpServer.js');
if (!existsSync(corePath)) {
  console.error('out/mcp/benchmarkActorMcpServer.js not found -- run `npm run compile` first.');
  process.exit(1);
}
const { BENCHMARK_ACTOR_MCP_TOOLS, BENCHMARK_ACTOR_MCP_PROTOCOL_VERSION, BENCHMARK_ACTOR_MCP_SERVER_NAME } =
  require(corePath);

function renderArgs(inputSchema) {
  const props = inputSchema.properties ?? {};
  const names = Object.keys(props);
  if (names.length === 0) {
    return '_(no arguments)_';
  }
  const required = new Set(inputSchema.required ?? []);
  return names
    .map((n) => {
      const p = props[n];
      const parts = [p.type ?? 'any', required.has(n) ? 'required' : 'optional'];
      if (typeof p.minimum === 'number' || typeof p.maximum === 'number') {
        parts.push(`range ${p.minimum ?? ''}..${p.maximum ?? ''}`);
      }
      return `- \`${n}\` (${parts.join(', ')}) — ${p.description ?? ''}`.trimEnd();
    })
    .join('\n');
}

function render() {
  const lines = [];
  lines.push('# labview-benchmark-actor — MCP tools');
  lines.push('');
  lines.push(
    '> GENERATED from the MCP tool registry (`src/mcp/benchmarkActorMcpServer.ts`). Do not hand-edit;'
  );
  lines.push(
    '> regenerate with `node scripts/mcpToolDoc.mjs --write docs/mcp-tools.md`. Drift is gated by `npm test`.'
  );
  lines.push('');
  lines.push(
    `The extension contributes a Model Context Protocol server (provider \`labviewBenchmarkActor\`, ` +
      `server \`${BENCHMARK_ACTOR_MCP_SERVER_NAME}\`, protocol \`${BENCHMARK_ACTOR_MCP_PROTOCOL_VERSION}\`) ` +
      `exposing the following tools to Copilot agent mode. The server is a dependency-free stdio JSON-RPC ` +
      `process launched by the extension; the tools that shell \`lbabus\` degrade gracefully when the CLI is absent.`
  );
  lines.push('');
  for (const tool of BENCHMARK_ACTOR_MCP_TOOLS) {
    lines.push(`## \`${tool.name}\``);
    lines.push('');
    lines.push(tool.description);
    lines.push('');
    lines.push('**Arguments:**');
    lines.push('');
    lines.push(renderArgs(tool.inputSchema));
    lines.push('');
  }
  // Canonical: LF, single trailing newline, no trailing whitespace.
  return lines.join('\n').replace(/[ \t]+$/gm, '').replace(/\n*$/, '\n');
}

const mode = process.argv[2];
const target = process.argv[3] ?? join(root, 'docs', 'mcp-tools.md');
const generated = render();

if (mode === '--check') {
  // Normalize CRLF->LF on the committed side so a Windows/git autocrlf checkout never false-drifts against
  // the LF-canonical generated output (LINUX runs this too).
  const current = existsSync(target) ? readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== generated) {
    console.error(`mcp-tool-doc: DRIFT -- ${target} does not match the tool registry. Regenerate with --write.`);
    process.exit(3);
  }
  console.log(`mcp-tool-doc: PASS -- ${target} matches the ${BENCHMARK_ACTOR_MCP_TOOLS.length}-tool registry.`);
} else if (mode === '--write') {
  writeFileSync(target, generated);
  console.log(`mcp-tool-doc: wrote ${target} (${BENCHMARK_ACTOR_MCP_TOOLS.length} tools).`);
} else {
  process.stdout.write(generated);
}
