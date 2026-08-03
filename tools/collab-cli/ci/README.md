# lbabus Docker-CI edge-case harness

A declarative, dependency-free harness that runs the `lbabus` CLI through edge cases in a hermetic
container and **gates every `collab-cli-v*` release** on the result. It grows over time; **both planes
add cases** (one file per case, so nobody edits a shared manifest and there are no merge conflicts).

## Layout

| Path | Purpose |
|------|---------|
| `LbaBus.Ci/` | Dependency-free .NET runner (`lbabus-ci`). Reads `cases/*.json`, runs `lbabus` once per case, writes `results/<name>.json`, exits non-zero if any case fails. No NuGet packages, no bash. |
| `LbaBus.Ci.Mock/` | Dependency-free in-container GitHub mock (`lbabus-mock`, `System.Net.HttpListener`). Its `run-harness` mode starts the loopback endpoint, exports `LBABUS_GITHUB_API`, runs the runner, and exits with its code — flipping the mock-requiring cases from SKIP to RUN. No NuGet packages, no bash. |
| `LbaBus.Ci.Stress/` | Dependency-free cross-plane concurrency **regression gate** (`lbabus-stress`). A pre-flight **isolation** check first asserts the store lbabus actually uses is the harness scratch dir (via the `resource list` header path); if the store env var is being ignored it fails loud (exit 3) instead of letting a broken run pass by luck. Then spawns N concurrent `lbabus resource` processes and asserts the cross-process lease invariants (mutual exclusion on free + stale, TTL/pid steal, idempotent release, wait). Catches the PR #18 mutex race a low-round manual check passes by luck; runs on Windows + Linux. |
| `cases/*.json` | One declarative case per file (args + env + expected exit/stdout/stderr). |
| `fixtures/` | Stable input corpus for offline cases (e.g. `sample.txt` + `sample2.txt` for grep). |
| `Dockerfile` | Multi-stage: `build` → `ci-rg`/`ci-no-rg` (ripgrep present/absent), `ci-stress` (concurrency gate), `ci-musl`/`ci-musl-native` (glibc/musl RID). The harness runs *inside* the build, so a failing case fails the image. |
| `results/` | Per-run output (git-ignored). |

## Run it

```sh
# local (from the repo root), against a Release build of lbabus:
dotnet build -c Release tools/collab-cli/LbaBus.csproj
dotnet build -c Release tools/collab-cli/ci/LbaBus.Ci/LbaBus.Ci.csproj
dotnet tools/collab-cli/ci/LbaBus.Ci/bin/Release/net8.0/lbabus-ci.dll \
  --repo-root "$PWD" --lbabus tools/collab-cli/bin/Release/net8.0/lbabus.dll

# ...or with the in-container mock wired (flips the defect-* cases from SKIP to RUN):
dotnet build -c Release tools/collab-cli/ci/LbaBus.Ci.Mock/LbaBus.Ci.Mock.csproj
dotnet tools/collab-cli/ci/LbaBus.Ci.Mock/bin/Release/net8.0/lbabus-mock.dll run-harness --port 8099 \
  --repo-root "$PWD" --lbabus tools/collab-cli/bin/Release/net8.0/lbabus.dll \
  --runner tools/collab-cli/ci/LbaBus.Ci/bin/Release/net8.0/lbabus-ci.dll

# hermetic (all runtime stages):
docker build -f tools/collab-cli/ci/Dockerfile --target ci-rg     .
docker build -f tools/collab-cli/ci/Dockerfile --target ci-no-rg  .
docker build -f tools/collab-cli/ci/Dockerfile --target ci-stress .
docker build -f tools/collab-cli/ci/Dockerfile --target ci-musl   .
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

> Implemented by `ci/LbaBus.Ci.Mock` (`lbabus-mock`) — a dependency-free `System.Net.HttpListener`
> server, routed as a pure function of the request path.

After the off-Discussions migration (ADR-0047/0048) `lbabus` uses exactly **one** GitHub-API surface, so
the mock serves only it:

- **REST** — `POST {base}/repos/{owner}/{repo}/issues/{n}/comments` (body `{ "body": "..." }`) →
  `{ "html_url": "..." }` (the `lbabus defect` sink). Every other path returns 404.

### Fixture routing

The mock is a pure function of the request path — route by `{owner}/{repo}`:

| Fixture repo | Serves | Exercises |
|--------------|--------|-----------|
| `lbabus-ci/fixture-defect` | accepts the issue-#7 comment POST, returns `{ html_url }` | `defect-posts-to-issue` → exit 0 |

`GH_TOKEN` is a dummy in these cases — the mock must not validate it.
