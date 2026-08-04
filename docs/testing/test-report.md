# Test & assurance report — labview-benchmark-actor

> GENERATED from the canonical sources (gate suite + correspondence graph + coverage floors + RTM +
> test plan + ADR register) by `experiments/reqs-coverage/generate-test-report.mjs`. Do NOT edit by
> hand — run the generator and commit. The `test-report-current` gate fails closed if this file drifts.
>
> This is the ISO/IEC/IEEE 29119-3 **test report** (executed verification evidence and completion
> criteria) and the ISO 10007 / ISO/IEC/IEEE 12207 **configuration status accounting** record for the
> repository. It records the controlled state of the verification apparatus, not one ad-hoc run: every
> item below is enforced fail-closed in CI on every pull request, so "current" means "as enforced on
> the tip of `develop`". The complementary test **plan** (design of what to test) is
> `docs/testing/test-plan.md`.

## 1. Completion criteria (ISO/IEC/IEEE 29119-2)

Testing is **complete** for a change when **every governed gate passes fail-closed** in CI on both
`ubuntu-latest` and `windows-latest`. A single red gate blocks merge; there is no manual sign-off path
that can override a red gate. The completion criteria are therefore machine-checked and
non-discretionary — the same apparatus runs locally (`node experiments/verify-local-gates.mjs`) and in
the `LBA Local Gates verify` CI job.

## 2. Executed verification evidence (ISO/IEC/IEEE 29119-3)

### 2.1 Local gate suite — 186 fail-closed checks

Run by `node experiments/verify-local-gates.mjs`. All must pass. The full gate inventory (the executed
test items at the gate granularity) is:

```
acg-cross-plane-attestation
acg-cross-plane-corroboration
acg-cross-plane-corroboration-workflow-wired
acg-governance-pr-base-branch
acg-governance-pr-base-branch-workflow-wired
acg-grid-e2e
acg-grid-run-live
acg-independence-live
acg-independence-quorum
acg-keyless-attest-workflow-wired
acg-mcp-grid-surface
acg-mesh-loopback-evidence
acg-mesh-verdict-beacon
acg-provenance-attest
acg-provenance-verify-before-consume
acg-quorum-assemble-witness
acg-quorum-compare-witnesses
acg-quorum-live-corroboration
acg-reviewer-release-decision
acg-reviewer-sign-off
acg-transparency-log
acg-transparency-log-live
acg-transparency-verify-before-install
acg-transparency-verify-before-install-wired
activation-receipt-confirms-activation
adr-index-integrity
agent-tooling-selftest
all-plane-receipts-authoritative-zero-skew
authoring-dep-manifest
benchmark-observatory
benchmark-store-receipt-green
benchmark-suite-parity-observatory
boot-benchmark-cross-iteration-diff
boot-benchmark-cross-plane-co-run-receipt
boot-benchmark-seal-spans-and-fail-closed
boot-benchmark-vmware-vnc-backend
bootbench-cross-plane-diff-receipt
bus-prototype-receipt-green
bus-transport-select
capability-aware-routing
capture-ring-benchmark-panels
capture-ring-combined-visual-dual-clock
capture-ring-cross-plane-trend
capture-ring-fiducial-cross-plane
capture-ring-fiducial-groundtruth
capture-ring-frame-correlator
capture-ring-ingest-adapter
capture-ring-labview-launch-receipt
capture-ring-labview-trend-receipt
capture-ring-labview-trend-receipt-win
capture-ring-recorder
capture-ring-resource-correlation-live
capture-ring-resource-correlation-win
capture-ring-resource-cross-plane
capture-ring-settle-detect
capture-ring-vbox-source
capture-ring-visual-dual-clock
capture-ring-vmware-wiring
capture-ring-workload-benchmark
capture-ring-workload-cross-plane
capture-ring-workload-trend
cleanroom-bootstrap-is-winget-free
cleanroom-gate-suite-shared-in-sync
cleanroom-provisioner-scripts-pure-ascii
cli-no-discussion-transport
closed-loop-readback
codespace-witness-bootstrap-valid
codespace-witness-prebuild-workflow-wired
collab-cli-embeds-canonical-requirements
colon-corroboration-plane2-scoring
composite-release-decision
composite-release-enforced
continuous-compliance-self-audit
corpus-ingestion-contract-green
corroboration-confidence-reference
coverage-artifact-meets-floor
cross-plane-benchmark-grid
cross-plane-comparison-proven-green
cross-plane-labview-liveness
cross-plane-launch-parity
cross-plane-vi-analyzer-determinism
cross-plane-vi-analyzer-parity
devcontainer-codespace-install-route
distributed-parallel-workload
docs-stamp-and-no-id-renumbering
dod-definition-present
ephemeral-mesh-2node-receipt-green
ephemeral-mesh-receipt-green
ephemeral-mesh-typed-receipt-green
extension-agents-manifest-green
extension-manifest-boundary
first-win-onboarding
frame-correlator-click-marker
frame-markers-image-grab
g-cli-proxy-proof
gitflow-branch-governance-documented
handoff-capture-status
handoff-request
handoff-verdict
host-concentration-core-receipt-green
image-derived-timing-colon-ocr-fidelity
in-guest-sampler-v2
information-for-users-26514
live-v2-capture-real
lunit-test-benchmark
mass-compile-benchmark
mcp-net-transport
mcp-server-surface-contract
mesh-actor-registration-requires-activation
mesh-attestations-transparency-logged
mesh-benchmark-family-vi-analyzer
mesh-board-view
mesh-calibration-view
mesh-concurrent-actors-real
mesh-coverage-observatory
mesh-live-fanout-wired
mesh-live-ladder-real
mesh-log-append-only
mesh-run-attested
mesh-run-cross-plane-fulfillment
mesh-run-dispatch-wired
mesh-stress-orchestrator
mesh-stress-signature-calibrator
mesh-stress-signature-extractor
mesh-verified-tier-attested
mprr-absorbed-constants-match-mprr-spec
mprr-absorbed-self-owned-not-external
mprr-dual-packet-degradation-green
mprr-live-capture-shared-inputs-present
mprr-packet-harness-profiles-green
mprr-short-ring-model-green
multi-vm-corpus-export-receipt-green
multi-vm-topology-receipt-green
net-coordination-log
net-default-graceful
net-only-live-drive
ocr-primitive-engine-and-readback
ollama-comparison-core-receipt-green
performance-counter-correlation-live-trigger
performance-counter-correlation-real
post-verdict-net-transport
ppl-build-benchmark
provider-delegation-claim-tasking
provider-delegation-coverage-lift
provider-delegation-evidence
provider-delegation-harness
provider-delegation-quality-gate
provider-delegation-registry
provider-delegation-risky-test
provider-delegation-vipm-gate
provider-delegation-vipm-routing
provider-delegation-worker-pool
provisioner-headless-readiness
provisioner-installs-labview-and-vipm
readme-marketplace-safe-links
real-corpus-wiring-green
release-lanes-keyless-attested
release-no-discussion-announce
release-procedure-references-resolve
release-with-review-drive
reproducible-vsix-normalizer
requirements-quality-29148
resource-usage-correlation-receipt-green
reviewed-vsix-matches-shipped
reviewer-workstation-keyless-verify-wired
ring-buffer-mirror-replay-deterministic
rtm-proven-rows-cite-existing-evidence
self-test-conformance-inputs-pinned
stress-discounted-comparison
test-report-current
test-requirement-correspondence
traceability-matrix-current
vi-analyzer-ascii-parser-green
vi-analyzer-real-report-cross-plane-green
vi-analyzer-report-schema-green
vi-analyzer-result-model-green
viewer-cursor-logic-receipt-green
viewer-webview-surface-wired
vipm-functional-package-install
vm-bridge-human-assisted-secret-safety
vm-live-status-idle-analysis
vsix-cross-plane-repro-workflow-wired
win-pdh-sampler-12fps
win-vm-concurrent-mesh-real
win-vm-mesh-ladder-real
windows-crosscheck-receipt-authoritative
```

