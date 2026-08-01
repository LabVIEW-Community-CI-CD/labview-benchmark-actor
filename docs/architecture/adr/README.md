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
| [ADR-0009](ADR-0009-absorb-mprr-model-self-owned.md) | Absorb the mprr ring-buffer and self-test timing model as self-owned (retire the external `svelderrainruiz/mprr` dependency) | WIN | Accepted | LBA-REQ-003, LBA-REQ-005, LBA-REQ-009 |
| [ADR-0010](ADR-0010-gitflow-branch-governance.md) | GitFlow is the branch-governance doctrine (`main` protected + `develop` integration; feature/release/hotfix rules) | LINUX | Accepted | LBA-REQ-008, LBA-REQ-016 |
| [ADR-0011](ADR-0011-provider-delegation-cleanroom-uplift.md) | AI-provider uplift is delegated to cleanroom actors over the coordination bus | LINUX | Accepted | LBA-REQ-018 |
| [ADR-0012](ADR-0012-mcp-server-agent-tool-surface.md) | The benchmark actor exposes its tools to agents through a Model Context Protocol server | LINUX | Accepted | LBA-REQ-019 |
| [ADR-0013](ADR-0013-enforced-42010-correspondence-graph.md) | Adopt an enforced ISO/IEC/IEEE 42010 correspondence graph as the traceability architecture | LINUX | Accepted | LBA-REQ-008, LBA-REQ-021, LBA-REQ-022 |
| [ADR-0014](ADR-0014-actor-corroboration-grid.md) | Actor Corroboration Grid: multi-witness release corroboration | LINUX | Accepted | LBA-REQ-023 |
| [ADR-0015](ADR-0015-corroboration-quorum-confidence.md) | Corroboration quorum + graded confidence | LINUX | Accepted | LBA-REQ-024 |
| [ADR-0016](ADR-0016-provenance-attestation.md) | Provenance and attestation for the corroboration grid | LINUX | Accepted | LBA-REQ-025 |
| [ADR-0017](ADR-0017-witness-independence.md) | Witness independence for the corroboration grid | LINUX | Accepted | LBA-REQ-026 |
| [ADR-0018](ADR-0018-reviewer-station.md) | Reviewer station for the corroboration grid | LINUX | Accepted | LBA-REQ-027 |
| [ADR-0019](ADR-0019-mesh-integration.md) | Mesh integration for the corroboration grid | LINUX | Accepted | LBA-REQ-028 |
| [ADR-0020](ADR-0020-mcp-orchestration-surface.md) | MCP orchestration surface for the corroboration grid | LINUX | Accepted | LBA-REQ-029 |
| [ADR-0021](ADR-0021-pull-requests-target-develop.md) | Pull requests target develop, not main | LINUX | Accepted | LBA-REQ-030 |
| [ADR-0022](ADR-0022-transparency-log-inclusion.md) | Signed Merkle transparency log + verify-before-install | LINUX | Accepted | LBA-REQ-031 |

Numbering is split by owner to avoid collisions: WIN takes 0001–0002 (+0005, 0006, 0007, 0008, 0009),
LINUX takes 0003–0004 (+0010, 0011, 0012, 0013, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022). Add new ADRs by extending your own range.
