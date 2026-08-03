# ADR-0044: Drop the release-CI GitHub-Discussion verdict announce — off-Discussions step 5

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator decision (2026-08-03: drop the CI Discussion announce; the committed verdict is the durable record) + agent
- Relates to: LBA-REQ-064, ADR-0043/0042/0041/0040 (off-Discussions steps 1–4), ADR-0038 (reviewer verdict bus announcement — CI path SUPERSEDED here), LBA-REQ-058, ADR-0018 (human sign-off gate), ADR-0016 (keyless attest), .github/workflows/extension-release.yml

## Context

ADR-0038 had the release publish workflow announce the signed reviewer verdict to the `lbabus`
GitHub-Discussion bus (best-effort) so remote actors saw the human PASS. The off-Discussions migration
(ADR-0040..0043) moved coordination onto the live-only `net` bus. But the release CI runs in ephemeral
GitHub Actions with **no persistent `net` peer** — a net announce there has no listener. And the durable
record of the human PASS already exists independently: the **committed signed verdict** in
`release-agreement.json`'s `visualReview`, gated by `verify-visual-review` + keyless counter-signed (Fulcio +
rekor) with the `.vsix`.

## Decision

- **Remove the release-CI Discussion announce step** (+ the .NET setup that supported only it) from
  `extension-release.yml`. The publish pipeline no longer touches a GitHub Discussion.
- **The durable record is the committed signed verdict** — staged for keyless counter-sign + committed in the
  release-agreement (`verify-visual-review` gates the release on it). A remote actor reads the verdict from the
  repo (git), not a Discussion.
- **Live announce stays available off-CI.** A reviewer/actor with a configured peer announces over `net` via
  `post-verdict.mjs` (`VIHS_COLLAB_TRANSPORT=net`, ADR-0043) or the extension (ADR-0041) — the proven live flow
  (ADR-0039).
- **Supersedes the CI-announce portion of ADR-0038 / LBA-REQ-058.** The verdict is still announced by the
  extension + `post-verdict.mjs` (now net-capable); only the CI Discussion announce is removed.

This is requirement **LBA-REQ-064**.

## Consequences

- **The publish pipeline has no GitHub-Discussion dependency.** One step closer to removing the Discussion
  transport entirely — gated so it can't silently return.
- **Remote-actor auto-notification at release time is intentionally dropped** (the live-only tradeoff,
  ADR-0040); the committed verdict + the release itself are the record.
- **Deferred (final):** deprecate + remove the Discussion transport (`Program.cs` post/poll/wait/init +
  `GitHubGraphQL.cs`) + the CI mock GraphQL harness.
