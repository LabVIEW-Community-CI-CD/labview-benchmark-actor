#!/usr/bin/env node
/**
 * Stdio transport for the labview-benchmark-actor MCP server: newline-delimited JSON-RPC 2.0 on
 * stdin/stdout, diagnostics on stderr (the MCP stdio convention). All protocol logic lives in the pure,
 * unit-tested `benchmarkActorMcpServer` handler; this entrypoint only wires the streams and injects the
 * real tool implementations (shelling `lbabus`, reading the bundled mprr series). It is dependency-free
 * (Node built-ins only) so it adds nothing to the packaged extension's runtime dependency allowlist.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  BenchmarkActorMcpToolDeps,
  JsonRpcRequest,
  McpArgumentError,
  McpToolResult,
  handleBenchmarkActorMcpMessage
} from '../mcp/benchmarkActorMcpServer';

const execFileAsync = promisify(execFile);
const CLI = 'lbabus';

// out/mcp/runBenchmarkActorMcpServer.js -> the extension install root is two levels up.
const repoRoot = path.join(__dirname, '..', '..');

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shell `lbabus`, folding stdout/stderr into a tool result. A missing CLI or non-zero exit is a
 *  soft, agent-readable `isError` result (not a transport crash), so the agent can act on it. */
async function runLbabus(args: string[], timeoutMs: number): Promise<McpToolResult> {
  try {
    const { stdout, stderr } = await execFileAsync(CLI, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024
    });
    const text = [stdout.trimEnd(), stderr.trim() ? `[stderr] ${stderr.trimEnd()}` : '']
      .filter((s) => s.length > 0)
      .join('\n');
    return { content: [{ type: 'text', text: text.length > 0 ? text : '(no output)' }] };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const detail =
      err.code === 'ENOENT'
        ? `the '${CLI}' coordination CLI is not on PATH. Install it (see the repository README) to use this tool.`
        : (err.stderr?.trim() || err.stdout?.trim() || err.message);
    return { content: [{ type: 'text', text: `Tool error: ${detail}` }], isError: true };
  }
}

export function readServerVersion(root: string = repoRoot): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Read the deterministic bundled mprr series and project it into a stable, hashed envelope. */
export async function getBenchmarkSeries(root: string = repoRoot): Promise<McpToolResult> {
  try {
    const raw = readFileSync(path.join(root, 'media', 'mprr-series.json'), 'utf8');
    const series = JSON.parse(raw) as Array<{ t: number; v: number }>;
    const seriesHash = createHash('sha256').update(JSON.stringify(series)).digest('hex');
    const envelope = {
      schema: 'labview-benchmark-actor/benchmark-series@v1',
      points: series.length,
      seriesHash,
      series
    };
    return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Tool error: benchmark series unavailable: ${errorText(error)}` }],
      isError: true
    };
  }
}

const serverDeps: BenchmarkActorMcpToolDeps = {
  serverVersion: readServerVersion(),
  getHostCapabilities: () => runLbabus(['capabilities'], 15000),
  getBenchmarkSeries,
  pollCoordinationBus: ({ tail }) => runLbabus(['poll', '--full', '--tail', String(tail)], 30000),
  postCoordinationNote: ({ message }) => runLbabus(['post', '--type', 'NOTE', '--message', message], 20000)
};

// Fold the ACG corroboration-grid tools into THIS server from the bundled dep-free engines
// (out/acg-mcp-bundle/, staged by scripts/stage-acg-mcp.mjs), so agents get the grid tools from the single
// shipped extension binary rather than a sibling experiments/acg-mcp/server.mjs (LBA-REQ-029). The engines are
// ESM .mjs and this entrypoint compiles to CommonJS, so use a real dynamic import() (hidden from tsc's
// down-levelling via new Function) to load them. If the bundle is absent, the grid tools are simply not
// offered (the core tools still work) -- degrade, do not crash.
const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<Record<string, unknown>>;

export async function loadAcgGridTools(deps: BenchmarkActorMcpToolDeps, root: string = repoRoot): Promise<void> {
  try {
    const bundlePath = path.join(root, 'out', 'acg-mcp-bundle', 'acg-mcp', 'grid-tools.mjs');
    const grid = await dynamicImport(pathToFileURL(bundlePath).href);
    const gridTools = grid.ACG_GRID_TOOLS as BenchmarkActorMcpToolDeps['extraTools'];
    const gridDispatch = grid.dispatchGridTool as ((name: string, args: unknown) => unknown) | undefined;
    const GridArgError = grid.McpArgumentError as (new (message?: string) => Error) | undefined;
    if (!Array.isArray(gridTools) || typeof gridDispatch !== 'function') {
      return;
    }
    const mutable = deps as { extraTools?: BenchmarkActorMcpToolDeps['extraTools']; dispatchExtraTool?: BenchmarkActorMcpToolDeps['dispatchExtraTool'] };
    mutable.extraTools = gridTools;
    mutable.dispatchExtraTool = (name: string, args: unknown) => {
      try {
        return gridDispatch(name, args);
      } catch (error) {
        // Bridge the bundled grid's own McpArgumentError to this server's, so a bad arg maps to -32602.
        if (GridArgError && error instanceof GridArgError) {
          throw new McpArgumentError(errorText(error));
        }
        throw error;
      }
    };
  } catch (error) {
    process.stderr.write(`ACG grid tools unavailable (bundle not loaded): ${errorText(error)}\n`);
  }
}

function writeResponse(response: unknown): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function dispatchLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }
  let message: JsonRpcRequest;
  try {
    message = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    writeResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  const response = await handleBenchmarkActorMcpMessage(message, serverDeps);
  if (response !== null) {
    writeResponse(response);
  }
}

function dispatchLineSafely(line: string): void {
  void dispatchLine(line).catch((error: unknown) => {
    process.stderr.write(`dispatch error: ${errorText(error)}\n`);
  });
}

export async function runBenchmarkActorMcpServer(): Promise<void> {
  await loadAcgGridTools(serverDeps);
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      dispatchLineSafely(line);
      newlineIndex = buffer.indexOf('\n');
    }
  });
  process.stdin.on('end', () => {
    if (buffer.trim().length > 0) {
      dispatchLineSafely(buffer);
    }
  });
  process.stderr.write('labview-benchmark-actor MCP server ready (stdio, newline-delimited JSON-RPC)\n');
}

if (require.main === module) {
  void runBenchmarkActorMcpServer();
}
