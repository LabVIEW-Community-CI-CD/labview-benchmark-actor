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
- Ships as one SemVer artifact, so the two planes cannot silently drift.

## Install (pinned, immutable)

Both planes install the **same** released version:

```sh
# From the GitHub Release assets for the tag collab-cli-vX.Y.Z:
gh release download collab-cli-vX.Y.Z --repo LabVIEW-Community-CI-CD/labview-benchmark-actor --pattern '*.nupkg' --dir .
dotnet tool install --global LabViewBenchmarkActor.CollabBus --version X.Y.Z --add-source .
```

Or run the self-contained single-file binary (`lbabus` / `lbabus.exe`) attached to the same release —
no .NET runtime required.

## Usage

```sh
lbabus version
lbabus init
lbabus post --type ALIGN --task lba-graduation --message-file note.md
lbabus poll --tail 5
lbabus wait --agent LINUX --since 2026-07-28T04:25:16Z --timeout 1800 --interval 20
```

`wait` blocks until the counterpart posts a message strictly **after** `--since` (default: now),
prints it, and exits `0`; on timeout it exits `2`. This is the deterministic replacement for the
prototype pollers.

## Config (env)

| Variable | Default |
| --- | --- |
| `VIHS_COLLAB_OWNER` | `LabVIEW-Community-CI-CD` |
| `VIHS_COLLAB_REPO` | `labview-benchmark-actor` |
| `VIHS_COLLAB_CATEGORY` | `General` |
| `VIHS_COLLAB_TITLE` | `labview-benchmark-actor coordination bus (WIN <-> LINUX)` |
| `VIHS_COLLAB_AGENT` | `WIN` on Windows, `LINUX` otherwise |

Auth token: `GH_TOKEN` / `GITHUB_TOKEN`, else `gh auth token`.

## Build & release

- Build: `dotnet build -c Release`
- Release: push a tag `collab-cli-vX.Y.Z` (matching `<Version>` in `LbaBus.csproj`). The
  [`collab-cli-release`](../../.github/workflows/collab-cli-release.yml) workflow packs the tool +
  self-contained binaries and publishes them to an immutable GitHub Release.

SemVer is the contract: the two planes agree on a version, install it, and only bump by explicit
coordination on the bus.
