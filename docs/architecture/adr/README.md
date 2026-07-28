# Architecture Decision Records — labview-benchmark-actor

> Standards baseline: `repo-standards-review` v0.2.19. ADRs support the 42010
> architecture description. Format: Status / Context / Decision / Consequences /
> Traces-to.

## Index

| ADR | Title | Owner | Status | Traces to |
| --- | --- | --- | --- | --- |
| [ADR-0001](ADR-0001-run-result-schema.md) | Run-result schema (metrics + time-indexed pictures on one clock) | WIN | Proposed | LBA-REQ-003 |
| [ADR-0002](ADR-0002-viewer-cursor-picture-binding.md) | Viewer: single selected-time source of truth | WIN | Proposed | LBA-REQ-004, LBA-REQ-005 |
| [ADR-0003](ADR-0003-coordination-bus-wire-format.md) | Coordination bus wire format (length-prefixed JSON over TCP) | LINUX | Proposed | LBA-REQ-007 |
| [ADR-0004](ADR-0004-cross-vm-time-sync.md) | UDP presence/liveness + advisory coordination time (no cross-VM comparison) | LINUX | Proposed | LBA-REQ-006, LBA-REQ-007 |
| [ADR-0005](ADR-0005-image-storage-mprr-ringbuffer-cleanroom.md) | Image/frame storage via mprr ring buffer in the VM cleanroom (no image transport over the bus) | WIN | Proposed | LBA-REQ-003, LBA-REQ-005 |
| [ADR-0006](ADR-0006-run-concentration-ollama-comparison.md) | Run concentration to the operator host + ollama comparison (no cross-VM comparison) | WIN | Proposed | LBA-REQ-010 |
| [ADR-0007](ADR-0007-image-derived-timing-binary-strip.md) | Image-derived timing binds to the pixel-decoded binary strip (cross-platform); colon time is human-only | WIN | Accepted | LBA-REQ-003, LBA-REQ-005 |
| [ADR-0008](ADR-0008-interactive-ollama-drive-mirrored-build-coordination.md) | Interactive host-Ollama drive + mirrored host/VM Copilot build-coordination over lbabus net | WIN | Proposed | LBA-REQ-007, LBA-REQ-010 |

Numbering is split by owner to avoid collisions: WIN takes 0001–0002 (+0005, 0006, 0007, 0008),
LINUX takes 0003–0004. Add new ADRs by extending your own range.
