# ADR-0041: Bus transport selection in the extension — Discussion default, net opt-in (off-Discussions step 2)

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator directive (2026-08-03, *"TCP, deprecate the use of github discussions"*; the live-only net model) + agent
- Relates to: LBA-REQ-061, ADR-0040 (live-only net coordination), ADR-0039 (semantic net verdict types), ADR-0038 (reviewer verdict bus announcement — the Discussion path being migrated), LBA-REQ-058, src/extension.ts, tools/collab-cli (lbabus `net`)

## Context

ADR-0040 gave `lbabus net` a live-only coordination model (send via `net send`, read via `net poll` over a
per-actor receive-log). The extension still shells the **GitHub-Discussion** transport for its coordination
commands — `pollBus` (`lbabus poll`), `postNote` (`lbabus post`), and the reviewer-verdict announcement
(`postVerdictToBus` → `busPostArgs` → `lbabus post`). Step 2 of the off-Discussions migration is to let the
extension **select** the transport, without breaking existing users who rely on the Discussion.

## Decision

Add a **transport selector** to the extension, defaulting to **Discussion** (net is **opt-in** during the
transition).

- **Config.** `labviewBenchmarkActor.busTransport` = `discussion` (default) | `net`; `busNetHosts` (CSV peer
  host(s) for `net send`); `busNetLog` (local receive-log path for `net poll`).
- **`net` branch.** `postNote` → `net send --hosts <hosts> --type NOTE --message …`; `pollBus` → `net poll
  --log <log> --tail 10`; the verdict announcement → `busSendArgs` (`net send --type <RESOLVED/…> --task
  <release-task> --message-file <verdict>`), reusing the semantic net types (ADR-0039). The net envelope has
  no priority/ref (those live inside the verdict JSON).
- **Discussion default keeps behavior stable.** With `busTransport` unset, the extension shells the same
  `lbabus post`/`poll` as before — no user-facing change, no test churn; the existing remediation-on-ENOENT +
  `busPostArgs` tests still hold. `busSendArgs` + the net branches are new unit-covered surface.
- **Best-effort preserved.** The verdict announcement stays best-effort (a missing `lbabus` / peer is logged,
  never thrown into signing).

This is requirement **LBA-REQ-061**.

## Consequences

- **The extension can coordinate over TCP.** A reviewer VM (or any actor) can set `busTransport=net` +
  `busNetHosts=10.0.2.2` to post notes + announce verdicts over the live bus and read the local receive-log —
  no github.com dependency.
- **Migration stays safe + incremental.** Discussion remains the default until the net path is proven in the
  field; a later increment flips the default, then deprecates/removes the Discussion transport.
- **Deferred:** the MCP tools (`poll_coordination_bus` / `post_coordination_note`) still shell `lbabus poll`/
  `post`; migrating them (via env-passed transport config) + `post-verdict.mjs` + the release CI are the next
  increments, then the Discussion transport + the CI mock GraphQL harness are removed.
