# ADR-0048: Retire LBA-REQ-013 (message priority + addressing) — superseded by the live-only net model — off-Discussions step 8b

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator decision (2026-08-03: retire — option B) + agent
- Relates to: LBA-REQ-013 (RETIRED here), ADR-0047 (CLI Discussion-transport removal — removed the implementation), ADR-0040 (live-only net coordination), ADR-0003 (net wire format `bus-msg@1`, which carries no priority/addressee), LBA-REQ-059; completes the off-Discussions cleanup (step 8b)

## Context

LBA-REQ-013 gave the GitHub-Discussion coordination bus a **message priority tier** (`P0`–`P3`,
`--min-priority`) and **plane addressing** (`--to` / `--to-me`), implemented entirely in the now-removed
`lbabus post`/`poll`/`wait` commands + the `CollabMessage` / `Priority` model. Removing the Discussion
transport (ADR-0047) orphaned the requirement: its acceptance criteria reference deleted commands, and the
live-only `net` `BusEnvelope` (`bus-msg@1`: `Schema` / `SessionId` / `SenderId` / `Seq` / `Ts` / `Type` /
`Task` / `Payload` / `AckOf`) deliberately carries no priority or addressee field.

## Decision

- **Retire / supersede LBA-REQ-013.** Priority is *inbox triage* — under the live-only model (ADR-0040) there
  is no async inbox to triage (messages are live + point-to-point), and `net send --hosts` already targets a
  specific peer, so plane-addressing is subsumed by host targeting. Both are moot on `net`.
- **Delete the dead model** — `CollabMessage.cs` + `Priority.cs` (unused since ADR-0047).
- Mark LBA-REQ-013 **Superseded** across the SRS section / RTM / test-plan / architecture view; **T-013** is
  retired (the priority/addressing behavior is no longer implemented, so there is nothing to assert).
- **Operator chose this (option B)** over re-implementing priority + addressing on the `net` envelope. If
  per-peer priority/addressing is ever wanted on `net`, it is a **new** requirement on the `net` envelope, not a
  revival of this one.

## Consequences

- **`lbabus` coordination is net-only with no message priority/addressing** — a simpler envelope, consistent
  with the live-only design. The `net` `Types` set keeps its first-class semantic verdict types
  (RESOLVED/REFINE/BLOCKED, ADR-0039); those are unrelated to the retired priority/addressing.
- **The capability + its cross-plane back-read-compat proof** (flat-scalar additive fields, `vihs-collab-msg@v1`,
  bus finding 17812593) remain in git history if a `net` equivalent is ever wanted.
- **Deferred (a small follow-up):** trim the ci mock's now-vestigial GraphQL discussion + release
  handlers/fixtures (`tools/collab-cli/ci/LbaBus.Ci.Mock`) + the `ci/README.md` fixture table — harmless dead
  scaffolding; the harness passes without it (the remaining cases are the `defect` REST issue-comment sink +
  the `grep` cases). This completes the off-Discussions migration cleanup.
