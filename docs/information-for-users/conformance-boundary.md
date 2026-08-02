# Information for Users — Conformance Boundary

> Standards baseline: `repo-standards-review` v0.2.19. Aligns to **ISO/IEC/IEEE
> 26514:2022 §4** (conformance) and **§5** (information for users).

This page states, precisely, what the project's information-for-users set does and
does **not** claim, so the `26514` alignment is honest and auditable
(`26514 §4` requires the claim scope to be stated explicitly).

## What is claimed

- A **bounded information-PRODUCT claim** over the information items in
  [`docs/information-for-users/`](./navigation-and-search.md) plus the
  [`README.md`](../../README.md), the [User Guide](./user-guide.md), and the
  [Command Reference](./command-reference.md).
- The set is designed from an explicit
  [Audience and Task Model](./audience-and-task-model.md) and delivered per the
  [Delivery Profile](./delivery-profile.md).
- The set is **governed**: it is registered in the
  [Information Item Map](../information-item-map.md) (ISO/IEC/IEEE 15289) and its
  completeness is enforced fail-closed by the `information-for-users-26514` gate
  in `experiments/verify-local-gates.mjs` (requirement `LBA-REQ-034`).

## What is NOT claimed

- **Not full process conformance to `26514 §§5–6`.** The project does not assert
  that every process requirement of Clauses 5 and 6 has been achieved end to end.
- **Not a full user manual.** Deep procedures live in the governed route docs
  (`docs/`), not in this compact set.
- **Out of the current claim boundary:** translated deliverables, rich media,
  chatbot / voice response surfaces, and printed information products. These are
  outside the current audience and delivery model until a specific audience/task
  need brings them into scope.

## Boundary decisions (`26514 §4`)

| Decision | Choice |
| --- | --- |
| Conformance of information design/development processes | Partial — planned + audience/task-driven; not fully proven |
| Conformance of information products | **Claimed** for the bounded set above |
| Scope of the product claim | The `docs/information-for-users/` set + README + User Guide + Command Reference |
| Repo docs outside the claim | Architecture, requirements, CM, testing, release, and research docs (governed separately under 15289 / 42010 / 29148 / 29119 / 12207) |

## Change control

Revisit this boundary whenever a new audience, task, delivery surface, or
information item is added. The `information-for-users-26514` gate fails closed if
a required item is missing or empty, so the claimed product set cannot silently
drift out of conformance.
