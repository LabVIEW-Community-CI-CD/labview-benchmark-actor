# ADR-0047: Remove the GitHub-Discussion transport from the lbabus CLI — off-Discussions step 8 (final)

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator directive (off GitHub Discussions) + agent
- Relates to: LBA-REQ-067, ADR-0046 (product net-only, step 7), ADR-0003 (bus wire format — `net` is the transport), ADR-0040 (live-only net), ADR-0039 (proven live net loop); COMPLETES the off-Discussions migration (steps 1–8). Keeps the GitHub REST bits for `selfcheck`/`defect`.

## Context

Step 7 (ADR-0046) made the coordination product surface net-only, leaving the CLI's own Discussion commands
(`init`/`post`/`poll`/`wait`/`delta`) dead — reachable by nothing in the product. This final step removes them
and the GraphQL Discussion client, completing the teardown.

`GitHubGraphQL.cs` was shared beyond the transport: `selfcheck` reads the repo's release tags (REST) for its
version-currency guard, and `lbabus defect` appends a comment to the tooling-defect issue (REST). Those two
GitHub-API keepers stay; only the GraphQL Discussion surface goes.

## Decision

- **`Program.cs`** — remove `init`/`post`/`poll`/`wait`/`delta` (dispatch + the `Cmd*` methods + the help/usage
  entries), plus the now-orphaned discussion helpers: the `EnforceVersionOrNull` version-guard (it gated only
  `post`/`wait`) and `ParseAll`/`SeedBody`/`Eq`/`Dur`. Keep `version`/`capabilities`/`selfcheck`/`grep`/`defect`
  /`net`/`resource`/`agents`/`docs`.
- **`GitHubGraphQL.cs`** — reduce to a **REST-only** client: drop the `DiscussionRef`/`DiscussionComment`
  records and `Query`/`ResolveContext`/`FindDiscussion`/`CreateDiscussion`/`EnsureDiscussion`/`ListComments`/
  `AddComment`; keep `ListReleaseTags` (selfcheck) + `AddIssueComment` (defect).
- **`Config.cs`** — drop the discussion-only fields (`Category`/`Title`/`AgentId`/`Counterpart`/`AddressesMe`
  + their env reads); keep `Owner`/`Repo`/`Agent`.
- **ci harness** — retire the 12 discussion / version-guard cases (`cases/*.json` is globbed, so the grep +
  defect + runner-meta cases are unaffected). The build + a CLI smoke test verify the removal.
- The live-only `lbabus net` TCP bus (ADR-0003/0040) is the **sole** coordination transport.
- This is requirement **LBA-REQ-067**.

## Consequences

- **`lbabus` is coordination-net-only** plus two GitHub-REST touchpoints (the `selfcheck` release-currency
  lookup + the `defect` issue sink). No GraphQL, no GitHub Discussions. **The off-Discussions migration
  (steps 1–8) is COMPLETE.**
- **Deferred doc/cleanup follow-up (step 8b)** — none of it blocks a gate: sweep the stale prose that still
  shows `lbabus post/poll/wait` (`tools/collab-cli/README.md` + `agents/AGENTS.md`, `ci/README.md`,
  `docs/mcp-tools.md`, `docs/testing/reviewer-manual-test-plan.md`, root `README.md`); trim the ci mock's now
  -vestigial GraphQL/release handlers + fixtures; and retire `experiments/ollama-bus/bus-agent.mjs` (it still
  shells the removed `post`/`poll`). Any remaining now-unused compiled types (e.g. the discussion message model)
  are removed in that same follow-up.
- **Gated** by `cli-no-discussion-transport` (source-asserts the removal + that the net transport + the REST
  keepers remain).
