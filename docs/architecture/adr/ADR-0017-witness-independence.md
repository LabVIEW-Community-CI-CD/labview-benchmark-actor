# ADR-0017: Witness independence for the corroboration grid

- Status: Accepted
- Date: 2026-08-01
- Deciders: LINUX plane (operator-directed)
- Relates to: LBA-REQ-026, ADR-0014 (Actor Corroboration Grid umbrella)

## Context

A corroboration quorum only means something if its witnesses are genuinely independent: N identical codespaces
are not N independent witnesses, and one actor spinning up look-alike nodes could forge "agreement." The umbrella
decision ([ADR-0014](ADR-0014-actor-corroboration-grid.md)) requires independence but left the anti-forgery
mechanism unspecified.

## Decision

- **Enforce provider/OS diversity** — a valid quorum must span **distinct enrolled environments**; a quorum built
  from N witnesses of the same environment is rejected.
- **Record each witness identity** in the provenance (OIDC where available, an enrolled key otherwise).
- **Allowlist enrollment** — a witness that is not enrolled, or that duplicates an already-counted environment,
  does not count toward the quorum.

This is requirement **LBA-REQ-026**.

## Consequences

- Agreement cannot be manufactured by one actor cloning a single environment.
- The quorum's independence is machine-checkable (distinct enrolled environments), not a matter of trust.
- It bounds the witness set to known, enrolled identities, which the provenance (ADR-0016) records.

## Alternatives considered

- **Identity without diversity.** Rejected: three enrolled-but-identical nodes still are not independent.
- **Treat diversity as advisory.** Rejected: forgery resistance must fail closed, not warn.
