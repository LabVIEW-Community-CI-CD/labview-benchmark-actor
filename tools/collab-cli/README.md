# lbabus — shared cross-plane coordination bus CLI

`lbabus` is the **single, versioned, cross-platform** coordination-bus client used by both the
**WIN** and **LINUX** planes of the labview-benchmark-actor collaboration. It replaces the earlier
divergent prototype scripts (`collab.mjs` + `poll-lin.ps1` / `poll-lin.sh`) with one .NET 8 binary and
one deterministic protocol, so both planes run **identical bytes** pulled from an **immutable SemVer
release**.

## Why

The prototype had two divergent, unversioned pollers (PowerShell vs. bash) plus a Node poster. That
made "who watches vs. who acts" ambiguous and dropped messages. `lbabus`:

- Talks to the GitHub GraphQL API **in-process** (no `gh api` shell-out, no pager) — identical on
  Windows and Linux.
- Gates `wait`/`poll` on the **server comment timestamp** AND the parsed `vihs-collab-msg@v1` `agent`
  field. Both agents post as the same GitHub user, so author-based gating was never reliable; the
  embedded `agent` is authoritative.
- Uses the GitHub **server `createdAt` as the single authoritative clock** for every timing decision
  (ordering, `--since`, `delta`, staleness). The message's embedded `ts` is the *sender's local wall
  clock* and is ADVISORY ONLY — when it diverges from the server time beyond normal post latency,
  `poll` surfaces a `[clock-skew: …]` note so a drifting peer clock can never make a reply look much
  earlier or later than it actually arrived.
- Ships as one SemVer artifact, so the two planes cannot silently drift.

## Install (pinned, immutable)

Both planes install the **same** released version:

```sh
# From the GitHub Release assets for the tag collab-cli-vX.Y.Z:
gh release download collab-cli-vX.Y.Z --repo LabVIEW-Community-CI-CD/labview-benchmark-actor --pattern '*.nupkg' --dir .
dotnet tool install --global LabViewBenchmarkActor.CollabBus --version X.Y.Z --add-source .
```

> **Upgrading:** the nupkg ships as a GitHub Release asset (it is **not** published to nuget.org), so a
> plain `dotnet tool update` from the default feed will **not** find a new version. Always `--add-source`
> the downloaded release nupkg (use `dotnet tool update` in place of `install`, or `dotnet tool uninstall`
> then install as above).

Or run the self-contained single-file binary (`lbabus` / `lbabus.exe`) attached to the same release —
no .NET runtime required.

## Usage

```sh
lbabus version
lbabus net listen --log ./bus.jsonl &                                  # receive-log for `net poll`
lbabus net send --hosts 10.0.2.2 --type NOTE --message-file note.md    # announce to the peer host(s)
lbabus net poll --log ./bus.jsonl --tail 5                             # read the local receive-log
lbabus selfcheck                                                       # pinned deps + version currency
lbabus agents --out ./AGENTS.md   # materialize the version-pinned agent base instructions
```

Coordination is **live-only over TCP** (`lbabus net`, ADR-0040/0047): `net send` announces to the configured
peer host(s) (a graceful no-op with none), and `net poll` reads this actor's local receive-log written by
`net listen --log`. The former GitHub-Discussion transport (`init`/`post`/`poll`/`wait`) was **removed**
(ADR-0047); coordination is net-only. There is no async inbox — an offline peer misses a live send.

`agents` emits the agent base instructions **embedded in this lbabus version**, so every session on
the same version shares byte-identical guidance. `--out <path>` writes them to a known location;
`--check <path>` fails (exit `3`) if a local copy has drifted. Iterate the source in
`agents/AGENTS.md` and cut a new release to harden them.

## Agent guardrails (fail-closed)

`lbabus` enforces an agent operating contract so both planes behave identically. Each guardrail fails
closed rather than silently degrading:

```sh
lbabus selfcheck                 # aka doctor/preflight: ripgrep present AND version current
lbabus grep "pattern" src         # aka rg/search: ripgrep-only passthrough, no grep/findstr fallback
lbabus defect --message "..."      # report a tooling defect to the dedicated log issue
```

1. **Ripgrep-only search.** `lbabus grep` shells to `rg` and exits `4` with an OS-specific install
   hint when ripgrep is absent — there is no grep/findstr/Select-String fallback (that divergence is
   the same class of defect as the old pollers).
2. **Version currency.** `post` and `wait` query the latest published `collab-cli-v*` release and
   **refuse to run** (exit `3`) when the local build is stale, printing the exact local-rebuild
   recipe. Bypass for offline/dev with `LBABUS_SKIP_VERSION_CHECK=1`. `selfcheck` reports the same.
3. **Defect reporting.** `lbabus defect` appends a plane-tagged report to the single tooling
   defect-log issue (`LBABUS_DEFECT_ISSUE`, default `#7`); the top-level error handler points agents
   at it. This keeps every tooling defect in one durable place instead of scattered inline.

## Response deltas (symmetric)

`lbabus delta` measures cross-plane response cadence from the bus timestamps, so **both planes measure
the counterpart identically** (WIN measures LINUX; LINUX measures WIN) using the same command and the
same canonical server `createdAt` clock — no hand math, no clock-skew disputes.

```sh
lbabus delta                     # counterpart's response deltas (WIN -> LINUX, LINUX -> WIN)
lbabus delta --agent WIN --tail 5
```

With no `--agent`, `delta` measures the **counterpart of `VIHS_COLLAB_AGENT`** (WIN measures LINUX, LINUX measures WIN). Pass `--agent <A>` to measure a specific agent (including yourself).

For each message from the target agent it prints:
- **gap** = time since that agent's *previous* message (their cadence).
- **latency** = time since the *most recent counterpart message before it* (the trigger it responded to).

## Config (env)

| Variable | Default |
| --- | --- |
| `VIHS_COLLAB_OWNER` | `LabVIEW-Community-CI-CD` |
| `VIHS_COLLAB_REPO` | `labview-benchmark-actor` |
| `VIHS_COLLAB_CATEGORY` | `General` |
| `VIHS_COLLAB_TITLE` | `labview-benchmark-actor coordination bus (WIN <-> LINUX)` |
| `VIHS_COLLAB_AGENT` | `WIN` on Windows, `LINUX` otherwise |
| `LBABUS_DEFECT_ISSUE` | `7` |
| `LBABUS_SKIP_VERSION_CHECK` | _(unset)_ — set to bypass the version guard |

Auth token: `GH_TOKEN` / `GITHUB_TOKEN`, else `gh auth token`.

## Build & release

- Build: `dotnet build -c Release`
- Release: push a tag `collab-cli-vX.Y.Z` (matching `<Version>` in `LbaBus.csproj`). The
  [`collab-cli-release`](../../.github/workflows/collab-cli-release.yml) workflow packs the tool +
  self-contained binaries and publishes them to an immutable GitHub Release.

SemVer is the contract: the two planes agree on a version, install it, and only bump by explicit
coordination on the bus.
