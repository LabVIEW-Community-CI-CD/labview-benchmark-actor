# Information Management Plan

> How the project's information for users is planned, produced, validated, and
> maintained. Aligns to **ISO/IEC/IEEE 26514:2022 §5** (planning) and
> **ISO/IEC/IEEE 15289** (information items). Governed under `LBA-REQ-034`.

## Scope

- **Product:** the `labview-benchmark-actor` VS Code extension + its benchmark
  actors.
- **Claim:** the bounded information-product set in the
  [Conformance Boundary](./conformance-boundary.md).
- **Baseline:** `repo-standards-review` v0.2.19.

## Audiences and tasks

Defined in the [Audience and Task Model](./audience-and-task-model.md): LabVIEW
community members, autonomous AI agents, maintainers, and reviewers, with their
task profiles. That model drives which items exist and what each contains.

## Information items

| Item | Path | Purpose |
| --- | --- | --- |
| Navigation hub | [`navigation-and-search.md`](./navigation-and-search.md) | Index + findability for the set |
| Getting started | [`getting-started.md`](./getting-started.md) | Task-first onboarding |
| User guide | [`user-guide.md`](./user-guide.md) | In-depth workflow |
| Command reference | [`command-reference.md`](./command-reference.md) | Every command |
| Glossary | [`glossary.md`](./glossary.md) | Domain terms |
| FAQ | [`faq.md`](./faq.md) | Recurring answers |
| Audience + task model | [`audience-and-task-model.md`](./audience-and-task-model.md) | Who + what tasks |
| Delivery profile | [`delivery-profile.md`](./delivery-profile.md) | How information is delivered |
| Conformance boundary | [`conformance-boundary.md`](./conformance-boundary.md) | The 26514 claim scope |
| This plan | [`plan.md`](./plan.md) | Planning + maintenance |

All are registered in the [Information Item Map](../information-item-map.md)
(15289).

## Production and validation

- Authored in repo-relative Markdown; deep behavior lives in the governed route
  docs (`docs/`), not duplicated here.
- **Validation is fail-closed:** the `information-for-users-26514` gate in
  `experiments/verify-local-gates.mjs` (requirement `LBA-REQ-034`, test `T-034`)
  fails the build if a required item is missing/empty, if the command reference
  omits a contributed command, if the conformance boundary is unstated, or if the
  navigation hub does not index the set. A **lychee** docs link-check runs in CI.

## Review and maintenance

- **Triggers:** a new command, audience, task, delivery surface, or information
  item; a UI or install-route change.
- **Owner:** maintainers.
- **Cadence:** reviewed whenever a trigger fires; the gate prevents silent drift
  between the product and this set.
