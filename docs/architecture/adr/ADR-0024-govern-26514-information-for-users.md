# ADR-0024: Govern ISO/IEC/IEEE 26514 information for users as a fail-closed requirement

- Status: Accepted
- Date: 2026-08-02
- Deciders: standards audit (2026-08) via `repo-standards-review` v0.2.19
- Relates to: LBA-REQ-034, ADR-0013 (enforced 42010 correspondence graph), ADR-0023 (personal golden-VM onboarding)

## Context

A `repo-standards-review` audit scored the repo 25/25 on the five scored lenses
(REQ/ARCH/TEST/CM/DOC) but surfaced a meta-finding: the substantive gaps live where
conformance is **not gated**. The weakest surface was **ISO/IEC/IEEE 26514:2022
information for users** — a single 134-line `user-guide.md` with no audience/task
analysis, navigation, glossary, or reference. Non-gated documentation drifts from
the product it describes; nothing failed the build when a new command shipped
undocumented.

## Decision

- **Deliver a bounded 26514 information PRODUCT set** under
  `docs/information-for-users/` — navigation hub, getting started, user guide,
  command reference, glossary, FAQ, audience-and-task model, delivery profile,
  information management plan, and a **conformance boundary** — driven by an
  explicit audience/task model (`26514 §5`).
- **State the claim honestly (`26514 §4`):** a bounded *product* claim over that
  set; explicitly **not** full process conformance to Clauses 5–6.
- **Gate it fail-closed.** `experiments/information-for-users/verify-information-for-users.mjs`
  checks the set is complete + non-trivial, that the command reference covers
  **every** contributed VS Code command, that the boundary is stated, and that the
  navigation hub indexes the set; wired as `information-for-users-26514` in
  `verify-local-gates` with a self-test that also proves an empty set fails.
- **Register it (15289)** in the information item map and the correspondence graph.

This is requirement **LBA-REQ-034**.

## Consequences

- 26514 moves from **advisory to enforced**: a new command, audience, or delivery
  surface cannot ship without updating the governed user-information set — the
  build fails until it does.
- The onboarding surface the roadmap (ADR-0023) depends on now exists and stays
  current by construction.
- The audit's meta-finding is closed for the documentation lens: user-information
  conformance is now corroborated by a fail-closed gate, not just present.

## Alternatives considered

- **Keep 26514 advisory.** Rejected: the audit showed non-gated conformance is
  exactly where drift accumulates.
- **One expanded `user-guide.md`.** Rejected: 26514 treats task, audience,
  reference, and navigation as distinct information needs; a single file hides
  gaps and resists findability checks.
- **Claim full process conformance.** Rejected: dishonest under `26514 §4`; the
  bounded product claim is what the evidence supports.
