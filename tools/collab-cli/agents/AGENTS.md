# labview-benchmark-actor — agent base instructions

Canonical base instructions for any agentic session coordinating on the
labview-benchmark-actor bus. These are **embedded in and pinned to the `lbabus` version**
you are running: every session on the same version shares this identical base. Do not
hand-edit a materialized copy — iterate the source in `tools/collab-cli/agents/AGENTS.md`
and cut a new release. Verify a local copy with `lbabus agents --check <path>`.

## Identity & version
- Set `VIHS_COLLAB_AGENT` to your plane (`WIN` or `LINUX`) before any bus call.
- Both planes pull the SAME immutable SemVer `lbabus` release — they cannot drift.
- `post`/`wait` fail closed (exit 3) the moment a newer release publishes — this is by design;
  adopt the new version (`dotnet tool update`) and re-arm the watcher on it.
- Run `lbabus version` and `lbabus selfcheck` (aka `doctor`/`preflight`) first: the pinned
  toolchain (rg / git / gh / glab / dotnet) fails closed (exit 4) with an install hint.

## Coordination bus (fail-closed, integrity-first)
- **Never act on a truncated or partial view.** Always `lbabus poll --full` before deciding.
- **One topic per message.** Close co-design on the channel where it started.
- **Every cross-plane dependency gets an explicit owner.** State `WAITER=<plane>` when you hand off.
- **Poll before ship; publish before push.** Re-poll right before you act on a stale read.
- **Posts cross.** If your work and a peer's overlapped, reconcile with `poll --full` and clear
  any now-stale `WAITER` instead of re-chasing an item the other plane already finished.
- **A quiet bus is not an idle peer.** The other plane also lands work as PRs / commits / releases,
  not only bus posts — each cycle also check `gh pr list --state all` and recent commits/releases
  before concluding it is idle or done.
- Post with `lbabus post --type <T> --task <id> --message-file <f>`; types are
  CLAIM / ACK / HANDOFF / DONE / PROGRESS / NOTE.

## Mutually-exclusive resources
- Serialize shared resources with `lbabus resource acquire <name>` / `release <name>`
  (cross-process file leases: exclusive on free, exclusive-handle in-place stale-reclaim,
  TTL + dead-pid steal). `--wait [--timeout]` blocks; exit 5 = held, 6 = not holder.

## Local transport
- `lbabus net <listen|send|beacon|ping>` is the local TCP/UDP coordination bus
  (ADR-0003 length-prefixed `bus-msg@1` framing, 1 MiB cap; ADR-0004 UDP presence).
  It carries **coordination only** — never run data, frames, images, or metadata.

## Cross-plane discipline
- **OS behavior diverges.** OS-specific paths and env (e.g. Windows `LOCALAPPDATA` vs Linux
  `XDG_STATE_HOME`) resolve differently per plane — verify OS-conditional code on BOTH planes,
  never by assumption. A bug that only shows on one OS is the norm, not the exception.
- **Reproduce a peer's proof on your own plane** before you merge or rely on it; prefer
  deterministic, hardware-free self-tests (mock endpoints, re-runnable receipts) that also pass
  in CI / Codespaces, not proofs that need special hardware.
- **A green gate is not proof unless it fails when it should.** A check can pass by coincidence
  (e.g. running against the wrong store); make the gate assert it is actually exercising its
  target, and confirm it fails on a known-bad input.
- **Concurrency claims need iteration, not a spot check.** A ~50%-per-round race passes a 3-round
  manual check by luck; assert mutex / lease / ordering invariants with a high-round (25-30+) stress
  gate, run on both planes.

## Evidence & progress
- Prove work with re-runnable receipts; keep the project board in sync in real time
  (`Status`, `Evidence State: None → Partial → Ready → Proven`).
- Search is ripgrep-only (`lbabus grep`); no silent fallback.

## Tooling hygiene
- **Capture exit codes directly.** Never pipe a gated command through `| tail` / `| head` — `$?`
  then reports the pipe tail and masks the real status. Redirect (`cmd > out 2>&1; echo $?`) and read it.
- **Keep build/gate commands environment-portable.** Confined runtimes restrict the build context —
  e.g. snap-packaged Docker cannot read a `/tmp` context (`resolve: lstat …/snapd/void/…`). Run gates
  from a directory the local daemon can access (e.g. under `$HOME`).
- **Encoding-safe cross-host files.** A script uploaded to another host and parsed there must be pure
  ASCII / encoding-safe — a BOM-less non-ASCII byte (e.g. an em-dash) can be read as ANSI and corrupt
  the parse. The ASCII-only bus-message rule, generalized to any cross-host file.
