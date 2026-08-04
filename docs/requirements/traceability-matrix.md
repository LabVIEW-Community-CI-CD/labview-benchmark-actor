# Traceability matrix — labview-benchmark-actor

> GENERATED from the canonical sources (SRS + RTM + architecture description + ADRs) by
> `experiments/reqs-coverage/generate-traceability.mjs` (ADR-0013 correspondence graph, Stage 3).
> Do NOT edit by hand — run the generator and commit. The `traceability-matrix-current` gate fails
> closed if this file drifts from the sources.

| Requirement | Title | Status | Architecture view | Decisions | Test | Code refs |
| --- | --- | --- | --- | --- | --- | --- |
| LBA-REQ-001 | Standalone extraction of hooking and agentic infrastructure | Proven | §3.1 Packaging / boundary | — | T-001 | 6 |
| LBA-REQ-002 | Install on Codespace or Vagrant golden VM | Proven | §3.2 Deployment | — | T-002 | 5 |
| LBA-REQ-003 | Agentic infrastructure drives benchmark runs | Proven | §3.3 Actor / run-result | ADR-0001, ADR-0005, ADR-0007, ADR-0009 | T-003 | 18 |
| LBA-REQ-004 | Benchmark time-cursor (draggable vertical line) | Proven | §3.4 Viewer | ADR-0002 | T-004 | 11 |
| LBA-REQ-005 | Time-indexed picture shown below the benchmark | Proven | §3.4 Viewer | ADR-0002, ADR-0005, ADR-0007, ADR-0009 | T-005 | 3 |
| LBA-REQ-006 | Multi-VM Vagrant benchmarking topology | Proven | §3.2 Deployment | ADR-0004 | T-006 | 2 |
| LBA-REQ-007 | TCP/UDP coordination bus (replaces GitHub Discussion) | Proven | §3.5 Coordination-transport | ADR-0003, ADR-0004, ADR-0008 | T-007 | 1 |
| LBA-REQ-008 | Standards-baseline stamp and move-readiness | Proven | §3.1 Packaging / boundary | ADR-0010, ADR-0013 | T-008 | 5 |
| LBA-REQ-009 | VM cleanroom image storage via the mprr ring buffer | Proven | §3.3 Actor / run-result | ADR-0009 | T-009 | 5 |
| LBA-REQ-010 | Own-run review, host concentration, and the ollama comparison layer | Proven | §3.6 Analysis | ADR-0006, ADR-0008 | T-010 | 16 |
| LBA-REQ-011 | CPU/RAM/disk usage correlation with a pre/post-trigger window | Proven | §3.6 Analysis | — | T-011 | 30 |
| LBA-REQ-012 | Version-pinned agent base instructions | Proven | §3.7 Agentic-infrastructure | — | T-012 | 5 |
| LBA-REQ-013 | Prioritized, addressable coordination messages | Superseded | §3.7 Agentic-infrastructure | ADR-0048 | T-013 | 2 |
| LBA-REQ-014 | Cross-plane benchmark comparison | Proven | §3.6 Analysis | — | T-014 | 17 |
| LBA-REQ-015 | VI Analyzer as a cross-plane benchmark | Proven | §3.6 Analysis | — | T-015 | 17 |
| LBA-REQ-016 | GitFlow branch governance | Proven | §3.8 Configuration-management & assurance | ADR-0010 | T-016 | 3 |
| LBA-REQ-017 | LabVIEW authoring-lane dependency manifest | Proven | §3.8 Configuration-management & assurance | — | T-017 | 3 |
| LBA-REQ-018 | Provider-delegated cleanroom AI uplift | Proven | §3.7 Agentic-infrastructure | ADR-0011 | T-018 | 17 |
| LBA-REQ-019 | MCP server agent tool surface | Proven | §3.7 Agentic-infrastructure | ADR-0012 | T-019 | 7 |
| LBA-REQ-020 | Bidirectional release sign-off | Proven | §3.8 Configuration-management & assurance | — | T-020 | 4 |
| LBA-REQ-021 | Test-to-requirement correspondence gate | Proven | §3.8 Configuration-management & assurance | ADR-0013 | T-021 | 3 |
| LBA-REQ-022 | Generated traceability matrix | Proven | §3.8 Configuration-management & assurance | ADR-0013 | T-022 | 3 |
| LBA-REQ-023 | Actor Corroboration Grid (multi-witness release corroboration) | Proven | §3.9 Corroboration-grid | ADR-0014 | T-023 | 6 |
| LBA-REQ-024 | Corroboration quorum + graded confidence | Proven | §3.9 Corroboration-grid | ADR-0015 | T-024 | 10 |
| LBA-REQ-025 | Corroboration provenance + attestation | Proven | §3.9 Corroboration-grid | ADR-0016 | T-025 | 14 |
| LBA-REQ-026 | Witness independence | Proven | §3.9 Corroboration-grid | ADR-0017, ADR-0068 | T-026 | 7 |
| LBA-REQ-027 | Reviewer station + human sign-off | Proven | §3.9 Corroboration-grid | ADR-0018 | T-027 | 6 |
| LBA-REQ-028 | Mesh verdict beacon | Proven | §3.9 Corroboration-grid | ADR-0019 | T-028 | 6 |
| LBA-REQ-029 | MCP orchestration surface | Proven | §3.9 Corroboration-grid | ADR-0020 | T-029 | 11 |
| LBA-REQ-030 | Pull requests target develop | Proven | §3.8 Configuration-management & assurance | ADR-0021 | T-030 | 5 |
| LBA-REQ-031 | Transparency-log inclusion + verify-before-install | Proven | §3.9 Corroboration-grid | ADR-0022 | T-031 | 11 |
| LBA-REQ-032 | Mesh-stress performance-signature calibration | Proven | §3.6 Analysis | — | T-032 | 28 |
| LBA-REQ-033 | Personal golden-VM onboarding for the LabVIEW community | Proven | §3.2 Deployment | ADR-0023 | T-033 | 9 |
| LBA-REQ-034 | Governed 26514 information for users | Proven | §3.8 Configuration-management & assurance | ADR-0024 | T-034 | 12 |
| LBA-REQ-035 | Generated test report and configuration status accounting | Proven | §3.8 Configuration-management & assurance | ADR-0025 | T-035 | 4 |
| LBA-REQ-036 | Resolvable, invariant-complete release procedure | Proven | §3.8 Configuration-management & assurance | ADR-0026 | T-036 | 4 |
| LBA-REQ-037 | Continuous five-lens compliance self-audit | Proven | §3.8 Configuration-management & assurance | ADR-0027 | T-037 | 4 |
| LBA-REQ-038 | LabVIEW activation confirmation via a headless known-answer probe | Proven | §3.2 Deployment | ADR-0023 | T-038 | 6 |
| LBA-REQ-039 | Mesh-actor registration gated on activation | Proven | §3.2 Deployment | ADR-0023 | T-039 | 4 |
| LBA-REQ-040 | Distributed capacity-weighted parallel workload | Proven | §3.2 Deployment | ADR-0028 | T-040 | 5 |
| LBA-REQ-041 | Capability-aware distributed task routing | Proven | §3.2 Deployment | ADR-0029 | T-041 | 5 |
| LBA-REQ-042 | Cross-plane LabVIEW liveness | Proven | §3.2 Deployment | ADR-0030 | T-042 | 5 |
| LBA-REQ-043 | Cross-plane VI Analyzer determinism | Proven | §3.2 Deployment | ADR-0031 | T-043 | 5 |
| LBA-REQ-044 | Provisioner installs LabVIEW and VIPM | Proven | §3.2 Deployment | ADR-0023 | T-044 | 5 |
| LBA-REQ-045 | Human-assisted VM bridge | Proven | §3.2 Deployment | ADR-0032 | T-045 | 5 |
| LBA-REQ-046 | VIPM functionally installs a community package | Proven | §3.2 Deployment | ADR-0023 | T-046 | 4 |
| LBA-REQ-047 | Live golden-VM status and idle-time analysis | Proven | §3.2 Deployment | ADR-0023 | T-047 | 5 |
| LBA-REQ-048 | Golden-VM Mass Compile benchmark | Proven | §3.2 Deployment | ADR-0023 | T-048 | 4 |
| LBA-REQ-049 | Golden-VM provisioner headless-LabVIEW readiness | Proven | §3.2 Deployment | ADR-0023 | T-049 | 5 |
| LBA-REQ-050 | Cross-plane benchmark grid | Proven | §3.2 Deployment | ADR-0031 | T-050 | 7 |
| LBA-REQ-051 | Icon-editor Packed Library build benchmark | Proven | §3.2 Deployment | ADR-0033 | T-051 | 4 |
| LBA-REQ-052 | g-cli launcher built from Rust + proven on host | Proven | §3.2 Deployment | ADR-0033 | T-052 | 4 |
| LBA-REQ-053 | Icon-editor LUnit test benchmark | Proven | §3.2 Deployment | ADR-0033 | T-053 | 4 |
| LBA-REQ-054 | Benchmark Observatory (suite-wide coverage + determinism map) | Proven | §3.2 Deployment | ADR-0034 | T-054 | 4 |
| LBA-REQ-055 | Handoff Beacon -- capture-status (human-in-the-loop signal) | Proven | §3.2 Deployment | ADR-0035 | T-055 | 6 |
| LBA-REQ-056 | Handoff Beacon -- agent->human request (human-step barrier) | Proven | §3.2 Deployment | ADR-0036 | T-056 | 7 |
| LBA-REQ-057 | Handoff Beacon -- reviewer visual verdict (signed human PASS/FAIL) | Proven | §3.2 Deployment | ADR-0037 | T-057 | 9 |
| LBA-REQ-058 | Handoff Beacon -- reviewer verdict bus announcement | Proven | §3.2 Deployment | ADR-0038 | T-058 | 6 |
| LBA-REQ-059 | Host<->VM-agent closed loop over the lbabus net TCP bus | Proven | §3.2 Deployment | ADR-0039 | T-059 | 8 |
| LBA-REQ-060 | Live-only net coordination -- the receive-log + net poll read side | Proven | §3.2 Deployment | ADR-0040 | T-060 | 4 |
| LBA-REQ-061 | Bus transport selection in the extension -- Discussion default, net opt-in | Proven | §3.2 Deployment | ADR-0041 | T-061 | 4 |
| LBA-REQ-062 | MCP coordination tools transport selection -- Discussion default, net opt-in | Proven | §3.2 Deployment | ADR-0042 | T-062 | 4 |
| LBA-REQ-063 | post-verdict.mjs transport selection -- Discussion default, net opt-in | Proven | §3.2 Deployment | ADR-0043 | T-063 | 2 |
| LBA-REQ-064 | Drop the release-CI GitHub-Discussion verdict announce | Proven | §3.2 Deployment | ADR-0044 | T-064 | 3 |
| LBA-REQ-065 | Flip the coordination default to net + graceful no-op when unconfigured | Proven | §3.2 Deployment | ADR-0045 | T-065 | 7 |
| LBA-REQ-066 | Collapse the coordination product surface to net-only | Proven | §3.2 Deployment | ADR-0046 | T-066 | 8 |
| LBA-REQ-067 | Remove the GitHub-Discussion transport from the lbabus CLI | Proven | §3.2 Deployment | ADR-0047 | T-067 | 5 |
| LBA-REQ-068 | Net-only live VM-agent drive (govern the released-CLI closed loop as a committed receipt) | Proven | §3.2 Deployment | ADR-0049 | T-068 | 6 |
| LBA-REQ-069 | Release-with-review drive (bind the net-staged candidate to the signed + announced verdict) | Proven | §3.2 Deployment | ADR-0050 | T-069 | 5 |
| LBA-REQ-070 | Composite release decision (bind the machine corroboration gate to the human visual gate over one net-staged candidate) | Proven | §3.2 Deployment | ADR-0051 | T-070 | 6 |
| LBA-REQ-071 | Enforce the composite release decision in the extension release workflow | Proven | §3.2 Deployment | ADR-0052 | T-071 | 4 |
| LBA-REQ-072 | Cross-plane launch-benchmark parity (identity is the spec, not the series) | Proven | §3.2 Deployment | ADR-0053 | T-072 | 6 |
| LBA-REQ-073 | Mesh-run cross-plane fulfillment (the North Star loop) | Proven | §3.2 Deployment | ADR-0054 | T-073 | 5 |
| LBA-REQ-074 | GitHub-native mesh-run dispatch transport (repository_dispatch) | Proven | §3.2 Deployment | ADR-0055 | T-074 | 6 |
| LBA-REQ-075 | The mesh coverage observatory (fold the mesh-run receipts into a coverage matrix) | Proven | §3.2 Deployment | ADR-0056 | T-075 | 5 |
| LBA-REQ-076 | The live fan-out contract (actor-tasking + receipt-collection) | Proven | §3.2 Deployment | ADR-0057 | T-076 | 6 |
| LBA-REQ-077 | The opt-in verified tier (enrolled-actor receipt attestations) | Proven | §3.2 Deployment | ADR-0058 | T-077 | 7 |
| LBA-REQ-078 | Transparency-log the mesh-actor attestations (public auditability) | Proven | §3.2 Deployment | ADR-0059 | T-078 | 7 |
| LBA-REQ-079 | The append-only consistency proof (the mesh transparency log only grows) | Proven | §3.2 Deployment | ADR-0060 | T-079 | 7 |
| LBA-REQ-080 | The composite mesh-run-attested decision (one verdict to trust a run) | Proven | §3.2 Deployment | ADR-0061 | T-080 | 4 |
| LBA-REQ-081 | Cross-plane VI Analyzer performance parity (the second benchmark family) | Proven | §3.2 Deployment | ADR-0062 | T-081 | 7 |
| LBA-REQ-082 | The benchmark-suite parity observatory (one view over the parity families) | Proven | §3.2 Deployment | ADR-0063 | T-082 | 6 |
| LBA-REQ-083 | The mesh carries a second benchmark family (VI Analyzer) | Proven | §3.2 Deployment | ADR-0064 | T-083 | 6 |
| LBA-REQ-084 | The stress-discounted cross-plane comparison (discount a result captured on a stressed actor) | Proven | §3.2 Deployment | ADR-0065 | T-084 | 6 |
| LBA-REQ-085 | The byte-reproducible extension package (the reviewed .vsix equals the shipped .vsix) | Proven | §3.1 Packaging / boundary | ADR-0066 | T-085 | 7 |
| LBA-REQ-086 | The cross-plane byte-reproducible extension package (a Windows build equals a Linux build) | Proven | §3.1 Packaging / boundary | ADR-0067 | T-086 | 6 |
| LBA-REQ-087 | Genuine cross-plane corroboration (a windows-latest + ubuntu-latest witness prove two planes agree) | Proven | §3.9 Corroboration-grid | ADR-0069 | T-087 | 5 |
| LBA-REQ-088 | Durable genuine cross-plane corroboration attestation (capture the live two-plane proof as a committed receipt) | Proven | §3.9 Corroboration-grid | ADR-0070 | T-088 | 5 |
| LBA-REQ-089 | Signed cross-plane corroboration (the enrolled human sign-off over the genuine crossPlane quorum) | Proven | §3.9 Corroboration-grid | ADR-0071 | T-089 | 6 |

_Generated for 89 requirements._
