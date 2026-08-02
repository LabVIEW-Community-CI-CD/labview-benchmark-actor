# ADR-0021: Pull requests target develop, not main

- Status: Accepted
- Date: 2026-08-01
- Deciders: LINUX plane (operator-directed)
- Relates to: LBA-REQ-030, ADR-0010 (GitFlow branch governance)

## Context

GitFlow ([ADR-0010](ADR-0010-gitflow-branch-governance.md)) makes `develop` the integration branch and `main` a
protected release branch. Several stale, pre-GitFlow pull requests (for example the authoring-lane PRs #211 /
#215 / #217) were still based on `main`; synchronizing and merging one of them dumped integration content onto
the release branch. Nothing mechanically stated that feature work targets `develop`.

## Decision

- **Every non-release pull request targets `develop`** — feature and authoring work never targets `main`.
- **`main` receives only release/hotfix merges** via `--no-ff` (per ADR-0010), never a feature pull request.
- A pull request discovered on the wrong base is re-targeted or closed, not merged.

This is requirement **LBA-REQ-030**.

## Consequences

- The #211 / #215 / #217 mis-based-PR class cannot recur silently: the base-branch rule is stated and traceable.
- `main` stays a clean release branch; integration churn stays on `develop`.

## Alternatives considered

- **Rely on reviewer vigilance.** Rejected: the stale PRs showed vigilance alone fails; the rule must be explicit.
- **Protect `main` from all pull requests.** Rejected: release/hotfix pull requests legitimately target `main`;
  the rule is that non-release pull requests target `develop`.
