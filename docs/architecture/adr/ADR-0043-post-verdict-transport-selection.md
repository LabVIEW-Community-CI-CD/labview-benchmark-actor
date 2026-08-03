# ADR-0043: post-verdict.mjs transport selection — off-Discussions step 4

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator directive (the live-only net model) + agent
- Relates to: LBA-REQ-063, ADR-0042 (MCP transport selection), ADR-0041 (extension transport selection), ADR-0040 (live-only net coordination), ADR-0039 (semantic net verdict types), ADR-0038 (reviewer verdict bus announcement — the Discussion path), reviewer-workstation/post-verdict.mjs, .github/workflows/extension-release.yml

## Context

ADR-0041/0042 migrated the extension + its MCP tools to a selectable transport. The reviewer verdict
announcement is ALSO reachable via `reviewer-workstation/post-verdict.mjs` (the release CI calls it
`--print-args`, and a reviewer can run it by hand). It still built only the GitHub-Discussion `post` argv.
Step 4 makes it transport-selectable too.

## Decision

- **`post-verdict.mjs` selects the transport** from `VIHS_COLLAB_TRANSPORT` (discussion default | net) +
  `VIHS_COLLAB_NET_HOSTS`: under `net` it emits `net send --hosts <peers> --type <RESOLVED/…> --task
  <release-task> --message-file <verdict>` (the net envelope has no priority/ref — those live inside the
  signed verdict JSON); else the Discussion `post` argv (unchanged). `--print-args` / `--dry-run` / post all
  honor it.
- **Discussion stays the default, so the release CI is unchanged.** With no env set, `--print-args` emits the
  same `post …` the release workflow already runs — no workflow edit, no behavior change.
- **The release-CI announce under live-only is a SEPARATE decision (deferred).** In CI there is no persistent
  `net` peer, so a net announce there has no listener; and the durable record of the human PASS is already the
  **committed signed verdict** (release-agreement.json's `visualReview`, gated by `verify-visual-review` +
  keyless counter-signed). Whether to drop the CI Discussion announce (vs keep it until the transport is
  removed) is left to a follow-up + the operator, since it touches the publish workflow.

This is requirement **LBA-REQ-063**.

## Consequences

- **A reviewer can announce a verdict over TCP.** e.g. the reviewer VM runs `post-verdict.mjs` with
  `VIHS_COLLAB_TRANSPORT=net` + `VIHS_COLLAB_NET_HOSTS=10.0.2.2` to `net send` the signed verdict to the host —
  the scripted form of the live drive already proven (ADR-0039).
- **The release workflow is untouched** (Discussion default); its off-Discussions change is a deliberate,
  operator-gated follow-up.
- **Deferred:** the release-CI announce decision, then deprecating + removing the Discussion transport
  (`Program.cs` post/poll/wait/init + `GitHubGraphQL.cs`) + the CI mock GraphQL harness.
