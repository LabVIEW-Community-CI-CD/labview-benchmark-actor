# Architecture Decision Records — labview-benchmark-actor

> Standards baseline: `repo-standards-review` v0.2.19. ADRs support the 42010
> architecture description. Format: Status / Context / Decision / Consequences /
> Traces-to.

## Index

| ADR | Title | Owner | Status | Traces to |
| --- | --- | --- | --- | --- |
| [ADR-0001](ADR-0001-run-result-schema.md) | Run-result schema (metrics + time-indexed pictures on one clock) | WIN | Proposed | LBA-REQ-003 |
| [ADR-0002](ADR-0002-viewer-cursor-picture-binding.md) | Viewer: single selected-time source of truth | WIN | Proposed | LBA-REQ-004, LBA-REQ-005 |
| ADR-0003 | Coordination bus wire format (TCP framing) | LINUX *(reserved)* | — | LBA-REQ-007 |
| ADR-0004 | Cross-VM time-sync (UDP beacon cadence + skew bound) | LINUX *(reserved)* | — | LBA-REQ-006, LBA-REQ-007 |

Numbering is split by owner to avoid collisions: WIN takes 0001–0002, LINUX
takes 0003–0004. Add new ADRs by extending your own range.
