# ADR-0042: MCP coordination tools transport selection — off-Discussions step 3

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator directive (2026-08-03, the live-only net model) + agent
- Relates to: LBA-REQ-062, ADR-0041 (extension transport selection), ADR-0040 (live-only net coordination), ADR-0039 (semantic net verdict types), src/mcp

## Context

ADR-0041 let the extension select the coordination-bus transport (Discussion default, `net` opt-in). The
extension's MCP server (a stdio process launched by the provider) still shelled the GitHub-Discussion
`poll`/`post` for its `poll_coordination_bus` / `post_coordination_note` tools. Step 3 migrates the MCP tools
too. The MCP server is a separate process, so it cannot read vscode config directly.

## Decision

- **The provider passes the transport as env.** `busEnvFromConfig` maps the extension's `busTransport` /
  `busNetHosts` / `busNetLog` config to `VIHS_COLLAB_TRANSPORT` / `VIHS_COLLAB_NET_HOSTS` /
  `VIHS_COLLAB_NET_LOG`, set on the launched stdio `McpStdioServerDefinition` env. Empty values are omitted →
  Discussion default.
- **The server selects the transport from env.** `pollBusArgs` / `postNoteArgs` route `poll_coordination_bus`
  → `net poll --log` and `post_coordination_note` → `net send --hosts` under `net`, else the Discussion
  `poll`/`post`. Same env names as the CLI (`VIHS_COLLAB_NET_LOG`) + the extension config.
- **Discussion stays the default; the tool schemas are unchanged** (no doc/registry change — the MCP tool doc
  still matches). The tools stay soft-`isError` on a missing CLI.

This is requirement **LBA-REQ-062**.

## Consequences

- **The agent tool surface coordinates over TCP too.** With `busTransport=net`, an agent's
  `poll_coordination_bus` / `post_coordination_note` ride the live bus + the local receive-log — no github.com
  dependency — matching the extension commands (ADR-0041).
- **Deferred:** `post-verdict.mjs` + the release-CI verdict announcement (which have no persistent `net` peer
  in CI), then deprecating + removing the Discussion transport + the CI mock GraphQL harness.
