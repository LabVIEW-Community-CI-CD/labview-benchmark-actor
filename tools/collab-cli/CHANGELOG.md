# Changelog — `lbabus` (LabViewBenchmarkActor.CollabBus)

All notable changes to the shared cross-plane coordination-bus CLI are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are published as immutable, SemVer-tagged GitHub Releases (`collab-cli-vX.Y.Z`)
so the WIN and LINUX planes install the exact same pinned version and cannot drift.

## [Unreleased]

## [0.13.0] — 2026-07-31

### Added

- **`lbabus net send --stream` — persistent-connection, multi-frame streaming.** One TCP connection carries
  `--count N` seq'd `bus-msg@1` frames (`seq S..S+N-1`; `--seq` sets S) plus an optional terminal `DONE(S+N-1)`
  via `--done`, with a **single bulk flush** (`BusWire.WriteFrame(..., flush: false)`) instead of the
  per-frame connect + flush of the single-frame send. This lifts a source from the ~O(100) frames/s of the
  one-process-per-frame model to the transport/disk ceiling while preserving the bus framing and strict
  per-`(sessionId, senderId)` seq order. Payload is `--message`/`--message-file`, or `--frame-bytes B` filler
  for throughput. Measured (host loopback, net8 via `DOTNET_ROLL_FORWARD=Major` on a net10 runtime): ~784k
  small frames/s; ~3.0 GB/s to the wire; ~1.46 GB/s landed on NVMe (disk-bound). Back-compat: without
  `--stream`, `net send` is byte-for-byte unchanged.

## [0.12.0] — 2026-07-30

### Added

- **Commit-derived actor role → role-specific instructions.** `lbabus agents` now emits an optional role
  overlay on top of the pinned base instructions:
  - `lbabus agents --role <name>` appends the embedded `agents/roles/<name>.md` overlay — a more specific,
    role-scoped brief — to the base.
  - `lbabus agents --role-from-commit [<ref>] [--repo <dir>]` derives the role from the commit DESCRIPTION
    (the last `Actor:`/`Agent:` git trailer of the checked-out commit, default `HEAD`). So an actor built
    from a commit can reconstruct its specialized instructions from just that commit — the commit names the
    actor, the actor derives it via the commit.
  - `lbabus agents --list-roles` enumerates the overlays embedded in this version.
  - `--out`/`--check` honor the selected role (the stamp header records `role:<name>` and the combined sha);
    an unknown role or a commit without an `Actor:` trailer falls back to base-only (stderr note, exit 0).
  - The base `AGENTS.md` stays canonical and pinned; overlays specialize it without editing it. Ships one
    overlay, `mesh-actor`.

## [0.11.0] — 2026-07-30

### Added

- **`lbabus net beacon --bind <ip>`** — pin the SOURCE interface so presence beacons egress a chosen NIC
  (e.g. the host-only mesh `192.168.56.x`) rather than the NAT default route the OS would otherwise pick.
  Mirrors `net listen --bind`. A startup `[net] beacon bind=… udp=… broadcast=… hosts=…` diagnostic line
  now makes the egress choice visible (how the multi-NIC NAT-vs-host-only egress was diagnosed).
- **`lbabus net beacon` subnet-directed / explicit broadcast** — SO_BROADCAST is now enabled for a
  directed-broadcast target (a `--hosts` entry ending in `.255`, e.g. `192.168.56.255`) or an explicit
  `--broadcast`, not only the literal `255.255.255.255` (which egresses NAT). Lets the mesh broadcast
  presence on a CHOSEN subnet (host-only vs NAT).

### Changed

- **`lbabus net beacon` per-host sends are now loss-safe** — a per-host send error (an unreachable
  directed-broadcast subnet, a down peer) skips only that peer for the round instead of aborting the whole
  fan-out, matching the advisory/loss-safe beacon contract (ADR-0004) already applied to DNS-resolve misses.

## [0.10.0] — 2026-07-30

