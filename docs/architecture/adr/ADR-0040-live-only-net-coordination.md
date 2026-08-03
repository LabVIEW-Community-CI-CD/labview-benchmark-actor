# ADR-0040: Live-only net coordination — moving the coordination bus off GitHub Discussions

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator directive (2026-08-03: *"TCP, deprecate the use of github discussions"*; chose the **live-only** model over an async/persistent store) + agent
- Relates to: LBA-REQ-060, LBA-REQ-007 (TCP/UDP coordination bus), ADR-0003/0004 (bus wire format), ADR-0039 (host↔VM-agent closed loop + semantic net verdict types), ADR-0038 (reviewer verdict bus announcement — the Discussion path this supersedes), tools/collab-cli (lbabus `net` vs `post`/`poll`)

## Context

The `lbabus` coordination bus has two transports: `post`/`poll` over a **GitHub Discussion** (async,
store-and-forward — a plane posts, another reads later) and `net send`/`listen` over **TCP** (live — both
ends online). ADR-0039 moved the host↔VM-agent loop + the reviewer-verdict announcement onto `net` TCP; an
operator directive now moves the REST of coordination off Discussions too. A GitHub Discussion was doing two
jobs: (1) a **live relay** and (2) an **async persistent log**. `net` already covers (1). The open question
was how to serve (2) once Discussions are gone.

## Decision

Adopt a **live-only** coordination model over `net` TCP — **no central or async store**.

- **Per-actor local receive-log.** Each actor runs `lbabus net listen --log <file>`, which appends every
  received frame to a **local JSONL receive-log** — the actor's own record of what it heard **while online**,
  not a shared or central store.
- **`net poll` reads the local log.** New `lbabus net poll [--log <file>] [--tail N] [--type T] [--task T]`
  reads + filters the local receive-log, mirroring the Discussion `poll` UX over TCP. With no log (never
  listened / nothing heard) it prints nothing and exits 0; with no `--log` / `VIHS_COLLAB_NET_LOG` it fails
  closed.
- **The send side already exists** (`net send`), so `post` / `postNote` / verdict announcements migrate to
  `net` with no new transport.
- **Accepted tradeoff:** a plane **offline at post time misses the message** — there is no async catch-up.
  This fits the project's *no central DB / zero central infra / reproducibility-over-telemetry* ethos: the
  bus coordinates **live**; durable records are the committed artifacts (signed verdicts, receipts), not a
  bus log.
- **Comms-only holds (ADR-0003):** the receive-log stores only small coordination frames, never run data.

This is requirement **LBA-REQ-060**, the first increment of retiring the GitHub-Discussion transport.

## Consequences

- **Coordination rides TCP end to end.** With the send side (`net send`) + the new read side (`net poll` over
  the local receive-log), an actor can post + poll coordination with **no github.com dependency** — proven on
  loopback (post → log → poll round-trip + type filter + fail-closed).
- **Incremental migration.** The extension (`pollBus` / `postNote` / `postVerdictToBus`), the MCP tools, and
  `post-verdict.mjs` + the release CI migrate to `net` in follow-up increments (with a Discussion fallback
  during transition); then the Discussion transport (`Program.cs` post/poll/wait/init + `GitHubGraphQL.cs`) +
  the CI mock GraphQL harness are deprecated and finally removed.
- **Deferred:** the call-site migrations + the eventual removal of the Discussion transport are their own
  governed increments (LBA-REQ-061+). This ADR establishes the live-only model + the read side.
