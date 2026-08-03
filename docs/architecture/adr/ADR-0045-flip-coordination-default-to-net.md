# ADR-0045: Flip the coordination default to `net` + graceful no-op when unconfigured — off-Discussions step 6

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator decision (2026-08-03: "flip to net-default now, with graceful no-op when unconfigured") + agent
- Relates to: LBA-REQ-065, ADR-0040/0041/0042/0043/0044 (off-Discussions steps 1–5), ADR-0039 (proven live host↔VM-agent net loop), LBA-REQ-060..064; UPDATES the transport DEFAULT chosen in ADR-0041/0042/0043 (was Discussion) and SOFTENS the `net poll` fail-closed behavior of ADR-0040 to a graceful no-op

## Context

Steps 1–5 (ADR-0040..0044) made the live-only `net` bus available everywhere — the extension (ADR-0041),
the MCP provider + stdio server (ADR-0042), and `post-verdict.mjs` (ADR-0043) — and dropped the release-CI
Discussion announce (ADR-0044). But each of those steps kept **Discussion as the default** during the
transition, so `net` was opt-in. With the net loop proven live (ADR-0039) and Discussion no longer used in
CI, the only thing pinning Discussion as the default is inertia.

Flipping the default naively would hurt a fresh, unconfigured install: `net poll` with no receive-log was
**fail-closed** (ADR-0040) and would error, and `net send` with no peer would sit in a dead ~3s loopback.
An unconfigured net-default must instead do **nothing, quietly**.

## Decision

- **Flip the `busTransport` default from `discussion` to `net`** across the extension, the MCP provider +
  stdio server, and `post-verdict.mjs`. Discussion becomes a **legacy opt-out**
  (`labviewBenchmarkActor.busTransport: "discussion"` / `VIHS_COLLAB_TRANSPORT=discussion`).
- **Graceful no-op when unconfigured:**
  - `net poll` with **no receive-log** exits `0` with a hint (softening the ADR-0040 fail-closed to graceful).
  - The send side passes **`--skip-if-no-peer`**, so `net send` with **no peer** exits `0` with a hint (no
    dead loopback). The extension / MCP / post-verdict callers pass `--skip-if-no-peer` when no host is set.
  - An unconfigured net-default install thus does nothing (no error, no hang) until a peer (`busNetHosts` /
    `VIHS_COLLAB_NET_HOSTS`) and/or a receive-log (`busNetLog` / `VIHS_COLLAB_NET_LOG`) is configured.
- This is requirement **LBA-REQ-065**.

## Consequences

- **Fresh installs default to the live net bus** — coordination "just works" once a peer/receive-log is
  configured, with zero GitHub-Discussion dependency in the default path.
- **Unconfigured installs are silent no-ops** (the live-only tradeoff, ADR-0040) rather than erroring or
  hanging; the operator opts into Discussion explicitly if they still want it during the final wind-down.
- **The `net poll` fail-closed behavior (ADR-0040) is softened to graceful** — the net-coordination-log proof's
  former `pollWithoutLogFailsClosed` case is now `pollWithoutLogGraceful`; the `net-default-graceful` gate
  source-asserts both graceful branches + the net default.
- **Deferred (final):** deprecate + remove the Discussion transport itself (`Program.cs` post/poll/wait/init +
  `GitHubGraphQL.cs`) + the CI mock GraphQL harness — now unblocked, since net is the default.
