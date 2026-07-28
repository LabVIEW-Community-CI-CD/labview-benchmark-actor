# labview-benchmark-actor — agent base instructions

Canonical base instructions for any agentic session coordinating on the
labview-benchmark-actor bus. These are **embedded in and pinned to the `lbabus` version**
you are running: every session on the same version shares this identical base. Do not
hand-edit a materialized copy — iterate the source in `tools/collab-cli/agents/AGENTS.md`
and cut a new release. Verify a local copy with `lbabus agents --check <path>`.

## Identity & version
- Set `VIHS_COLLAB_AGENT` to your plane (`WIN` or `LINUX`) before any bus call.
- Both planes pull the SAME immutable SemVer `lbabus` release — they cannot drift.
- Run `lbabus version` and `lbabus selfcheck` (aka `doctor`/`preflight`) first: the pinned
  toolchain (rg / git / gh / glab / dotnet) fails closed (exit 4) with an install hint.

## Coordination bus (fail-closed, integrity-first)
- **Never act on a truncated or partial view.** Always `lbabus poll --full` before deciding.
- **One topic per message.** Close co-design on the channel where it started.
- **Every cross-plane dependency gets an explicit owner.** State `WAITER=<plane>` when you hand off.
- **Poll before ship; publish before push.** Re-poll right before you act on a stale read.
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

## Evidence & progress
- Prove work with re-runnable receipts; keep the project board in sync in real time
  (`Status`, `Evidence State: None → Partial → Ready → Proven`).
- Search is ripgrep-only (`lbabus grep`); no silent fallback.

## Self-improvement
- These instructions are meant to be hardened. When you hit recurring friction, propose the
  smallest durable edit to `tools/collab-cli/agents/AGENTS.md` in your PR so the next version's
  sessions inherit it.
