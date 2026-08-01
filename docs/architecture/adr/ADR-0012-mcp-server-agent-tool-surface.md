# ADR-0012: The benchmark actor exposes its tools to agents through a Model Context Protocol server

- Status: Accepted
- Date: 2026-08-01
- Deciders: LINUX plane (operator-directed)
- Relates to: LBA-REQ-019, LBA-REQ-012 (agent base instructions), LBA-REQ-013 (coordination bus), `src/mcp/`

## Context

Coding agents (Copilot, Claude, etc.) increasingly consume tools through the **Model Context Protocol (MCP)**.
The benchmark actor already exposes value an agent wants — host capabilities, the deterministic mprr benchmark
series, and the `lbabus` coordination bus (poll / post). The question is how an agent reaches those: bespoke VS
Code commands only, or a standard MCP tool surface the agent can discover and call directly.

## Decision

Ship an **MCP server** that publishes the benchmark actor's tools over newline-delimited JSON-RPC 2.0:

- The protocol logic is a **pure, dependency-free handler** (`benchmarkActorMcpServer.ts`) with **injected tool
  deps**, so it is fully unit-testable without VS Code, a display, or a live `lbabus`.
- A thin **stdio entrypoint** (`runBenchmarkActorMcpServer.ts`) wires stdin/stdout and injects the real deps
  (shell `lbabus`, read the bundled mprr series). It is dependency-free (Node built-ins only), so it adds nothing
  to the packaged extension's runtime dependency allowlist.
- A **definition provider** (`benchmarkActorMcpServerProvider.ts`) registers the server with VS Code's
  `lm.registerMcpServerDefinitionProvider` under the same id the manifest contributes.
- Four tools are published: `get_host_capabilities`, `get_benchmark_series`, `poll_coordination_bus`,
  `post_coordination_note`. A missing `lbabus` degrades to a soft `isError` result (not a transport crash) so
  the agent can act on the message.

## Consequences

- Agents discover and call the benchmark actor's tools through a standard surface, independent of the VS Code
  command palette.
- The pure-handler + injected-deps seam keeps the protocol deterministically unit-testable (`test/mcp-server.mjs`),
  and a bundled tool-doc check (`scripts/mcpToolDoc.mjs`) keeps `docs/mcp-tools.md` in sync with the registry.
- No new runtime dependency enters the packaged `.vsix` (Node built-ins only).

## Alternatives considered

- **Expose the tools only as VS Code commands.** Rejected: commands are not agent-discoverable as tools; MCP is
  the emerging standard surface an agent already understands.
- **Embed a full MCP SDK.** Rejected: the JSON-RPC 2.0 stdio contract the actor needs is small; a dependency-free
  handler keeps the extension's dependency allowlist clean and the protocol logic unit-testable.