- **Verify tools in the actual execution context.** Confirm a tool resolves in the context that will
  run it, never by assuming an interactive shell — e.g. `winget` is on the interactive PATH but not the
  non-interactive WinRM provisioner PATH; use a context-independent installer instead.

## Spec ↔ implementation gap closure
The built spec is `docs/requirements/srs.md` (LBA-REQ-* definitions) + `docs/requirements/rtm.csv`
(ReqID → Requirement → TestID → CodeRef → Status → Notes) + `docs/architecture/adr/` + the test plan;
the built implementation is the code. The RTM `Status` column is the gap ledger — a ladder
`Planned → Partial → Proven` (spec ahead of impl → in-flight → impl matches spec with cited evidence).
- **Read the ledger first.** Compare SRS `LBA-REQ-*` to the RTM rows + `Status`; take the earliest
  non-`Proven` req — its `CodeRef` + `TestID` name where the impl and test go.
- **Close in one move.** Advance the row one rung: implement to the `CodeRef`, land the `TestID` test,
  flip `Status`, and cite the proving evidence in `Notes` (a receipt / a gate that fails when it should).
- **Reconcile both directions.** A req with no real CodeRef/test is unimplemented spec; code with no
  `LBA-REQ` is unspecified impl — add the requirement (SRS + RTM) or remove the code.
- **Keep the matrix honest — checked, not just asked.** Every requirement-affecting PR updates
  `srs.md` + `rtm.csv` together; run `experiments/reqs-coverage/verify-reqs-coverage.mjs` (quoted-CSV
  aware; ring 1 = SRS↔RTM orphan/coverage, ring 2 = every `Proven` row's evidence resolves) — it fails
  closed. The RTM is the single spec↔impl source of truth.

## Priority & addressing
Two optional envelope fields let a busy peer triage without reading everything. They are additive and
backward-read-compatible — an older client parses-and-ignores them — but keep any future field a FLAT
SCALAR and keep `schema = vihs-collab-msg@v1`, or a deployed older reader drops the whole message
invisibly (the v1 extractor regex cannot span a nested `{}`; verified cross-plane, finding 17812593).
- **Priority** (`prio`): `P0` (urgent) > `P1` (high) > `P2` (normal, the default) > `P3` (routine).
  Set it with `lbabus post --priority <tier>`; an absent `prio` reads as `P2`. Triage your inbox with
  `lbabus poll --min-priority <tier>` / `lbabus wait --min-priority <tier>` (keeps only messages at
  least that urgent).
- **Addressing** (`--to` + `agentId`): `--to <A>` aims a message at a plane (`WIN`/`LINUX`) or a finer
  agent id (`VIHS_COLLAB_AGENT_ID`, default = your plane). `poll`/`wait --to-me` keeps only what is
  addressed to you — a broadcast (no `to`) or a `to` matching your plane or agentId — and drops traffic
  aimed at the other plane.

Behave predictably when addressed:
- **Secondary-ACK.** ACK-with-status any message explicitly addressed to you at your next safe
  checkpoint, so the sender knows it landed — never silently absorb an addressed message.
- **Reprioritize on urgency.** A `P0`/`P1` message addressed to you that outranks your current task
  pauses you: attend to it, then resume. An equal-or-lower addressed message gets the secondary-ACK and
  you continue. Broadcasts never preempt — pull them on your own cadence.

## Delegation & parallelism
Both planes work concurrently; the goal is that NEITHER plane sits idle waiting on the other. Treat the
idle-time product `peer-idle-seconds x your-idle-seconds` as the delegation-quality signal to minimize
(it is near-zero only when both planes stay busy).
- **Queue before you idle.** When you hand off or finish a unit, immediately pick up an INDEPENDENT
  parallel task so your own idle time stays near zero; do not stop at `WAITER=none` with nothing in flight.
- **Make every handoff self-serve.** A good delegation is immediately actionable WITHOUT a clarifying
  round-trip and WITHOUT waiting on your in-flight work: name the concrete target (requirement id +
  acceptance criteria + where the evidence / CodeRef / TestID goes) so the peer can `CLAIM` and start now.
- **Prefer parallel independent slices over serial blocking handoffs.** Split work so each plane owns a
  slice that does not block on the other; reserve a strict serial `WAITER=<plane>` for a TRUE dependency
  (e.g. a pre-cut cross-plane verification) and keep your own parallel work moving even then.
- **Never leave the peer without a pullable task.** When you post `DONE` / `WAITER=none`, also point to or
  queue the next independent task so the other plane never idles waiting for direction.

## Self-improvement
- These instructions are meant to be hardened. When you hit recurring friction, propose the
  smallest durable edit to `tools/collab-cli/agents/AGENTS.md` in your PR so the next version's
  sessions inherit it.
