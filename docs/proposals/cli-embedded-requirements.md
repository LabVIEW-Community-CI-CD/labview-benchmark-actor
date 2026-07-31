# Spec: Requirements built into the CLI (`lbabus docs` bundle)

Status: IMPLEMENTED (feature branch, for operator + WIN review) · Author: LINUX plane · Date: 2026-07-31
· Task: cli-embedded-requirements
Builds on: the `lbabus agents` / `lbabus docs` embedded-resource pattern and the `ci-agents` / `ci-docs`
embed gates. Extends LBA-REQ-008 (documentation package). Companion to the `ci-reqs` coverage gate
(`experiments/reqs-coverage/verify-reqs-coverage.mjs`).

> **Motivation (operator).** *"Build the documentation (SRS, etc.) into the CLI so they are considered
> source and iterated, and add a subcommand that can be called on demand to read the requirements
> AGENTS.md can iterate on, so the documentation is aligned with the build."*

## 1. Purpose

Make the repo's **requirements first-class source that ships inside the binary**: embed the software
requirements spec (SRS) and traceability matrix (RTM) in `lbabus` — pinned to the version, like the
agent base instructions and the documentation guide already are — and surface them **on demand** so any
agent (following `AGENTS.md`) reads the exact requirements THIS build was cut from, not a drifting
on-disk copy. This closes the last "docs vs. build" drift gap: the requirements travel with, and are
gated against, the binary.

This executes the growth path the documentation package already names for itself: `DOCS.md` lists
*"requirements (SRS) + traceability (RTM)"* as the next information items to fold in, and *"split into a
bundle when it outgrows one page."*

## 2. The gap it fills

| Surface | Before | After |
| --- | --- | --- |
| Agent base instructions | embedded + `lbabus agents` + `ci-agents` gate | unchanged |
| Documentation guide | embedded (`DOCS.md`) + `lbabus docs` + `ci-docs` gate | unchanged (now the `guide` doc) |
| **Requirements (SRS)** | on disk only (`docs/requirements/srs.md`); read by `ci-reqs` coverage | **embedded + `lbabus docs show srs` + `ci-docs` round-trip** |
| **Traceability (RTM)** | on disk only (`docs/requirements/rtm.csv`) | **embedded + `lbabus docs show rtm` + `ci-docs` round-trip** |

The existing `ci-reqs` gate proves the RTM is *honest* (SRS↔RTM coverage; every `Proven` row's evidence
resolves). This proposal is complementary: it proves the requirements the CLI *carries* match the repo,
and makes them readable at runtime.

## 3. Design

### 3.1 Embed BY REFERENCE (single source of truth)

The CLI embeds the **canonical** repo files, not copies:

```xml
<EmbeddedResource Include="../../docs/requirements/srs.md">
  <LogicalName>docs.requirements.srs.md</LogicalName>
</EmbeddedResource>
<EmbeddedResource Include="../../docs/requirements/rtm.csv">
  <LogicalName>docs.requirements.rtm.csv</LogicalName>
</EmbeddedResource>
```

There is no second copy to drift — the build compiles in `docs/requirements/*` directly. The repo-root
`.dockerignore` deliberately keeps `docs/` in the build context, so the reference resolves in CI. Explicit
`LogicalName` gives a stable manifest resource name (default globbing would mangle the `../..` path).

### 3.2 Command surface (`lbabus docs` becomes a keyed bundle)

| Command | Behavior |
| --- | --- |
| `lbabus docs` | print the `guide` (default) — **byte-for-byte back-compat** |
| `lbabus docs list` | list embedded docs: id, kind, sha256, bytes, source |
| `lbabus docs show <id>` | print a doc: `guide`, `srs`, or `rtm` |
| `lbabus docs [show] <id> --out <path>` | materialize a doc to a file |
| `lbabus docs [show] <id> --check <path>` | drift-check a file against the embedded canonical (exit 3 on drift) |

Markdown docs (`guide`, `srs`) carry the `<!-- lbabus-docs … -->` provenance stamp; the RTM csv is emitted
**raw** so it stays valid for its own tooling (a csv cannot hold an HTML comment). Bare `docs --out` /
`docs --check` still operate on the guide, so the existing `ci-docs` gate is unchanged.

### 3.3 Alignment with the build (the guarantee)

- **Embed round-trip** (`ci-docs`, extended): for each of `guide`, `srs`, `rtm` — `docs show <id> --out`
  then `--check` (exit 0), and a tampered copy fails (exit 3). Wired in the Dockerfile `ci-docs` stage,
  `verify-linux.sh`, and `verify-windows.ps1`.
- **Repo-canonical alignment**: `lbabus docs show srs --check docs/requirements/srs.md` (exit 3 on drift)
  confirms a checkout matches the embedded canonical — the on-demand check an agent/dev runs.
- **Static wiring guard** (`verify-local-gates`, dep-free): a new check asserts the csproj embeds both
  requirement docs by reference and the `Docs.cs` registry keys them, so the embed cannot silently regress.

Together: **same `lbabus` version ⇒ same requirements**, and the documentation cannot drift from the build.

### 3.4 AGENTS.md iteration loop

`tools/collab-cli/agents/AGENTS.md` (the version-pinned, embedded base) gains a bullet in *Spec ↔
implementation gap closure*: read the requirements the build carries with `lbabus docs list` /
`docs show srs` / `docs show rtm`; iterate them by editing `docs/requirements/*`, rebuild, re-read. The
requirements an agent reasons from are always the ones the running binary embeds.

## 4. Back-compat & safety

- **Additive.** No existing `lbabus docs` invocation changes: bare `docs`, `docs --out`, `docs --check`
  all still target the guide, byte-for-byte.
- **Fail-closed.** An unknown doc id exits 2; a missing embedded resource throws at load.
- **No new dependency.** The RTM csv is emitted raw; no CSV parser is added (the coverage gate keeps its
  own dep-free parser).

## 5. Release plan

Ships as a **feature PR to `main`** (version-independent, like `net send --stream` did). The **release**
(`collab-cli-v0.14.0`: version bump + `release-agreement.json` bidirectional sign-off + tag) is cut
**after** `collab-cli-v0.13.0` is published, per the operator's sequencing ("after release 0.13.0"). No
version bump is part of this feature branch.

## 6. Acceptance

- `lbabus docs list` shows `guide`, `srs`, `rtm`.
- `lbabus docs show srs` / `show rtm` emit the canonical requirements; `--check` round-trips (exit 0) and
  detects drift (exit 3).
- `lbabus docs show srs --check docs/requirements/srs.md` passes on a clean checkout.
- `ci-docs` (Docker + `verify-linux.sh` + `verify-windows.ps1`) round-trips all three docs.
- `verify-local-gates` asserts the embed wiring; `npm test` stays green.
