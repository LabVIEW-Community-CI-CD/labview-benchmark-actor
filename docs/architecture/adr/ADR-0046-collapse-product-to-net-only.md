# ADR-0046: Collapse the coordination product surface to net-only (remove the GitHub-Discussion opt-out) — off-Discussions step 7

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator directive (off GitHub Discussions) + agent
- Relates to: LBA-REQ-066, ADR-0045 (net default — now moot at the product surface), ADR-0041/0042/0043 (the transport SELECTION they introduced is removed from the product; the Discussion arms are gone), ADR-0040 (live-only), ADR-0039 (proven live net loop); DEFERS the CLI Discussion-transport removal to step 8

## Context

Off-Discussions steps 1–6 (ADR-0040..0045) made `net` the default everywhere with GitHub Discussion a legacy
opt-out. But the **product surface** still carried the Discussion arms: the extension's `busPostArgs` + the
`busTransport` selection + the `post`/`poll` argv, the MCP tools' `VIHS_COLLAB_TRANSPORT` selection, and
`post-verdict.mjs`'s `post ... --priority/--ref` branch. With `net` proven live (ADR-0039) and the default
(ADR-0045), the Discussion opt-out is dead weight on the surface users and agents actually touch.

Removing it is the first half of the final teardown. It is split from the **CLI** transport removal (step 8)
because the CLI's Discussion commands (`init/post/poll/wait/delta`) share `GitHubGraphQL.cs` with the
`selfcheck`/`defect` GitHub-API features and the `tools/collab-cli/ci/` mock GraphQL harness — a larger, more
delicate change that deserves its own PR.

## Decision

- **Remove the `labviewBenchmarkActor.busTransport` setting entirely.** There is no transport to select — `net`
  is the only coordination bus. `busNetHosts` / `busNetLog` remain (they configure the net bus).
- **Collapse every product consumer to net-only:**
  - **Extension** (`src/extension.ts`): remove `busPostArgs`; `busConfig()` returns `{ netHosts, netLog }`;
    **Poll Bus** → `net poll`, **Post Note** → `net send`, the verdict announce → `busSendArgs` unconditionally.
  - **MCP** (`src/mcp/*`): `busEnvFromConfig` maps only `VIHS_COLLAB_NET_HOSTS` / `VIHS_COLLAB_NET_LOG`;
    `pollBusArgs` / `postNoteArgs` are net-only; no `VIHS_COLLAB_TRANSPORT`.
  - **`reviewer-workstation/post-verdict.mjs`**: `net send` only — no Discussion branch, no `--priority`/`--ref`.
- **The graceful no-op (ADR-0045) is preserved** — no peer → `--skip-if-no-peer`; no receive-log → `net poll`
  exits 0.
- This is requirement **LBA-REQ-066**.
- **Supersedes the transport-SELECTION portion of ADR-0041/0042/0043** (the product no longer selects a
  transport) and makes the ADR-0045 `busTransport` default moot at the product surface.

## Consequences

- **The product coordinates over the live-only `net` bus ONLY** — there is no way to select the GitHub-Discussion
  transport from the extension / MCP / reviewer surface. A user who had `busTransport: "discussion"` now gets net.
- **The CLI still HAS the Discussion transport commands** (`post/poll/wait/init/delta`) — now unused by the
  product — removed in the deferred final step (**step 8**), together with the `GitHubGraphQL.cs` Discussion
  methods (keeping the REST bits for `selfcheck`/`defect`), the `tools/collab-cli/ci/` mock GraphQL harness, and
  the collab-cli docs.
- **The gates `bus-transport-select` / `mcp-net-transport` / `post-verdict-net-transport` now prove the net-only
  end state** (their ids are retained to keep the LBA-REQ-061/062/063 governance history stable; the prior
  "Gated by" prose is historical).
