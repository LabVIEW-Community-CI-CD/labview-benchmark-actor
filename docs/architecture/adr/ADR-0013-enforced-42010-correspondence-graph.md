# ADR-0013: Adopt an enforced ISO/IEC/IEEE 42010 correspondence graph as the traceability architecture

- Status: Accepted
- Date: 2026-08-01
- Deciders: LINUX plane (operator-directed)
- Relates to: LBA-REQ-021, LBA-REQ-022, LBA-REQ-008 (traceability governance), ADR-0010 (branch governance), and the full ADR-0001..0012 decision set

## Context

Traceability had been maintained as hand-edited RTM rows. ISO/IEC/IEEE 42010:2022 provides a purpose-built
primitive we were not using: **correspondences and correspondence rules**, introduced "to express and enforce
relations between AD [architecture description] elements ... dependencies and inconsistencies" (42010:2022,
Annex on correspondences; §5.2.12 / §6.10 for decisions and rationale).

Without an enforced correspondence set, the architecture description silently rotted:

- [docs/architecture/overview.md](../overview.md) §4 froze its decision register at `AD-1..AD-10` tracing to
  `LBA-REQ-001..010`, while requirements advanced to `LBA-REQ-020` and `ADR-0011`/`ADR-0012` were added — with
  no rule forcing consistency.
- Two decision registers coexist — the inline `AD-n` table in `overview.md` and the `ADR-00NN` files — and have
  already diverged.
- Gates enforced `SRS <-> RTM <-> disk` (reqs-coverage rings) but nothing enforced
  `concern -> view -> decision -> requirement`.

## Decision

Model the repository's assurance surface as a **42010 correspondence graph** — `stakeholder -> concern ->
viewpoint -> view -> architecture-decision (ADR) -> requirement (29148) -> test (29119) -> code` — and enforce
its **correspondence rules** as fail-closed CI gates via
[experiments/reqs-coverage/verify-correspondences.mjs](../../../experiments/reqs-coverage/verify-correspondences.mjs)
(dependency-free, wired into `verify-local-gates`).

Seed the engine now with:

- **TR-1 (fail-closed)** — every governed test file corresponds to at least one requirement through an RTM
  CodeRef (this is `LBA-REQ-021`; it subsumes the previously-planned ring-3 "tests-all-mapped" gate).
- **AD-1 (fail-closed)** — every ADR traces to at least one requirement and is registered in the `overview.md`
  decision register (so the inline register and the `ADR-00NN` files cannot drift apart).
- **VW-1 (fail-closed)** — every requirement is described by an architecture view in `overview.md`.

The stage-2 reconciliation lands with this decision: the `overview.md` §3 views and §4 decision register are
extended to cover `LBA-REQ-011..021`, the §6 ADR index is completed, and the stakeholders/concerns are refreshed —
so AD-1 and VW-1 are promoted from advisory to fail-closed in the same change. A later correspondence rule may
still start advisory (`enforced:false`) to report a census without blocking, then be promoted once its register
is reconciled. As the graph becomes authoritative, the RTM, the coverage matrix, and the architecture-description
views are **generated from** it rather than hand-maintained.

## Consequences

- Drift becomes machine-detected immediately (the advisory census reports exactly which decisions and
  requirements are not yet corresponded) and structurally impossible once each rule is promoted.
- One correspondence engine subsumes the reqs-coverage rings, the tests-all-mapped gate, and the full standards
  constellation `repo-standards-review` indexes: 42010 (TR-1 / AD-1 / VW-1), 15289 (II-1 / II-2), 12207 (PR-1),
  and 10007 (CM-1) — all live and fail-closed as of Stage 4, completing the correspondence-graph roadmap.
- `verify-local-gates` gains one check. The stage-2 architecture-description reconciliation lands with this
  ADR, so all three seed rules (TR-1, AD-1, VW-1) ship fail-closed and the graph is conformant end-to-end.

## Alternatives considered

- **Keep hand-maintained RTM rows.** Rejected: drift already occurred silently (the AD register froze at
  REQ-010); manual policing does not scale across four+ standards.
- **Ship only the one-off ring-3 tests-mapped gate.** Rejected: it enforces a single edge and would leave the
  architecture-description freeze invisible; the correspondence graph generalizes it at the same cost.
- **Adopt a heavyweight external traceability/ALM tool.** Rejected: violates the dependency-free local-gate
  doctrine and the standalone-repository boundary (LBA-REQ-001/008).