### 2.2 Correspondence graph — 7 fail-closed rules

Run by `node experiments/reqs-coverage/verify-correspondences.mjs` (also invoked as gates). Each rule
is a structural invariant across the governed information items:

| Rule | Enforced | Invariant |
| --- | --- | --- |
| TR-1 | yes | test<->requirement (every governed test corresponds to >=1 requirement) |
| AD-1 | yes | ADR<->requirement + register (every ADR traces to a requirement and is registered in overview.md) |
| VW-1 | yes | requirement<->architecture-view (every requirement described in overview.md) |
| II-1 | yes | information-item<->file (every 15289 information item resolves on disk) |
| II-2 | yes | information-item completeness (every core governed doc is registered in the 15289 map) |
| PR-1 | yes | process-outcome<->enforcement (every DoD 12207 outcome has a resolvable gate/artifact) |
| CM-1 | yes | CM status-accounting (every ADR file Status matches the ADR index register) |

### 2.3 Coverage gate

The PR Coverage Gate (c8 `--check-coverage`) fails under these floors: lines 95%,
statements 95%, functions 96%, branches 80%. Floors
ratchet up only (`npm run coverage:bump`); they are never lowered by hand.

### 2.4 Extension test suites

The Mocha extension activation + view-render suites run in the `extension tests` CI jobs on
`ubuntu-latest` and `windows-latest`.

## 3. Configuration status accounting (ISO 10007 / ISO/IEC/IEEE 12207)

The controlled state of the repository's configuration items, derived from the registers:

| Configuration item class | Count | Register |
| --- | --- | --- |
| Requirements (total) | 88 | docs/requirements/srs.md, rtm.csv |
| — Status: Proven | 87 | rtm.csv |
| — Status: Superseded | 1 | rtm.csv |
| Architecture decisions (ADRs) | 70 | docs/architecture/adr/README.md |
| Governed gates | 186 | experiments/verify-local-gates.mjs |
| Correspondence rules | 7 | experiments/reqs-coverage/verify-correspondences.mjs |
| Governed test items | 88 | docs/testing/test-plan.md |

Baselines are cut on the `main` branch via SemVer tags (GitFlow); each release is keyless-signed and
corroborated across planes before publication (see `docs/cm/cm-plan.md` and the release procedure).

## 4. Traceability

Every requirement's requirement ↔ view ↔ decision ↔ test ↔ code linkage is in the generated
traceability matrix (`docs/requirements/traceability-matrix.md`), itself gated by
`traceability-matrix-current`. This report and that matrix are the two generated, drift-gated views of
the same correspondence graph (ADR-0013).

## 5. Regeneration

`node experiments/reqs-coverage/generate-test-report.mjs` rewrites this file; `--check` (the
`test-report-current` gate) fails closed on drift, so the report can never silently lag the apparatus.

_Generated from 186 gates, 7 correspondence rules, 88 requirements, 70 ADRs, 88 test items._
