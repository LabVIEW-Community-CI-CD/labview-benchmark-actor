/**
 * VS Code registration for the labview-benchmark-actor MCP server.
 *
 * Makes the dependency-free stdio MCP server (`out/mcp/runBenchmarkActorMcpServer.js`) discoverable inside
 * VS Code by registering an MCP server definition provider, so Copilot agent mode can launch it and call
 * its tools (host capabilities, the deterministic benchmark series, the coordination bus). The definition
 * launches the bundled entrypoint with the editor's own Node runtime (`process.execPath`), per the VS Code
 * MCP API guidance. Adapted from the vi-history-suite provider, minus the pinned dev-tools machinery — this
 * extension only ever launches its bundled server.
 */
import * as path from 'node:path';

import * as vscode from 'vscode';

/**
 * Provider id shared between the `contributes.mcpServerDefinitionProviders` manifest entry and the runtime
 * `registerMcpServerDefinitionProvider` call. The two MUST match for VS Code to bind the contribution.
 */
export const BENCHMARK_ACTOR_MCP_PROVIDER_ID = 'labviewBenchmarkActor';

/** Human-readable label shown for the contributed MCP server. */
export const BENCHMARK_ACTOR_MCP_SERVER_LABEL = 'LabVIEW Benchmark Actor: MCP tools';

/** Path segments, relative to the extension install root, of the bundled stdio MCP server entrypoint. */
export const BENCHMARK_ACTOR_MCP_SERVER_SCRIPT_SEGMENTS = [
  'out',
  'mcp',
  'runBenchmarkActorMcpServer.js'
] as const;

/** Absolute path to the bundled MCP server entrypoint for an extension installed at `extensionPath`. */
export function resolveBenchmarkActorMcpServerScriptPath(extensionPath: string): string {
  return path.join(extensionPath, ...BENCHMARK_ACTOR_MCP_SERVER_SCRIPT_SEGMENTS);
}

/** Plain, VS Code class-free description of the stdio server definition (unit-testable in isolation). */
export interface BenchmarkActorMcpServerDefinitionFields {
  readonly label: string;
  readonly command: string;
  readonly args: string[];
  readonly version?: string;
}

/** Builds the fields of the stdio MCP server definition. Free of the `McpStdioServerDefinition` class. */
export function buildBenchmarkActorMcpServerDefinitionFields(options: {
  readonly extensionPath: string;
  readonly execPath: string;
  readonly version?: string;
  readonly scriptPath?: string;
}): BenchmarkActorMcpServerDefinitionFields {
  return {
    label: BENCHMARK_ACTOR_MCP_SERVER_LABEL,
    command: options.execPath,
    args: [options.scriptPath ?? resolveBenchmarkActorMcpServerScriptPath(options.extensionPath)],
    version: options.version
  };
}

/**
 * Registers the labview-benchmark-actor MCP server definition provider with VS Code.
 *
 * Guarded for hosts predating the stable MCP API (VS Code 1.101): when
 * `vscode.lm.registerMcpServerDefinitionProvider` is unavailable the function is a no-op and returns
 * `undefined`. On success the disposable is pushed to the extension subscriptions and also returned for
 * direct disposal in tests.
 */
export function registerBenchmarkActorMcpServerProvider(
  context: vscode.ExtensionContext
): vscode.Disposable | undefined {
  const registrar = vscode.lm?.registerMcpServerDefinitionProvider;
  if (typeof registrar !== 'function') {
    return undefined;
  }

  const extensionRoot =
    (context as { extensionPath?: string }).extensionPath ?? context.extensionUri?.fsPath ?? '';
  const fields = buildBenchmarkActorMcpServerDefinitionFields({
    extensionPath: extensionRoot,
    execPath: process.execPath,
    version: context.extension?.packageJSON?.version as string | undefined
  });

  const provider: vscode.McpServerDefinitionProvider = {
    provideMcpServerDefinitions: () => [
      new vscode.McpStdioServerDefinition(fields.label, fields.command, fields.args, {}, fields.version)
    ]
  };

  const disposable = vscode.lm.registerMcpServerDefinitionProvider(BENCHMARK_ACTOR_MCP_PROVIDER_ID, provider);
  context.subscriptions.push(disposable);
  return disposable;
}
