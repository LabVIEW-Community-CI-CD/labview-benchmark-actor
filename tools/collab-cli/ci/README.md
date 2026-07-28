# lbabus Docker-CI edge-case harness

A declarative, dependency-free harness that runs the `lbabus` CLI through edge cases in a hermetic
container and **gates every `collab-cli-v*` release** on the result. It grows over time; **both planes
add cases** (one file per case, so nobody edits a shared manifest and there are no merge conflicts).

## Layout

| Path | Purpose |
|------|---------|
| `LbaBus.Ci/` | Dependency-free .NET runner (`lbabus-ci`). Reads `cases/*.json`, runs `lbabus` once per case, writes `results/<name>.json`, exits non-zero if any case fails. No NuGet packages, no bash. |
| `cases/*.json` | One declarative case per file (args + env + expected exit/stdout/stderr). |
| `fixtures/` | Stable input corpus for offline cases (e.g. `sample.txt` for grep). |
| `Dockerfile` | Multi-stage: `build` → `ci-rg` (ripgrep present) and `ci-no-rg` (ripgrep absent). The harness runs *inside* the build, so a failing case fails the image. |
| `results/` | Per-run output (git-ignored). |

## Run it

```sh
# local (from the repo root), against a Release build of lbabus:
dotnet build -c Release tools/collab-cli/LbaBus.csproj
dotnet build -c Release tools/collab-cli/ci/LbaBus.Ci/LbaBus.Ci.csproj
dotnet tools/collab-cli/ci/LbaBus.Ci/bin/Release/net8.0/lbabus-ci.dll \
  --repo-root "$PWD" --lbabus tools/collab-cli/bin/Release/net8.0/lbabus.dll

# hermetic (both runtime stages):
docker build -f tools/collab-cli/ci/Dockerfile --target ci-rg    .
docker build -f tools/collab-cli/ci/Dockerfile --target ci-no-rg .
```

The runner is **hermetic**: it strips ambient `LBABUS_*` / `VIHS_*` / `GH_TOKEN` / `GITHUB_TOKEN` from
each child so a stray host variable (e.g. a leaked `LBABUS_SKIP_VERSION_CHECK`) cannot contaminate a case.

## Case schema

```jsonc
{
  "name": "unique-case-name",          // → results/<name>.json
  "owner": "WIN" | "LINUX",            // who maintains it
  "description": "what this proves",
  "requiresMock": false,               // true → skipped unless LBABUS_GITHUB_API is set
  "requiresRipgrep": false,            // true → skipped when rg is absent (the ci-no-rg stage)
  "requiresNoRipgrep": false,          // true → skipped when rg is present (runs only in ci-no-rg)
  "env": { "KEY": "VALUE" },           // per-case env; applied last (wins)
  "args": ["grep", "-H", "pattern"],   // lbabus argv
  "cwd": "tools/collab-cli",           // relative to --repo-root (optional)
  "expect": {
    "exitCode": 0,
    "stdoutContains": ["substr"],
    "stdoutNotContains": ["\u001b["],  // e.g. no ANSI escapes
    "stderrContains": ["substr"],
    "stdoutEquals": "exact (CRLF-normalized)"
  }
}
```

For mock-requiring cases the runner injects `LBABUS_GITHUB_API=<endpoint>` automatically; the case just
declares the fixture repo it targets via `VIHS_COLLAB_OWNER` / `VIHS_COLLAB_REPO`.

## Ownership split (converged on #10)

- **WIN** — the CLI seam (`LBABUS_GITHUB_API`, lands first), grep non-TTY determinism, the version-gate
  and defect cases, the runner skeleton, the multi-stage Dockerfile, and the release-pipeline wiring.
- **LINUX** — the in-container GitHub **mock**, the offline-logic corpus, and the TTY / CRLF / unicode
  cases. The mock speaks the surface below and is launched in the container before the runner, exporting
  `LBABUS_GITHUB_API` so the mock-requiring cases run.

## Mock contract (`LBABUS_GITHUB_API`)

`lbabus` sends **every** GitHub call to `LBABUS_GITHUB_API` as its base URL. There are exactly two
surfaces — this answers the REST-vs-GraphQL question directly:

- **GraphQL** (discussions) — `POST {base}/graphql`
  - `ResolveContext` → `repository { id, discussionCategories(first:30){ nodes{ id name } } }`
  - `FindDiscussion` → `repository { discussions(first:50, orderBy:{field:CREATED_AT,direction:DESC}) { nodes{ number title id url } } }`
  - `ListComments` → `repository { discussion(number:$n) { comments(last:$k){ nodes{ createdAt body author{ login } } } } }`
  - `CreateDiscussion` (mutation) → `createDiscussion(input:{repositoryId,categoryId,title,body}){ discussion{ number url id } }`
  - `AddComment` (mutation) → `addDiscussionComment(input:{discussionId,body}){ comment{ url } }`
- **REST** — `{base}/repos/{owner}/{repo}/...` *(these two are REST, NOT GraphQL)*
  - `GET  {base}/repos/{owner}/{repo}/releases?per_page=100` → `[{ "tag_name": "collab-cli-vX.Y.Z" }, ...]` (drives the version-currency guard)
  - `POST {base}/repos/{owner}/{repo}/issues/{n}/comments` (body `{ "body": "..." }`) → `{ "html_url": "..." }` (the defect sink)

When `LBABUS_GITHUB_API` is set but unreachable, a version-gated command (`post`/`wait`) **fails closed
(exit 3)** rather than falling back to the real api.github.com.

### Fixture routing

The mock is a pure function of the request path/vars — route by `{owner}/{repo}`:

| Fixture repo | Serves | Exercises |
|--------------|--------|-----------|
| `lbabus-ci/fixture-stale` | `releases` with a `tag_name` far ahead of the build (e.g. `collab-cli-v99.0.0`) | `version-guard-stale-fails-closed` → exit 3 (STALE) |
| `lbabus-ci/fixture-current` | `releases` with `collab-cli-v<current>` **and** a discussion with no matching LINUX comments | `version-guard-current-proceeds` → exit 2 (timeout, not stale) |
| `lbabus-ci/fixture-defect` | accepts the issue-#7 comment POST, returns `{ html_url }` | `defect-posts-to-issue` → exit 0 |

`GH_TOKEN` is a dummy in these cases — the mock must not validate it.
