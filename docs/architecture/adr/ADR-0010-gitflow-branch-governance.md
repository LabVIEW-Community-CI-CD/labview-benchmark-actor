# ADR-0010: GitFlow is the branch-governance doctrine

- Status: Accepted
- Date: 2026-07-31
- Deciders: LINUX + WIN planes (operator-directed)
- Relates to: LBA-REQ-016, docs/cm/cm-plan.md, ISO 10007 §5, ISO/IEC/IEEE 12207

## Context

`repo-standards-review` (the authoritative standards lens for this repo) treats **GitFlow** as the universal
branch-governance model and fails the CM gate for repositories whose release automation is not backed by
explicit GitFlow branch governance (the `release-workflow-no-gitflow` contradiction). labview-benchmark-actor
previously operated a `main`-only, feature-branch-to-`main` model, which the lens classifies as
branch-governance non-compliant even though `main` is protected and tags are CI-owned.

The operator has made GitFlow adoption a requirement (LBA-REQ-016). Passing under `repo-standards-review` is
authoritative, so the CM posture must encode GitFlow deterministically while preserving the existing release
security (protected `main`, CI-owned SemVer tag and publish authority).

## Decision

Adopt **GitFlow** as the single accepted branch-governance doctrine for labview-benchmark-actor:

- `main` is the protected production branch; `develop` is the integration branch.
- Feature branches are created from `develop` and merge back into `develop` through a reviewed pull request.
- Release branches are cut from `develop`, then merged into `main` and merged into `develop`; delete the release branch after both merges complete.
- Hotfix branches are created from `main`, then merged into `main` and merged into `develop` (or the active `release/*` branch), and deleted after the required merges complete.
- Releases are SemVer-tagged (`vX.Y.Z`) on `main`; the tag stays CI-owned and is the sole publish authority, so GitFlow does not weaken release security.
- On the tagged release path CI re-runs the full verification suite and retains its coverage evidence, so coverage is retained on every release tag.
- Merge method follows the branch type: a feature branch lands on `develop` as a **squash** merge (one logical commit, linear `develop`), while **release and hotfix branches use `--no-ff` merge commits** into both `main` and `develop` so the mandated dual back-merge preserves shared ancestry (squashing them would diverge `main` and `develop` into different SHAs for identical content). Both merge methods are enabled on the repository.

The governance is recorded canonically in `docs/cm/cm-plan.md` and traced by LBA-REQ-016 in the SRS + RTM.

## Consequences

- The `cm` gate under `repo-standards-review` gains complete GitFlow branch-governance evidence and the
  `release-workflow-no-gitflow` contradiction is resolved.
- Contributors target `develop` for features; `main` only advances through a release (or hotfix) merge, so the
  protected-`main` + CI-owned-tag publish model is unchanged.
- A one-time `develop` branch is created off `main`; the two are identical at adoption and diverge only as
  features land on `develop` ahead of the next release.

## Alternatives considered

- **Keep the `main`-only model.** Rejected: the authoritative lens classifies it as branch-governance
  non-compliant regardless of `main` protection.
- **Trunk-based development.** Rejected: it contradicts the GitFlow doctrine the standards lens requires.