Updates the embedded agent base instructions (surfaced by `lbabus agents`) — no CLI code change. Both
planes should `dotnet tool update` to `0.10.0` once the tag is cut so every session shares the new base.

### Added

- **`AGENTS.md`: new "Fork posture & merge ownership" section** — codifies the shared-repo role split so
  two agents never step on each other: one plane is the fork CONTRIBUTOR (raises PRs from feature branches,
  never lands to `main`), the other the upstream MAINTAINER (reviews + merges + owns CI/release/publish);
  non-overlapping branches; "maintainer merges, race-loser rebases"; the squash-race guard (squash only
  when the commit set is final); poll-before-ship; and the same-identity self-approve caveat.
- **`AGENTS.md`: new "Clean-room provisioning (agent-driven, from scratch)" section** — the agent drives
  building the LabVIEW clean-room VM from a stock OS ISO end-to-end; the ISO download is the agent's job but
  gated on EXPLICIT user approval (verify the vendor `SHA256SUMS`); build + provision run unattended via
  `cleanroom/ubuntu-labview/`; the user's ONLY responsibility is activating LabVIEW with their NI license.

## [0.9.0] — 2026-07-29

Updates the embedded agent base instructions (surfaced by `lbabus agents`) — no CLI code change. Both
planes should `dotnet tool update` to `0.9.0` once the tag is cut so every session shares the new base.
Released together with the devcontainer fork-publish change in the same PR (#118).

### Added

- **`AGENTS.md`: new "Dev containers & the prebuilt image" section** banking this cycle's cross-plane
  dev-container lessons — the devcontainer now pulls a fork-published prebuilt image (a pure `docker
  pull`, no per-open feature build); **LINUX**: snap-packaged Docker is incompatible with Dev Containers
  (private `/tmp` + unreadable hidden `~/.vscode` build-context → `failed to read dockerfile`), use Docker
  CE not the snap; **WIN**: Docker Desktop's cold 9p/drvfs bind mount can transient-EPERM the first
  `postCreate` `copyFileSync` (`copy_file_range`/reflink) — stage via read+write or a container volume,
  and `docker exec -u node`.

## [0.8.3] — 2026-07-29

Fixes a per-subcommand help footgun surfaced by the WIN plane (defect #7): probing
`<command> --help`/`-h` ran the command instead of printing usage. Both planes should
`dotnet tool update` to `0.8.3` once the tag is cut.

### Fixed

- **`lbabus <command> --help` / `-h` now prints that command's usage and exits 0
  instead of running the command** (defect #7). Previously the flag fell through to
  the dispatcher: `wait --help` started a real blocking wait (up to the default
  timeout), `poll --help` dumped the discussion tail, and `post --help` posted an
  **empty NOTE** to the coordination discussion (a real unintended write, confirmed
  first-hand on the LINUX plane). Help is now intercepted before dispatch for the
  flat commands (`post`, `poll`, `wait`, `defect`, `delta`, `init`,
  `selfcheck`/`doctor`/`preflight`, `capabilities`/`caps`); the ripgrep passthrough
  (`grep`/`rg`/`search`) and the sub-dispatched commands (`net`/`resource`/`agents`/`docs`)
  keep owning their own arg handling. Regression-locked by the
  `linux-post-help-prints-usage-not-posts` harness case.

## [0.8.2] — 2026-07-29

First published release since `0.8.0`; it carries both the `0.8.1` clock-skew fix
(#97) and the `0.8.2` same-second boundary fix (#100). Both planes should
`dotnet tool update` to `0.8.2` once the tag is cut so the timing fixes go live.

### Fixed

- **`wait`/`poll` no longer drop a peer message created in the same wall-clock
  second as the cursor** (#100, #101). GitHub comment `createdAt` timestamps are
  second-precision, so a strict `> since` comparison silently skipped any message
  that landed in the same second as the previous poll boundary. The cursor now
  advances by **comment node identity** instead of a strict second, so same-second
  messages are delivered exactly once. Regression-locked by the
  `linux-wait-same-second-not-dropped` harness case (cross-validated 18/18 on both
  the WIN and LINUX planes).
- **Authoritative server clock + clock-skew surfacing** (#97, merged as `0.8.1`).
  Poll/wait ordering now trusts the GitHub server's `createdAt` as the authoritative
  timestamp rather than the agent-embedded timestamp, and surfaces the skew between
  the two. This fixes a bus timing flaw where a plane's local clock offset (e.g. a
  non-UTC timezone) could make messages appear out of order across planes. Folded
  into this section so the `0.8.2` release notes are self-complete — `0.8.1` was
  never tagged standalone, so `collab-cli-v0.8.2` is the only vehicle for this fix.

## [0.8.1] — 2026-07-28

Merged to `main` but never tagged standalone. Its clock-skew fix (#97) ships to
users as part of the `0.8.2` release above, where the detailed entry is folded in
so the published release notes are self-complete.

## [0.8.0] — 2026-07-28

### Added

- Hosted `ci-reqs` gate enforcing the spec-vs-impl RTM ledger, plus the AGENTS.md
  Delegation & parallelism section (#42).

## [0.7.0] — 2026-07-28

### Added

- Priority + addressing envelope for messages (`--priority`, `--to`) (RFC #34,
  LBA-REQ-013) (#41).

## [0.6.4] — 2026-07-28

### Added

- Spec↔impl gap-closure section + tooling-hygiene items and the ring-1/2
  reqs-coverage check (#38).

## [0.6.3] — 2026-07-28

### Added

- Version-pinned documentation package via `lbabus docs` (RFC #33) (#36).

## [0.6.2] — 2026-07-28

### Changed

- LINUX-plane hardening pass for AGENTS.md (#32).

## [0.6.1] — 2026-07-28

### Changed

- Hardened agent base instructions for cross-plane discipline (#31).

## [0.6.0] — 2026-07-28

### Added

- Version-pinned agent base instructions via `lbabus agents` (#27).

## [0.5.0] — 2026-07-28

### Added

- Resource serializer core with cross-process leases (#18).

## [0.4.0] — 2026-07-27

### Added

- Pinned dependencies (incl. dotnet), grep determinism, API seam, capabilities,
  and the Docker-CI harness (#13).

## [0.3.0] — 2026-07-27

### Added

- Delta polling + `wait` mid-loop version re-check + `poll --full` (#12).

## [0.2.0] — 2026-07-27

### Added

- Agent guardrails: ripgrep-only search, version fail-closed, defect reporting (#9).

## [0.1.0] — 2026-07-27

### Added

- Shared versioned .NET CLI (`lbabus`) for the WIN↔LINUX coordination bus (#6).

[Unreleased]: https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/compare/collab-cli-v0.8.2...HEAD
[0.8.2]: https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/compare/collab-cli-v0.8.0...collab-cli-v0.8.2
[0.8.1]: https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/pull/97
[0.8.0]: https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/compare/collab-cli-v0.7.0...collab-cli-v0.8.0
[0.7.0]: https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/compare/collab-cli-v0.6.4...collab-cli-v0.7.0
[0.6.4]: https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/compare/collab-cli-v0.6.3...collab-cli-v0.6.4
[0.6.3]: https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/compare/collab-cli-v0.6.2...collab-cli-v0.6.3
[0.6.2]: https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/compare/collab-cli-v0.6.1...collab-cli-v0.6.2
[0.6.1]: https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/compare/collab-cli-v0.6.0...collab-cli-v0.6.1
[0.6.0]: https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/compare/collab-cli-v0.5.0...collab-cli-v0.6.0
[0.5.0]: https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/compare/collab-cli-v0.4.0...collab-cli-v0.5.0
[0.4.0]: https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/compare/collab-cli-v0.3.0...collab-cli-v0.4.0
[0.3.0]: https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/compare/collab-cli-v0.2.0...collab-cli-v0.3.0
[0.2.0]: https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/compare/collab-cli-v0.1.0...collab-cli-v0.2.0
[0.1.0]: https://github.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/releases/tag/collab-cli-v0.1.0
