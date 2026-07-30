/**
 * Model Context Protocol (MCP) surface for labview-benchmark-actor.
 *
 * A dependency-free JSON-RPC 2.0 handler (no MCP SDK) exposing THIS extension's own tools to an agent:
 * host capabilities, the deterministic benchmark series, and the cross-plane coordination bus. Adapted
 * from the vi-history-suite MCP pattern, but it carries none of the VI-semantic domain — it wraps the
 * same surfaces the extension's commands do (`lbabus capabilities|poll|post` + the bundled mprr series).
 *
 * This module is PURE and unit-testable: the side-effecting tool implementations (shelling `lbabus`,
 * reading the bundled series) are INJECTED via {@link BenchmarkActorMcpToolDeps}. Only the stdio
 * entrypoint (`src/mcp/runBenchmarkActorMcpServer.ts`) touches process streams and the real CLI/filesystem.
 */

export const BENCHMARK_ACTOR_MCP_PROTOCOL_VERSION = '2025-06-18';
export const BENCHMARK_ACTOR_MCP_SERVER_NAME = 'labview-benchmark-actor';

/** JSON-RPC 2.0 error codes used by the handler. */
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpToolTextContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpToolTextContent[];
  isError?: boolean;
}

export interface BenchmarkActorMcpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** Thrown by argument parsing so the dispatcher can map it to JSON-RPC -32602 (invalid params). */
export class McpArgumentError extends Error {}

/**
 * The authoritative tool registry. `tools/list` publishes exactly this set, and `tools/call` rejects any
 * name not in it before a handler runs.
 */
export const BENCHMARK_ACTOR_MCP_TOOLS: readonly BenchmarkActorMcpTool[] = [
  {
    name: 'get_host_capabilities',
    description:
      "Report what the current host can actually run for LabVIEW benchmarking (LabVIEW runtime + bitness, " +
      "Docker engine, etc.) via the lbabus capabilities probe. Run this before proposing benchmark work.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_benchmark_series',
    description:
      "Return the deterministic mprr ring-buffer benchmark metric series the extension's viewer renders, as " +
      "ordered {t,v} points plus a stable content hash (seriesHash). Reproduce this series; do not re-derive it.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'poll_coordination_bus',
    description:
      'Read the latest cross-plane (WIN <-> LINUX) coordination-bus messages via lbabus poll. The bus is the ' +
      'authoritative "what is next" channel; its timestamps are the single authoritative server clock.',
    inputSchema: {
      type: 'object',
      properties: {
        tail: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'How many of the most recent messages to read (default 10).'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'post_coordination_note',
    description: 'Post a NOTE to the cross-plane coordination bus via lbabus post.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'ASCII coordination note body.' }
      },
      required: ['message'],
      additionalProperties: false
    }
  }
] as const;

const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(BENCHMARK_ACTOR_MCP_TOOLS.map((t) => t.name));

/** Side-effecting tool implementations, injected by the stdio entrypoint (or a test double). */
export interface BenchmarkActorMcpToolDeps {
  /** Version reported in `initialize` → `serverInfo.version` (the extension/package version). */
  readonly serverVersion: string;
  getHostCapabilities(): Promise<McpToolResult>;
  getBenchmarkSeries(): Promise<McpToolResult>;
  pollCoordinationBus(args: { tail: number }): Promise<McpToolResult>;
  postCoordinationNote(args: { message: string }): Promise<McpToolResult>;
}

function success(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function failure(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function parseTail(rawArguments: unknown): number {
  if (rawArguments === undefined || rawArguments === null) {
    return 10;
  }
  if (typeof rawArguments !== 'object') {
    throw new McpArgumentError('arguments must be an object');
  }
  const tail = (rawArguments as { tail?: unknown }).tail;
  if (tail === undefined) {
    return 10;
  }
  if (typeof tail !== 'number' || !Number.isInteger(tail) || tail < 1 || tail > 100) {
    throw new McpArgumentError('"tail" must be an integer between 1 and 100');
  }
  return tail;
}

function parseMessage(rawArguments: unknown): string {
  if (typeof rawArguments !== 'object' || rawArguments === null) {
    throw new McpArgumentError('arguments must be an object with a "message" string');
  }
  const message = (rawArguments as { message?: unknown }).message;
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new McpArgumentError('"message" must be a non-empty string');
  }
  return message;
}

async function callTool(
  name: string,
  rawArguments: unknown,
  deps: BenchmarkActorMcpToolDeps
): Promise<McpToolResult> {
  switch (name) {
    case 'get_host_capabilities':
      return deps.getHostCapabilities();
    case 'get_benchmark_series':
      return deps.getBenchmarkSeries();
    case 'poll_coordination_bus':
      return deps.pollCoordinationBus({ tail: parseTail(rawArguments) });
    case 'post_coordination_note':
      return deps.postCoordinationNote({ message: parseMessage(rawArguments) });
    default:
      // Unreachable: tools/call already rejected unknown names against KNOWN_TOOL_NAMES.
      throw new McpArgumentError(`unknown tool: ${name}`);
  }
}

/**
 * Dependency-free JSON-RPC 2.0 dispatcher for the labview-benchmark-actor MCP surface. Returns a response
 * for requests, or `null` for notifications (which take no reply). Argument-shape failures become a
 * structured -32602; genuine tool-execution failures stay inside the result envelope (`isError`) per MCP,
 * so the agent can read the message rather than seeing a transport error.
 */
export async function handleBenchmarkActorMcpMessage(
  message: JsonRpcRequest,
  deps: BenchmarkActorMcpToolDeps
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;

  switch (message.method) {
    case 'initialize':
      return success(id, {
        protocolVersion: BENCHMARK_ACTOR_MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: BENCHMARK_ACTOR_MCP_SERVER_NAME, version: deps.serverVersion }
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return success(id, {});

    case 'tools/list':
      return success(id, { tools: BENCHMARK_ACTOR_MCP_TOOLS });

    case 'tools/call': {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== 'string') {
        return failure(id, JSON_RPC_INVALID_PARAMS, 'tools/call requires a string "name"');
      }
      if (!KNOWN_TOOL_NAMES.has(params.name)) {
        return failure(id, JSON_RPC_INVALID_PARAMS, `unknown tool: ${params.name}`);
      }
      try {
        return success(id, await callTool(params.name, params.arguments, deps));
      } catch (error) {
        if (error instanceof McpArgumentError) {
          return failure(id, JSON_RPC_INVALID_PARAMS, error.message);
        }
        throw error;
      }
    }

    default:
      return failure(id, JSON_RPC_METHOD_NOT_FOUND, `unknown method: ${message.method}`);
  }
}
