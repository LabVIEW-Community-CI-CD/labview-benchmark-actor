# labview-benchmark-actor — MCP tools

> GENERATED from the MCP tool registry (`src/mcp/benchmarkActorMcpServer.ts`). Do not hand-edit;
> regenerate with `node scripts/mcpToolDoc.mjs --write docs/mcp-tools.md`. Drift is gated by `npm test`.

The extension contributes a Model Context Protocol server (provider `labviewBenchmarkActor`, server `labview-benchmark-actor`, protocol `2025-06-18`) exposing the following tools to Copilot agent mode. The server is a dependency-free stdio JSON-RPC process launched by the extension; the tools that shell `lbabus` degrade gracefully when the CLI is absent.

## `get_host_capabilities`

Report what the current host can actually run for LabVIEW benchmarking (LabVIEW runtime + bitness, Docker engine, etc.) via the lbabus capabilities probe. Run this before proposing benchmark work.

**Arguments:**

_(no arguments)_

## `get_benchmark_series`

Return the deterministic mprr ring-buffer benchmark metric series the extension's viewer renders, as ordered {t,v} points plus a stable content hash (seriesHash). Reproduce this series; do not re-derive it.

**Arguments:**

_(no arguments)_

## `poll_coordination_bus`

Read the latest cross-plane (WIN <-> LINUX) coordination-bus messages via lbabus poll. The bus is the authoritative "what is next" channel; its timestamps are the single authoritative server clock.

**Arguments:**

- `tail` (integer, optional, range 1..100) — How many of the most recent messages to read (default 10).

## `post_coordination_note`

Post a NOTE to the cross-plane coordination bus via lbabus post.

**Arguments:**

- `message` (string, required) — ASCII coordination note body.
