# labview-benchmark-actor — Software Requirements Specification

> Standards baseline: `repo-standards-review` v0.2.19. Requirements follow
> ISO/IEC/IEEE 29148 §5 (requirement quality: verifiable, unambiguous,
> traceable). Requirement IDs are `LBA-REQ-NNN`; acceptance criteria are cited
> by position as `LBA-REQ-NNN.M`.

## Introduction

`labview-benchmark-actor` is a VS Code extension that extracts the hooking and
agentic infrastructure from `vi-history-suite` into a standalone, installable
package for **benchmarking**. It is installed on a **Codespace** or a **Vagrant
golden VM**, drives benchmark runs through its agentic infrastructure, and
presents results through a **time-cursor benchmark viewer**. Multiple Vagrant
VMs coordinate over a **TCP/UDP bus** rather than a GitHub Discussion.

Assumptions and constraints are marked as such; everything else is a normative
requirement. This is planning material — no implementation is claimed.

**Absorbed model (self-owned):** captured pictures are stored via the **mprr**
ring-buffer model — its bounded-RAM dual-packet ring buffer (dual-packet policy
from mprr ADR-0024) and frozen TDMS-compatible `1.0` replay transport — inside each
VM cleanroom. This model is **absorbed in-repo as dependency-free mirrors** under
`experiments/mprr-ring/`; labview-benchmark-actor owns it and does not track the
external `svelderrainruiz/mprr` repository. The `mprr` name is retained for the local
model (see LBA-REQ-009, ADR-0005, ADR-0009).

The coordination bus carries **inter-actor communication only** (the
GitHub-Discussion replacement); run data never crosses it. Agents do not compare
runs across VMs — each reviews its own previous runs, and the operator
concentrates runs onto the host for an ollama comparison layer (LBA-REQ-010,
ADR-0006).

---

## Requirements (governed register)

Per the `repo-standards-review` requirement directive (ISO/IEC/IEEE 29148:2018
§5.2.5 Singular), each requirement is a single-`shall` row with a measurable Fit
Criterion and a Verification method, validated by
`scripts/requirements_quality_check.py`. The `### LBA-REQ-NNN` sections below
elaborate acceptance detail. Rows are migrated into this governed register
progressively.

| ID | Requirement | Rationale | Fit Criterion | Verification |
| --- | --- | --- | --- | --- |
| LBA-REQ-017 | The system shall record every LabVIEW authoring-lane dependency as a version-pinned entry in a governed dependency manifest. | The authoring lane (`labview_assistant` + its DQMH dependency + the `.vipb` VI-Package build) must build reproducibly on the Windows clean room, which requires every dependency pinned to a concrete, verifiable version rather than a floating reference. | `experiments/labview-authoring/dep-manifest.json` records each authoring dependency with a `pinStatus` of `resolved` (a concrete git SHA, pip version, or vipc) or `tbd-*`, and the verifier rejects a bad schema, a malformed SHA, an unknown plane, a missing python bitness, a bad `pinStatus`, or a `resolved` entry with an empty version. | Run `node experiments/labview-authoring/verify-dep-manifest.mjs` and `verify-dep-manifest.selftest.mjs`; both gated in `verify-local-gates`. |
| LBA-REQ-018 | The system shall delegate a validated uplift task to a capability-matched cleanroom AI provider over the coordination bus. | Uplift and documentation-drafting work runs where the licensed tooling and capability differentiation live (cleanroom actors running Ollama / Copilot CLI / Codex), so the host observes each cleanroom's gated outcome over the existing `lbabus` transport rather than hosting providers centrally. | `delegateUplift` validates an `lba-uplift-task@v1` spec, drives the provider through a provider-agnostic adapter seam, applies a deterministic acceptance gate (pass and fail), and writes an `lba-uplift-delegation-receipt@v1` announced as an ADR-0003 `DONE` frame; the registry routes a `CLAIM` only to a live capability-matched worker; the worker pool bounds concurrency; each uplift domain (coverage-lift, evidence, risky-test, VIPM credential + routing) gates fail-closed — all proven offline via the mock adapter. | Run the provider-delegation verify suite (`verify-provider-delegation`, `verify-registry`, `verify-claim-tasking`, `verify-worker-pool`, `verify-quality-gate`, `verify-vipm-routing`, `verify-vipm-gate`, `verify-coverage-lift`, `verify-evidence`, `verify-risky-test`); gated in `verify-local-gates`. |
| LBA-REQ-019 | The system shall expose the benchmark actor's tools to a coding agent through a Model Context Protocol server. | Coding agents consume tooling through MCP, and the actor already holds value an agent wants (host capabilities, the deterministic mprr benchmark series, and the `lbabus` coordination bus), so a standard MCP surface lets an agent discover and call them directly rather than through bespoke VS Code commands. | The compiled JSON-RPC 2.0 handler answers `initialize` / `tools/list` / `tools/call` over newline-delimited stdio, publishes exactly four tools (`get_host_capabilities`, `get_benchmark_series`, `poll_coordination_bus`, `post_coordination_note`), returns `-32601` / `-32602` for an unknown method / tool, and degrades a missing `lbabus` to a soft `isError` rather than a transport crash; the definition provider registers under the same id the manifest contributes; and `docs/mcp-tools.md` matches the published registry. | Run `npm test` (compiles, then runs `test/mcp-server.mjs` -- pure-core, activation, and stdio legs -- and `scripts/mcpToolDoc.mjs --check docs/mcp-tools.md`). |
| LBA-REQ-020 | The system shall block a component release from publishing until both the WIN and LINUX planes have recorded an agreed sign-off for that exact component version. | A shared release (the `collab-cli` bus binary or the VS Code extension `.vsix`) is co-owned by both planes, so letting either plane publish unilaterally would ship an unreviewed change; each component's release workflow therefore fails closed until both planes commit an explicit `agreed:true` sign-off for the exact version. | `verify-release-agreement.mjs` reads `tools/collab-cli/release-agreement.json` (`release-agreement@v2`) and exits 0 only when every required plane (WIN, LINUX) records `agreed:true` for the `<component, version>`, exits 1 fail-closed on a missing / withheld / unparseable sign-off, and exits 2 on a usage error; both `extension-release.yml` and `collab-cli-release.yml` run it before their publish job. | Run `node tools/collab-cli/verify-release-agreement.mjs <version>` (and `--component extension <version>`); each release workflow gates its publish job on the gate's exit 0. |
| LBA-REQ-021 | The system shall reject any governed test file that does not correspond to at least one requirement in the traceability register. | A test that maps to no requirement is either an untraceable capability or dead weight; enforcing the test-to-requirement correspondence as a fail-closed gate keeps the 29119 test suite tied to the 29148 requirements and seeds the ISO/IEC/IEEE 42010 correspondence graph (ADR-0013) that later rules extend. | `verify-correspondences.mjs` enumerates the governed test set (`test/*.mjs`, `experiments/**/verify-*.mjs`, `*.selftest.mjs`, `*.playwright.{mjs,cjs}`, `playwright/*.mjs`, `tools/**/verify-*`) from the working tree and exits 1 listing any file absent from every RTM CodeRef (rule TR-1); it also enforces the ADR-to-requirement (AD-1) and requirement-to-view (VW-1) correspondence rules fail-closed after the ADR-0013 register reconciliation. | Run `node experiments/reqs-coverage/verify-correspondences.mjs`; gated in `verify-local-gates`. |
| LBA-REQ-022 | The system shall generate the requirement traceability matrix from the governed requirement, test, and decision sources. | Hand-maintaining the requirement-to-view-to-decision-to-test cross-references invites drift, so deriving one matrix from the canonical SRS, RTM, architecture description, and ADR register keeps the traceability view honest and current by construction (ADR-0013 correspondence graph, Stage 3). | `generate-traceability.mjs` reads the requirement ids and titles from `docs/requirements/srs.md`, the status / TestID / CodeRef count from `docs/requirements/rtm.csv`, the addressing architecture view from `docs/architecture/overview.md`, and the decisions from the ADR index, then writes `docs/requirements/traceability-matrix.md`; `--check` exits non-zero when the committed matrix is stale. | Run `node experiments/reqs-coverage/generate-traceability.mjs --check`; gated by `traceability-matrix-current` in `verify-local-gates`. |
| LBA-REQ-023 | The system shall gate each governed component release on an on-demand corroboration quorum in which a majority of independent witnesses across distinct environments agree on the release's deterministic anchors. | A single cleanroom is an unwitnessed single point of trust; requiring a majority of independent, distinct-environment witnesses to agree on the deterministic anchors raises release confidence and makes a drifted or forged witness detectable as a quorum divergence rather than a silent pass. | The Actor Corroboration Grid (ADR-0014) collects a signed receipt bundle from at least two of three heterogeneous witnesses (Codespace-Linux, VirtualBox-Linux, Windows) and passes only when a majority agree on the OS-independent anchors (viewer `seriesHash`, `lbabus` version + `sourceCommit`, gate-suite `verdict`); a sub-majority blocks the release and opens a divergence issue. | The Actor Corroboration Grid end-to-end gate (`experiments/acg-grid/grid.mjs`) composes every sub-engine -- independence + quorum + attestation + mesh + human sign-off -- into one release decision (self-test 6/6, gated by `acg-grid-e2e`); the real {codespace, host} grid corroborates through every machine stage, held only at the human sign-off (`acg-grid-run-live`). |
| LBA-REQ-024 | The system shall pass the release corroboration quorum only when a majority of participating witnesses agree on their applicable OS-independent anchors and the graded anchor-agreement fraction meets the configured threshold. | A single witness is an unwitnessed point of trust; grading agreement across a majority of heterogeneous witnesses tolerates one outage while still requiring genuine cross-environment corroboration (ADR-0015). | The quorum verdict is the fraction `matched / applicable` anchor dimensions under the tiered model; it passes on a >=2-of-3 majority meeting the threshold, and a sub-majority or below-threshold result blocks the release and opens a divergence issue naming the dissenting witness and anchor. | Run `node experiments/acg-quorum/compare-witnesses.selftest.mjs` (7/7) and `node experiments/acg-quorum/assemble-witness.selftest.mjs` (9/9); the tiered-anchor graded-majority compare and the fail-closed witness-bundle assembler that feeds it are gated by `acg-quorum-compare-witnesses` and `acg-quorum-assemble-witness` in `verify-local-gates`; a real codespace+host grid corroborates in committed evidence, re-derived by `acg-quorum-live-corroboration`. |
| LBA-REQ-025 | The system shall block consumption of a release artifact until its corroboration attestation chain verifies. | An unattested or tampered artifact must not be installed on the strength of a verdict alone; verifying the signed chain before consumption closes that gap (ADR-0016). | Each witness signs its receipt bundle (sigstore keyless where an OIDC identity exists, an enrolled key otherwise); the aggregated verdict, the release artifacts, and the human sign-off are attested and stored on the Release, in the repo, in a transparency log, and on the mesh ledger; a standalone verify tool and the reviewer-workstation install both verify the chain before install. | The verify-before-consume engine (`experiments/acg-provenance/attest.mjs`, self-test 10/10) is delivered, and the real enrolled-key chain is proven on the live grid -- the codespace and host each signed their own bundle, and verify-before-consume yields consume:true, re-derived by `acg-provenance-verify-before-consume`; the reviewer-workstation verify-before-install (LBA-REQ-031), the offline Merkle transparency log, and the mesh ledger have since shipped, and the sigstore-keyless + public-rekor tier is wired in `.github/workflows/acg-keyless-attest.yml` (cosign keyless sign-blob under an Actions OIDC identity, gated by `acg-keyless-attest-workflow-wired`); the provenance is now stored on the immutable prerelease `acg-attest-v0.0.2` (keyless-signed `.sigstore` bundle attached at creation; run 30703064254 -> public rekor logIndex 2312189991), completing all four storage locations. |
| LBA-REQ-026 | The system shall reject a corroboration quorum whose witnesses do not span distinct enrolled environments. | N identical nodes are not N independent witnesses; requiring distinct enrolled environments prevents one actor from forging agreement with look-alike witnesses (ADR-0017). | A valid quorum spans distinct enrolled environments; a non-enrolled witness or one that duplicates an already-counted environment does not count toward the majority, and each counted witness's identity is recorded in the provenance. | The witness-independence engine (`experiments/acg-independence/independence.mjs`, self-test 9/9) counts a witness only if its plane/os environment is enrolled, its identity is recorded, and it does not duplicate an already-counted environment; gated by `acg-independence-quorum`, and the committed live grid is independent with recorded identities, re-derived by `acg-independence-live`. |
| LBA-REQ-027 | The system shall block a corroborated release from publishing until a recorded human sign-off accompanies the machine quorum verdict. | Machine corroboration establishes reproducibility, but a human still judges whether the result looks correct; requiring a recorded sign-off alongside the quorum keeps that judgment explicit and un-skippable (ADR-0018). | The human visual gate runs on either the Windows reviewer VM or a zero-install Linux browser codespace; a release publishes only when the machine quorum passes and the signed human sign-off is recorded, and the sign-off does not substitute for the quorum. | The sign-off gate (`experiments/acg-reviewer/sign-off.mjs`, self-test 10/10) blocks publish until a recorded, enrolled, approving Ed25519 human sign-off (from either station) accompanies the exact passing machine-quorum verdict; gated by `acg-reviewer-sign-off`, with the real corroborated release shown BLOCKED pending sign-off (`acg-reviewer-release-decision`). |
| LBA-REQ-028 | The system shall beacon each witness's corroboration verdict over the lbabus coordination mesh. | Verdicts already travel the bus via the gate-suite beacon, so collecting each witness's outcome over the existing mesh gives a live, distributed view without a new transport (ADR-0019). | Each witness joins the lbabus mesh and beacons its verdict (reusing the gate-suite verdict beacon and the mesh topology); a mesh ledger records the beaconed verdicts and feeds the provenance store. | The mesh verdict beacon (`experiments/acg-mesh/verdict-beacon.mjs`, self-test 8/8 incl. a real bus-msg@1 wire round-trip) builds a comms-only verdict NOTE + a tamper-evident MeshLedger and resolves beaconed witnesses to the quorum; gated by `acg-mesh-verdict-beacon`, with the live loopback proof (real {codespace, host} verdicts beaconed over 127.0.0.1 TCP -> ledger -> quorum pass) re-derived by `acg-mesh-loopback-evidence`. |
| LBA-REQ-029 | The system shall expose the corroboration grid's operations to agents through the Model Context Protocol tool surface. | Agents already consume actor tools through the MCP server (ADR-0012), so exposing the grid's operations on the same surface lets an agent orchestrate corroboration directly rather than through bespoke commands (ADR-0020). | The ADR-0012 MCP surface gains grid tools (`spin_up_witness`, `run_quorum`, `get_confidence`, `verify_attestation`, `teardown`); the surface is designed now and implemented in a later phase. | The ACG MCP surface (`experiments/acg-mcp/grid-tools.mjs` + `server.mjs`) exposes the grid tools over the same dependency-free JSON-RPC 2.0 contract as the ADR-0012 server; run_quorum/get_confidence/verify_attestation/check_independence/assemble_witness compose the engines, `verify_inclusion`/`verify_before_install` verify transparency-log inclusion (ADR-0022), and spin_up_witness/teardown return provisioning plans. Self-test 13/13 incl. a spawned stdio round-trip (initialize/tools/list/tools/call), gated by `acg-mcp-grid-surface`. |
| LBA-REQ-030 | The system shall require every non-release pull request to target the develop integration branch. | GitFlow makes develop the integration branch (ADR-0010), but stale main-based pull requests (#211 / #215 / #217) dumped integration content onto the release branch because no rule stated where feature work targets; codifying the base-branch rule prevents that class of error (ADR-0021). | Every non-release pull request targets develop; main receives only release/hotfix merges via a no-fast-forward merge; a pull request found on the wrong base is re-targeted or closed rather than merged. | The base-branch guard (`experiments/acg-governance/pr-base-branch-guard.mjs`, self-test 11/11) blocks any non-release head targeting main (develop and feature/authoring included), and the `.github/workflows/pr-base-branch-guard.yml` workflow enforces it on PRs targeting main; gated by `acg-governance-pr-base-branch` and `acg-governance-pr-base-branch-workflow-wired`. |
| LBA-REQ-031 | The system shall admit a component release for installation only after its corroboration attestation is proven included in the signed transparency log. | Provenance that lives only beside a verdict can be silently dropped or forged; recording each witness attestation in an append-only, Ed25519-signed Merkle transparency log makes an unattested or un-logged release refusable before install, with tamper-evident inclusion proofs (ADR-0022, extends ADR-0016). | Each witness attestation is a leaf in a signed Merkle log using RFC 6962 domain-separated hashing; the reviewer-workstation install plus a standalone verifier admit a release only when at least the quorum minimum of enrolled-witness attestations each carry an inclusion proof against the signed tree head; any missing or tampered proof blocks the install. | The transparency log `experiments/acg-transparency/transparency-log.mjs` (RFC 6962 inclusion + consistency + Ed25519 signed tree heads, self-test 26/26, gated by `acg-transparency-log`) records the real {codespace, host} attestations under one signed head (`acg-transparency-log-live`); the verifier `experiments/acg-transparency/verify-release-inclusion.mjs` admits the real bundle plus blocks a tampered one (`acg-transparency-verify-before-install`), wired fail-closed into `reviewer-workstation/provision.ps1` before the .vsix install (`acg-transparency-verify-before-install-wired`). |
| LBA-REQ-032 | The system shall calibrate a stress-ladder performance-signature curve from repeated per-rung benchmark signatures so an observed signature maps to an inferred stress level within the calibrated tolerance band. | The mesh-stress program re-verifies the maximum drop-free streaming ceiling under a stressed actor mesh (mesh-stress-signature@v1); calibrating each actor's 42-counter performance signature across a stress ladder turns raw per-actor counters into a monotone, separable, repeatable stress read for later ladder testing (design #272, builds on performance-counter-correlation@v2). | The signature extractor derives per-counter features (mean/std/percentiles/drift/periodicity) plus across-repeat stability (signature vs noise) plus MAD outliers plus cross-counter outlier co-occurrence from repeated runs; the calibration-curve fitter maps each per-rung signature to an expected value plus tolerance band, scores the monotone/separable/repeatable invariants, drops non-tracking features, and inverse-reads an observed signature to an inferred rung with a confidence; the stress orchestrator emits the monotone commanded ladder (per-actor VirtualBox throttle plus host/guest stress-ng) pinning each actor to a distinct level. | Run `node experiments/mesh-stress-signature/signatureExtractor.selftest.mjs` (5/5), `calibrationCurveFitter.selftest.mjs` (4/4), and `stressOrchestrator.selftest.mjs` (5/5); gated by `mesh-stress-signature-extractor` / `mesh-stress-signature-calibrator` / `mesh-stress-orchestrator` in `verify-local-gates`. |
| LBA-REQ-033 | The system shall provision a from-scratch Ubuntu 24.04 golden VM with activated LabVIEW 2026 Community Edition plus VIPM, confirming the activation with a headless probe VI before registering the VM as a mesh actor. | The single biggest gap is that a community member cannot yet get a reproducible LabVIEW benchmark environment from scratch; a one-command Ubuntu provisioner with functional activation confirmation and a locally-minted personal golden VM unlocks the Linux plane and community onboarding (ADR-0023, builds on the Windows golden box). | `lba init` provisions Ubuntu 24.04 Noble, installs `ni-labview-2026-community` plus `vipm` from the NI apt repo, and after the interactive activation a headless `LabVIEWCLI` `RunVI` probe emits an `activation-receipt@1` whose success gates minting the local golden VM plus its `mesh-actors.csv` registration; the confirmation is deterministically replayable offline from a committed receipt. | Proven: `lba init` (`scripts/lba.mjs`) composes the six First Win flow steps from their Proven slices; `firstWinOnboarding.mjs` gates that every step resolves to a committed realization and that activation was confirmed live on `lba-golden`. Run `node experiments/first-win/verify-first-win-onboarding.selftest.mjs` (7/7); gated by `first-win-onboarding`; tracked as T-033. |
| LBA-REQ-034 | The system shall keep the bounded ISO/IEC/IEEE 26514 information-for-users product set complete and command-covering, so a fail-closed gate blocks the build when a required user-information item is missing or a contributed command is undocumented. | The standards audit found user information was the repo's weakest, non-gated surface (a single user guide, no audience/task/navigation/reference), and non-gated conformance is where documentation drifts from the product; gating the bounded 26514 product set keeps user information current by construction (ADR-0024). | `verify-information-for-users.mjs` checks the 10 required items exist and are non-trivial, the command reference covers every `package.json` contributed command, the conformance boundary states a bounded product claim and disclaims full process conformance, and the navigation hub indexes the set; the self-test also proves an empty set fails closed. | Run `node experiments/information-for-users/verify-information-for-users.selftest.mjs` (2/2); gated by `information-for-users-26514` in `verify-local-gates`. |
| LBA-REQ-035 | The system shall generate the test report and configuration status-accounting record from the verification apparatus, so a fail-closed gate blocks the build when the committed record drifts from the gates, correspondence rules, requirements, and decisions it accounts for. | A deeper clause-level standards audit found the repo kept a test *plan* but no executed test *report* (ISO/IEC/IEEE 29119-3) and no *configuration status-accounting* record (ISO 10007); outcomes and controlled state were never governed information items. Generating them from the very apparatus CI enforces keeps them current by construction (ADR-0025). | `generate-test-report.mjs` derives the 29119-2 completion criteria, the fail-closed gate inventory, the correspondence rules, the coverage floors, and the requirement / ADR / test-item status accounting into `docs/testing/test-report.md`; `--check` fails closed on drift. | Run `node experiments/reqs-coverage/generate-test-report.selftest.mjs` (4/4); gated by `test-report-current` in `verify-local-gates`. |
| LBA-REQ-036 | The system shall keep the ISO/IEC/IEEE 15289 release procedure resolvable and invariant-complete, so a fail-closed gate blocks the build when the procedure cites a workflow or script that does not resolve or omits a required release invariant. | A deeper clause-level audit found the repo had a 12207 move/transition procedure but no *release* procedure information item; the signed, corroborated release flow was scattered across the CM plan's branch governance and the corroboration-grid requirements. A procedure that could silently cite a renamed workflow would mislead a releaser, so it is gated to stay resolvable by construction (ADR-0026). | `docs/release/release-procedure.md` gives the step-by-step signed, corroborated release; `verify-release-procedure.mjs` asserts every cited workflow/script/action path resolves and every required release invariant is named, failing closed otherwise. | Run `node experiments/release/verify-release-procedure.selftest.mjs` (3/3); gated by `release-procedure-references-resolve` in `verify-local-gates`. |
| LBA-REQ-037 | The system shall self-audit its five-lens standards posture at clause-evidence granularity, so a fail-closed gate blocks the build when any lens drops below its target score or a required information item, wired gate, or clause anchor is missing. | The standards audit's meta-finding (F4) was that non-gated conformance is where standards drift silently, and the coarse 25/25 was a point-in-time score rather than a continuously-verified guarantee. A generated, fail-closed self-audit that re-scores the repo against the repo-standards-review five-lens rubric on every change makes full compliance corroborated by construction (ADR-0027). | `verify-compliance-posture.mjs` encodes each lens's level-5 clause-evidence (real information items + wired gates + clause anchors) and scores REQ/ARCH/TEST/CM/DOC into `docs/compliance/compliance-posture.md`; `--check` fails closed below 25/25 or on scorecard drift. | Run `node experiments/compliance/verify-compliance-posture.selftest.mjs` (4/4); gated by `continuous-compliance-self-audit` in `verify-local-gates`. |
| LBA-REQ-038 | The system shall confirm LabVIEW activation with a headless known-answer probe VI, so a fail-closed gate refuses an install whose activation receipt does not show the probe executed and returned the known answer. | ADR-0023's onboarding hinges on confirming activation before minting a personal golden VM, and license-file parsing is brittle for Community Edition; a functional probe (`LabVIEWCLI RunVI` on the shipped `AddTwoNumbers.vi`) that must return the known answer is the robust signal and doubles as the benchmark-execution path. First delivered slice of the Planned LBA-REQ-033 umbrella, proven live on the reference host's activated LabVIEW 2026. | `probe-activation.sh` runs `LabVIEWCLI RunVI` headless (Xvfb) on the known-answer probe; `buildActivationReceipt.mjs` builds a deterministic `activation-receipt@1` (digest over verdict-bearing fields), and validation denies activation on a non-zero exit, wrong value, missing success line, or tampered receipt. The committed REAL capture replays offline in CI. | Run `node experiments/activation/buildActivationReceipt.selftest.mjs` (5/5); gated by `activation-receipt-confirms-activation` in `verify-local-gates`. |
| LBA-REQ-039 | The system shall register a golden VM as a mesh actor only after its activation receipt confirms LabVIEW is activated, so a fail-closed gate refuses registration for an unconfirmed or tampered receipt. | ADR-0023's onboarding invariant is that activation is confirmed before a VM joins the mesh; binding registration to the LBA-REQ-038 activation receipt enforces that an unactivated box cannot be enrolled as a benchmark actor — confirmation and enrollment are one fail-closed chain. | `registerGoldenActor` validates the `activation-receipt@1` (schema, digest, verdict) and only then composes the golden `mesh-actors.csv` row (idempotent by role+actor_id); an unactivated or tampered receipt is refused and the registry is left untouched. | Run `node experiments/activation/registerMeshActor.selftest.mjs` (4/4); gated by `mesh-actor-registration-requires-activation` in `verify-local-gates`. |
| LBA-REQ-040 | The system shall distribute an independent-task workload across a budget-capped pool of ripgrep-only instances proportional to each instance's capacity, so a fail-closed gate proves the shards ran disjointly on distinct instances with every task passing. | The North Star is on-demand distributed benchmark runs across planes with no central aggregation (docs/roadmap.md); a capacity-weighted executor that dynamically discovers a budget-capped pool (host + codespaces + local VMs) and runs disjoint shards concurrently — every instance searching with ripgrep only — is the first distributed-execution primitive and spreads load off the host (ADR-0028). | `discoverPool` enumerates host + codespaces + running VMs up to a conservative budget (default host + 2 remote); `capacityWeightedPartition` splits proportional to static per-type weights; per-type SSH adapters run the shards concurrently; `validateReceipt` fails closed unless the split re-derives disjoint distinct-instance rg-only shards with every task passing. | Run `node experiments/parallel/verify-parallel-workload.selftest.mjs` (4/4); gated by `distributed-parallel-workload` in `verify-local-gates`. Live: 42 self-tests split 25/9/8 across three instances. |
| LBA-REQ-041 | The system shall route each distributed task only to an instance advertising the capability the task requires, so a fail-closed gate proves every task ran on a capability-matching instance. | The distributed executor (ADR-0028) is heterogeneous, but LabVIEW lives only on capable instances (the host and LabVIEW VMs) — a VI task sent to a node-only codespace would fail. Capability-aware routing sends each task only where it can run (ADR-0029, operator directive). | `routeByCapability` groups tasks by required capability and capacity-weight-splits each group across only the advertising instances (throws if none can); host advertises `labview` iff LabVIEWCLI present, codespaces `node` only; `validateRouting` fails closed unless every task ran capability-matched, the re-route reproduces the shards, disjoint + covered + distinct + rg-only + all passed. | Run `node experiments/parallel/verify-capability-routing.selftest.mjs` (5/5); gated by `capability-aware-routing` in `verify-local-gates`. Live: LabVIEW probe -> host, 43 node tasks across 3 instances. |
| LBA-REQ-042 | The system shall confirm cross-plane LabVIEW liveness by running the known-answer activation probe on every LabVIEW plane, so a fail-closed gate proves at least two independent LabVIEW planes are activated and operational. | Real cross-plane comparison (the North Star) needs more than one activated LabVIEW plane; the capability router (ADR-0029) now reaches the host plus a LabVIEW VM (the Phase 1 golden VM, ADR-0023). Running the known-answer probe on each plane and asserting the answer proves independent, activated, operational planes to compare across (ADR-0030). | `runCrossPlaneLiveness.mjs` discovers LabVIEW planes (host + running VMs answering `ls LabVIEWCLI` over ssh), runs `LabVIEWCLI RunVI` on each concurrently; `validateLiveness` fails closed unless >= 2 distinct planes each returned the known answer and are activated. | Run `node experiments/activation/verify-cross-plane-liveness.selftest.mjs` (4/4); gated by `cross-plane-labview-liveness` in `verify-local-gates`. Live: host + Ubuntu golden VM, both LabVIEW 2026, 7+5=12. |
| LBA-REQ-043 | The system shall verify cross-plane benchmark determinism by comparing the same VI Analyzer config's deterministic resultHash across every LabVIEW plane, so a fail-closed gate proves the planes agree. | Cross-plane liveness (ADR-0030) proved >= 2 activated planes; the North Star is objective, reproducible cross-plane COMPARISON. LBA-REQ-015's resultHash is machine-independent, so running the same config on each plane and matching the hashes proves benchmark equivalence, not a subjective claim (ADR-0031). | `runCrossPlaneViAnalyzer.mjs` runs the shipped LabVIEWCLIExampleProject on each LabVIEW plane concurrently, computes each resultHash via `summarizeViAnalyzerReport` (LBA-REQ-015); `validateComparison` fails closed unless >= 2 distinct planes carry an identical resultHash. | Run `node experiments/vi-analyzer/verify-cross-plane-comparison.selftest.mjs` (4/4); gated by `cross-plane-vi-analyzer-determinism`. Live: host + Ubuntu golden VM, 69 tests, byte-identical resultHash. |
| LBA-REQ-044 | The system shall provision the from-scratch Ubuntu golden VM with both LabVIEW 2026 Community and VIPM, so a fail-closed gate blocks the build when the provisioner omits either install. | ADR-0023's golden VM is Ubuntu + LabVIEW + VIPM, but the provisioner installed only LabVIEW (NI apt repo); VIPM is a standalone JKI .deb, not in the NI repo. Adding the VIPM install completes the golden-VM automation and a gate keeps both present (advances ADR-0023 Phase 1). | `provision-guest.sh` installs `ni-labview-2026-community` (NI apt, committed key) + VIPM from `packages.jki.net` (dpkg -i + apt-get install -f, idempotent via a `dpkg -s vipm` guard); `checkProvisioner` fails closed unless both steps are present and the live receipt confirms VIPM. | Run `node experiments/provisioner/verify-provisioner-labview-vipm.selftest.mjs` (4/4); gated by `provisioner-installs-labview-and-vipm`. Live: VIPM 26.3.1-4000 installed on the scratch VM. |
| LBA-REQ-045 | The system shall provide a human-assisted terminal bridge to the golden VM that lets an automation agent drive the VM's interactive shell while a human types any password or token directly on the VM, so a fail-closed gate proves credentials never transit the agent. | Agent-driven golden-VM onboarding (ADR-0023) needs secrets -- LabVIEW and VIPM activation, sudo -- that must never pass through the agent or the model; a shared tmux session on the VM lets the agent drive while the human supplies credentials in-band, at the prompt (ADR-0032). | `tools/vm-bridge/vm-bridge.sh` is a shared tmux session on the VM; the agent drives via tmux send-keys/capture-pane over ssh (run/send/keys/read), `secret?` detects a credential prompt to hand off, `attach` prints the human's one-line attach; `checkVmBridge` fails closed unless the bridge is secret-safe (no --password/read -s/sshpass) and the receipt shows the agent detected but never answered a prompt. | Run `node experiments/vm-bridge/verify-vm-bridge.selftest.mjs` (4/4); gated by `vm-bridge-human-assisted-secret-safety`. Live: agent drove the scratch VM; a real `password:` prompt was detected (exit 42) + handed off, never answered. |
| LBA-REQ-046 | The system shall prove VIPM functionally installs a LabVIEW community package into the golden VM's LabVIEW package library, so a fail-closed gate blocks the claim unless the operator-designated self-test package installed cleanly with its files landing in vi.lib. | LBA-REQ-044 proves the provisioner installs the VIPM tool; the golden VM is "Ubuntu + LabVIEW + VIPM" (ADR-0023) only once VIPM WORKS to install a package. The operator designated g-cli (`wiresmith_technology_lib_g_cli`) as the VIPM self-test; installing it exercises real dependency resolution. | The operator installed g-cli via VIPM Desktop (Community Edition) on lba-golden; `validateVipmInstallReceipt` fails closed unless every package installed cleanly (No Errors, > 0 files), vi.lib gained files, the designated package is present, and the verdict-bearing digest is intact. | Run `node experiments/vipm-install/verify-vipm-package-install.selftest.mjs` (8/8); gated by `vipm-functional-package-install`. Live: VIPM 26.3.1-4000 installed g-cli 3.0.1.98 + deps -> 279 files in vi.lib. |
| LBA-REQ-047 | The system shall stream the golden VM live status and analyze a captured timeline for idle spans, so a fail-closed gate proves the committed idle-time analysis is correctly derived from the samples. | The human-assisted golden-VM workflow has long stretches of "dead time" invisible to both human and agent (e.g. LabVIEW idle while VIPM silently waits to connect); a live monitor plus a deterministic idle-time analysis surface and quantify that dead time (advances ADR-0023 Phase 1). | `vm-live-status.sh` streams overall CPU busy% + LabVIEW cpu/mem + vipm/Xvfb over the bridge and captures NDJSON series; `vmStatusAnalysis.mjs` derives idle vs busy spans, idle%, longest idle run; `validateStatusTimelineReceipt` fails closed unless the committed analysis re-derives from the samples and the digest is intact. | Run `node experiments/vm-live-status/verify-vm-live-status.selftest.mjs` (7/7); gated by `vm-live-status-idle-analysis`. Live: 44s capture on lba-golden, 63.6% idle, longest idle run 18s. |
| LBA-REQ-048 | The system shall benchmark the golden VM by mass-compiling the public icon-editor source with LabVIEWCLI, so a fail-closed gate proves the committed benchmark result is correctly derived and cross-plane comparable. | The golden VM exists to run objective, reproducible benchmarks (the North Star cross-plane comparison); a MassCompile of a pinned public source (ni/labview-icon-editor) is a real LabVIEW workload whose machine-independent result (VI count + bad count + success) is comparable across planes, with the compile time as the performance metric. Replaces the deferred VI Analyzer benchmark. | `LabVIEWCLI -OperationName MassCompile` compiles the icon-editor `resource/` source headless-as-actor; `massCompileBenchmark.mjs` records the result + a timing-invariant resultHash; `validateMassCompileReceipt` fails closed unless the resultHash re-derives, the verdict matches, the bad-VI list is consistent, and the digest is intact. | Run `node experiments/mass-compile/verify-mass-compile-benchmark.selftest.mjs` (7/7); gated by `mass-compile-benchmark`. Live: MassCompile of icon-editor resource/ on lba-golden = 307 VIs/CTLs, 0 bad, succeeded, 24s. |
| LBA-REQ-049 | The system shall verify the golden-VM provisioner installs every headless-LabVIEW prerequisite -- Xvfb, VI Server (TCP 3363) configuration for both LabVIEW executable basenames, quoted access lists, and the post-install reboot -- so a fail-closed gate proves a fresh one-command provision yields a headless-benchmark-ready VM. | The First Win is a one-command golden VM, but a fresh provision was NOT headless-ready until three fixes were applied by hand during bring-up (Xvfb, VI Server config for both `labview.conf` and `labviewcommunity.conf`, a post-install reboot); folding those into `provision-guest.sh` and gating the provisioner's completeness keeps that hard-won knowledge from silently regressing. | `provision-guest.sh` installs Xvfb, writes the VI Server config into both exe-basename config files with quoted access lists, and addresses the reboot; `provisionerReadiness.mjs` validates the committed receipt against the ACTUAL script text and fails closed if any prerequisite is missing, the ready verdict is forged, or the digest is tampered. | Run `node experiments/provisioner-readiness/verify-provisioner-readiness.selftest.mjs` (7/7); gated by `provisioner-headless-readiness`. Live: the hardened `provision-guest.sh` satisfies all 6 headless-readiness checks. |
| LBA-REQ-050 | The system shall unify the golden-VM LabVIEW benchmarks into a cross-plane grid that records, per benchmark, the machine-independent identity on each plane and the performance metric, so a fail-closed gate proves identities agree across planes and no determinism violation is admitted. | The golden VM exists to enable objective, reproducible cross-plane comparison (the North Star); a single generated grid that shows every benchmark's identity agreement across planes plus its performance is the artifact that comparison is for, and gating it fail-closed makes a cross-plane determinism violation impossible to merge. | `benchmarkGrid.mjs` assembles the committed per-benchmark cross-plane receipts into `cross-plane-benchmark-grid@1`, deriving per-benchmark identity agreement + consensus and rendering `docs/benchmarks/benchmark-grid.md`; `validateBenchmarkGrid` fails closed on a benchmark whose planes disagree, a forged agreement/verdict, or a tampered digest. | Run `node experiments/benchmark-grid/verify-benchmark-grid.selftest.mjs` (7/7); gated by `cross-plane-benchmark-grid`. Live: VI Analyzer (host + scratch VM) resultHash 0419a449; Mass Compile icon-editor resource/ resultHash bf722123 agrees across the OS axis -- host + lba-golden VM (Linux) + win-VITLT-SERGIO (Windows LabVIEW 2026), 3/3 planes; compile 39s host / 24s VM / 211s Windows. |
| LBA-REQ-051 | The system shall build the ni/labview-icon-editor Editor Packed Library inside the NI LabVIEW container as a benchmark, so a fail-closed gate proves the committed build result is correctly derived and cross-plane comparable. | The operator-directed 2-actor icon-editor grid reproduces the project's real CI (one actor builds the PPL, one runs the LUnit tests); the builder is the icon-editor's own Editor Packed Library build spec, which native LabVIEWCLI ExecuteBuildSpec runs in the NI LabVIEW container (nationalinstruments/labview:2026q1-linux) where LabVIEW is licensed + headless -- no g-cli required for the build. | `LabVIEWCLI -OperationName ExecuteBuildSpec` builds the Editor Packed Library from lv_icon_editor.lvproj -> lv_icon.lvlibp; `pplBuildBenchmark.mjs` records the machine-independent build identity + build time; `validatePplReceipt` fails closed unless the resultHash re-derives, the verdict matches, and the digest is intact. | Run `node experiments/ppl-build/verify-ppl-build-benchmark.selftest.mjs` (7/7); gated by `ppl-build-benchmark`. Live: the NI container built lv_icon.lvlibp (2.9 MB) from icon-editor @9545c48 in 59s, succeeded. |
| LBA-REQ-052 | The system shall build the g-cli launcher from its Rust source and prove it on this host, so a fail-closed gate confirms the committed round-trip is correctly derived and cross-plane comparable. | The 2-actor icon-editor grid's TESTER actor drives LUnit via g-cli; on Linux g-cli ships no prebuilt binary -- its launcher is the rust-proxy crate (G-CLI/G-CLI) that opens a TCP server, launches LabVIEW on the target VI, and streams args/output/exit code back. Building it from source and proving a real LabVIEW round-trip is the enabler for that actor. | `cargo build --release` builds the `g-cli` binary; `gcliProxyBenchmark.mjs` records the machine-independent proof identity (tool + version + source commit + operation + args in + echoed text + exit code + LabVIEW version/bitness); `validateGcliReceipt` fails closed unless the echo matches the args sent, the resultHash re-derives, the verdict matches, and the digest is intact. | Run `node experiments/g-cli-proxy/verify-g-cli-proxy-proof.selftest.mjs` (7/7); gated by `g-cli-proxy-proof`. Live: g-cli 3.0.1 built from Rust in 6.7s, then drove host LabVIEW 2026 (headless) to echo hello/from/host and exit 0. |
| LBA-REQ-053 | The system shall run the ni/labview-icon-editor LUnit suite via g-cli as a benchmark, so a fail-closed gate proves the committed test inventory is correctly derived and cross-plane comparable. | This is the TESTER actor of the 2-actor icon-editor grid (companion to the builder, LBA-REQ-051): the Rust-built g-cli (LBA-REQ-052) runs the project's real unit tests, with the LUnit framework from the CORRECT icon-editor-developer.vipc (NOT the CI-runner runner_dependencies.vipc). | `g-cli --lv-ver 2026 --arch 64 lunit -- -r <report.xml> lv_icon_editor.lvproj` discovers + runs the project's LUnit classes and emits a JUnit report; `lunitTestBenchmark.mjs` records the machine-independent test inventory (sorted class/case set + suite structure); `validateLunitReceipt` fails closed unless the inventory matches the total, the resultHash re-derives, the verdict matches, and the digest is intact. | Run `node experiments/lunit-test/verify-lunit-test-benchmark.selftest.mjs` (7/7); gated by `lunit-test-benchmark`. Live: g-cli lunit ran the suite on lba-golden -- 4 classes / 25 cases (10 passed, 2 failed, 8 errored headless, 5 setup), well-formed report. |
| LBA-REQ-054 | The system shall assemble every committed benchmark receipt into a benchmark-type x plane coverage matrix (the Benchmark Observatory), so a fail-closed gate proves the suite-wide determinism ledger and coverage are correctly derived. | As the suite grows along its axes (benchmark type x plane x OS x hardware), one governed artifact must map what has been measured where, whether it reproduces, and what to measure next -- above the per-benchmark grid. | `benchmarkObservatory.mjs` folds the VI Analyzer + Mass Compile + PPL build + LUnit test receipts into a coverage matrix + determinism ledger + frontier; `validateObservatory` fails closed on a determinism violation, a matrix that contradicts the receipts, a forged verdict, or a tampered digest; the generated `docs/benchmarks/benchmark-observatory.md` is drift-gated. | Run `node experiments/benchmark-observatory/verify-benchmark-observatory.selftest.mjs` (8/8); gated by `benchmark-observatory`. Derived: 4 benchmark types x 5 planes, 2 cross-plane-proven, 0 violations, 13-cell frontier. |
| LBA-REQ-055 | The system shall emit a machine-readable capture-status beacon for each LabVIEW-launch capture (capturing -> stopped/failed), so a fail-closed gate proves the rich stop payload (wroteToDisk, peak write throughput + its frame, per-disk breakdown) is correctly derived and an agent can await a human-in-the-loop step. | The reviewer/agentic flow has human-in-the-loop steps (run a VI, then Stop the capture); without a signal the agent guesses or re-asks. A capture-status beacon makes the human's Stop an awaited, machine-observable event that also carries a pointer straight to the evidence. | `captureStatus.mjs` derives the beacon (wroteToDisk thresholded, peak write MB/s + the frame index where it peaked, per-physical-disk peaks) from the capture's samples; the extension writes `capture-status.json` at capture start (capturing) + stop (stopped) or assembly failure (failed); `reviewer-workstation/await-handoff.sh` polls it; `validateCaptureStatus` fails closed on a bad schema/state/missing payload. | Run `node experiments/handoff-beacon/captureStatus.selftest.mjs` (6/6); gated by `handoff-capture-status`. Live: the operator's streaming VI produced a stopped beacon (wroteToDisk=true, peak 134 MB/s @ frame 1122) the agent's poll resolved. |
| LBA-REQ-056 | The system shall surface an agent's request for a human step as an in-VM VS Code notification whose "Mark step done" / "Skip" actions emit a machine-readable op-done beacon, so a fail-closed gate proves the request/answer payloads are correctly derived and the agent can await a human-in-the-loop step it initiated. | The capture-status beacon (LBA-REQ-055) let the agent AWAIT a human step; the agent's own ASK ("run this VI", "activate LabVIEW") was invisible except via chat, so it re-asked. Making the ask a first-class, in-VM, machine-observable event (a reusable human-step barrier) lets the agent request a manual step and resume when the human answers. | `handoffRequest.mjs` derives `agent-request@1` + `op-done@1` (validated fail-closed) + `selectPendingRequest` (newest unanswered); the extension watches `handoff/requests/` and surfaces the ask as a notification with "Mark step done" (optional note) / "Skip" -- also palette commands -- writing `handoff/done/<id>.json`; `reviewer-workstation/request-step.sh` drops the request + polls the answer ONCE. | Run `node experiments/handoff-beacon/handoffRequest.selftest.mjs` (5/5); gated by `handoff-request`. Live: the agent asked the human in the reviewer VM + resumed on the op-done beacon. |
| LBA-REQ-057 | The system shall emit a signed reviewer visual verdict (`reviewer-verdict@1` mapping to `acg-human-signoff-v1`) for an extension release candidate, so a fail-closed gate proves the human's PASS/FAIL of the built candidate is Ed25519-signed by an enrolled reviewer and gates the release alongside the plane agreement. | The reviewer VM exists for the human's VISUAL PASS/FAIL of a candidate; that verdict was informal (chat / a hand-edited signoff). Making it a signed, candidate-bound artifact turns the human gate into a governed, verifiable release input, signable IN the VM (enrolled Ed25519 needs no OIDC). | `reviewerVerdict.mjs` (dependency-free, staged) builds + Ed25519-signs the verdict IN the VM; `gateVisualReview` publishes only on a pass + verified enrolled approvals; `release-with-review.mjs` composes it with the ADR-0018 machine gate; `verify-visual-review.mjs` gates a release's visualReview block; CI keyless-cosign counter-signs. | Run `node experiments/handoff-beacon/reviewerVerdict.selftest.mjs` (6/6); gated by `handoff-verdict`. Live: the reviewer signs a pass verdict for ext 0.5.0 in the VM that verifies against the enrolled allowlist. |
| LBA-REQ-058 | The system shall announce a signed reviewer verdict on the `lbabus` coordination bus with a semantic message type (pass -> RESOLVED, changes -> REFINE, fail -> BLOCKED) carrying the full signed verdict, so a fail-closed gate proves the announcement is correctly derived and remote actors see the human's PASS/FAIL. | The reviewer's signed verdict (LBA-REQ-057) stayed local; the `lbabus` bus is how the planes coordinate, so a remote actor could not see that a human reviewed + PASSED a candidate. Announcing it makes the verdict a coordination event. | `buildVerdictBusPost` derives the semantic `lbabus` post (type/task/ref/priority) from a signed verdict record; the extension posts it from the VM after signing (best-effort) + the release CI posts it after `verify-visual-review`; the full signed verdict JSON is the message body. | Run `node experiments/handoff-beacon/reviewerVerdict.selftest.mjs` (7/7); gated by `handoff-verdict`. Live: the ext 0.5.0 PASS verdict maps to a RESOLVED post on the extension-release-0.5.0 task. |
| LBA-REQ-059 | The system shall close the host<->VM-agent coordination loop over the `lbabus net` TCP bus -- after driving the reviewer VM's Copilot agent, the host awaits the agent's reply frame correlated by task id (fail-closed on mismatch/timeout) and the signed reviewer verdict announces with a semantic net type (RESOLVED/REFINE/BLOCKED), so a fail-closed gate proves the read-back + the semantic types are correctly derived and coordination rides TCP, not a GitHub Discussion. | `drive-agent-chat.sh` drove the VM's chat fire-and-screenshot with no programmatic read-back, and the verdict announcement (LBA-REQ-058) rode a GitHub Discussion; an operator directive moves coordination onto the private TCP bus (`lbabus net`, LBA-REQ-007) and deprecates Discussions. | `await-agent-reply.mjs` runs `lbabus net listen` + correlates the VM agent's reply by task/type (fail-closed); `drive-agent-closed-loop.sh` composes inject (`drive-agent-chat.sh`) + await; the net type set gains RESOLVED/REFINE/BLOCKED (option A); guest->host proven in `provider-delegation/vm-run-evidence.json`. | Run `node reviewer-workstation/await-agent-reply.selftest.mjs` (7/7); gated by `closed-loop-readback`. Live: 3 drives from the reviewer VM (senderId WIN) -- loop, benchmark review (2604 ms/5 PASS), verdict RESOLVED -- all over TCP. |
| LBA-REQ-060 | The system shall provide a live-only net coordination read side -- a per-actor local receive-log written by `lbabus net listen --log` and read by `lbabus net poll` (filtered by type/task; fail-closed without a log) -- so a fail-closed gate proves post->log->poll round-trips over TCP and coordination reads no longer depend on a GitHub Discussion. | ADR-0039 moved the host<->VM-agent loop + verdict announcement onto net; an operator directive moves the REST of coordination off Discussions with a LIVE-ONLY model (no async store). The send side (`net send`) existed; the read side was missing. | `net listen --log <file>` appends received frames to a per-actor JSONL receive-log; `net poll` reads + filters it (BusWire.ToJson/FromJson); no central/async store -- an offline peer misses the frame (accepted). | Run `bash experiments/net-coordination/net-coordination-log-proof.sh`; gated by `net-coordination-log` (committed loopback receipt + Net.cs source). Loopback: post->log->poll round-trip + type filter + poll-without-log fails closed. |
| LBA-REQ-061 | The system shall let the extension select the coordination-bus transport -- GitHub Discussion (default) or the live-only `lbabus net` TCP bus (opt-in via busTransport/busNetHosts/busNetLog) -- so postNote/pollBus/the reviewer-verdict announcement ride `net send`/`net poll` when configured, and a fail-closed gate proves the switch + the Discussion-safe default. | ADR-0040 gave net a live-only model; the extension still shelled the GitHub-Discussion post/poll. Step 2 lets it select the transport WITHOUT breaking existing users (Discussion stays default). | `busConfig` reads the settings; `busSendArgs` builds the net send argv; postNote->net send, pollBus->net poll, the verdict->net send --message-file under net; Discussion default keeps busPostArgs/post + poll. | Extension tests (busSendArgs + activation) in test/extension-activation.mjs; gated by `bus-transport-select` (source + package.json config assertion; Discussion default). |
| LBA-REQ-062 | The system shall let the extension's MCP coordination tools select the transport -- the provider passes the bus-transport config as env (VIHS_COLLAB_TRANSPORT/NET_HOSTS/NET_LOG) and the stdio server routes poll_coordination_bus/post_coordination_note to `net poll`/`net send` under net (Discussion default) -- so the agent tool surface coordinates over TCP when configured, proven by a fail-closed gate. | ADR-0041 migrated the extension commands; the MCP server (a separate stdio process) still shelled the Discussion poll/post. | `busEnvFromConfig` maps busTransport/busNetHosts/busNetLog -> env on the McpStdioServerDefinition; `pollBusArgs`/`postNoteArgs` route to net poll/send under net; Discussion default keeps poll/post. | test/mcp-server.mjs (busEnvFromConfig + stdio tools); gated by `mcp-net-transport` (src/mcp source assertion). |
| LBA-REQ-063 | The system shall let the reviewer-workstation verdict announcer (post-verdict.mjs) select the transport -- GitHub Discussion (default) or the live-only lbabus net TCP bus (opt-in via VIHS_COLLAB_TRANSPORT/NET_HOSTS) -- so a signed verdict announces via `net send` with the same semantic type when configured, and a fail-closed gate proves the argv under both transports. | ADR-0041/0042 migrated the extension + MCP; post-verdict.mjs (used by the release CI + by hand) still built only the Discussion post argv. | post-verdict.mjs reads VIHS_COLLAB_TRANSPORT/NET_HOSTS: net -> `net send --hosts --type --task --message-file`, else `post` (unchanged); --print-args honors it so the release CI is unchanged at the default. | Gated by `post-verdict-net-transport` (runs --print-args under both transports + asserts the argv). |
| LBA-REQ-064 | The system shall NOT announce the reviewer verdict to a GitHub Discussion from the release publish workflow -- the durable record of the human PASS is the committed signed verdict (release-agreement visualReview, keyless counter-signed); under the live-only net model CI has no bus peer -- so a fail-closed gate proves the publish workflow carries no GitHub-Discussion announce. | ADR-0038 had the release CI announce the verdict to a GitHub Discussion; under live-only (ADR-0040) CI has no net peer + the committed verdict is already durable, so the CI announce is dropped. | The Set up .NET + Announce steps are removed from extension-release.yml; the committed verdict (staged + keyless counter-signed) is the durable record; off-CI live announce stays via post-verdict.mjs/extension over net. | Gated by `release-no-discussion-announce` (the workflow carries no dotnet-run-LbaBus / announce step + keeps the keyless counter-sign). |
| LBA-REQ-065 | The system shall default the coordination-bus transport to the live-only `lbabus net` TCP bus (GitHub Discussion becomes a legacy opt-out) AND degrade gracefully when net is unconfigured -- `net poll` with no receive-log and `net send --skip-if-no-peer` with no peer both exit 0 with a hint (no error, no dead loopback) -- so a fresh install coordinates over TCP once a peer/log is set and does nothing quietly until then, proven by a gate. | Steps 1-5 (ADR-0040..0044) made net available everywhere but kept Discussion the default (opt-in net) during the transition; with the net loop proven live (ADR-0039) the last thing pinning Discussion is inertia. Flipping naively would error/hang an unconfigured install, so the flip is paired with a graceful no-op. | busTransport defaults to net across the extension/MCP/post-verdict; `net poll` no-log softened from fail-closed to graceful (exit 0); the send side passes --skip-if-no-peer so `net send` with no peer exits 0; Discussion is `busTransport: discussion` / VIHS_COLLAB_TRANSPORT=discussion. | npm test (extension + MCP default flip) + the net-coordination-log receipt (graceful poll); gated by `net-default-graceful` (Net.cs graceful branches + net default in package.json/extension) + `bus-transport-select` (default === 'net'). |
| LBA-REQ-066 | The system shall coordinate over the live-only `lbabus net` TCP bus ONLY across its product surface (the extension commands + the MCP coordination tools + the reviewer verdict announcer) -- the GitHub-Discussion transport opt-out is removed (no `busTransport` selection, no consumer builds a Discussion `post`/`poll` argv) -- so a fail-closed gate proves the product surface is net-only. | Steps 1-6 (ADR-0040..0045) made net the default with Discussion a legacy opt-out, but the product still carried the Discussion arms (busPostArgs, the busTransport selection, VIHS_COLLAB_TRANSPORT, the post/--priority branch). With net proven + default, the opt-out is dead weight on the surface users + agents touch. | Removed the busTransport setting; busConfig returns {netHosts,netLog}; pollBus->net poll, postNote/verdict->net send unconditionally; busEnvFromConfig maps only NET_HOSTS/NET_LOG; post-verdict.mjs is net send only. The graceful no-op (--skip-if-no-peer / net poll exit 0) is preserved. | npm test (extension + MCP net-only) + gates `bus-transport-select`/`mcp-net-transport`/`post-verdict-net-transport` (now net-only) + `net-default-graceful`. |
| LBA-REQ-067 | The system shall NOT expose a GitHub-Discussion coordination transport from the `lbabus` CLI -- the `init`/`post`/`poll`/`wait`/`delta` subcommands and the GraphQL Discussion client are removed (GitHubGraphQL keeps only the REST release-tag + issue-comment calls for `selfcheck`/`defect`), leaving the live-only `lbabus net` TCP bus as the sole coordination transport -- so a fail-closed gate proves the CLI carries no Discussion transport. | Step 7 (ADR-0046) made the product net-only, leaving the CLI's Discussion commands dead. Removing them + the GraphQL client completes the off-Discussions teardown; GitHubGraphQL was shared with selfcheck (release tags) + defect (issue comment), which stay on REST. | Program.cs drops init/post/poll/wait/delta + EnforceVersionOrNull + ParseAll/SeedBody/Eq/Dur; GitHubGraphQL is REST-only; Config drops Category/Title/AgentId/Counterpart/AddressesMe; the 12 discussion/version-guard ci cases are retired. | dotnet build + a CLI smoke test (removed cmds exit 1; net intact); gated by `cli-no-discussion-transport`. |
| LBA-REQ-068 | The system shall record, as a committed fail-closed receipt, that the host drove the reviewer VM's Copilot agent to run the RELEASED net-only `lbabus` (collab-cli 0.15.0, pulled from the immutable `collab-cli-v0.15.0` release) and the VM reported task-correlated results back over the `lbabus net` TCP bus -- the sole coordination path, since the released CLI rejects the retired `init`/`post`/`poll`/`wait`/`delta` Discussion commands -- so a fail-closed gate proves the end-to-end net-only drive loop is reproducible off any GitHub-Discussion dependency. | LBA-REQ-059 proved the read-back CORRELATION while the CLI still shipped the Discussion transport; the off-Discussions migration then completed (LBA-REQ-060..067) and collab-cli 0.15.0 shipped net-only, and the host drove the VM to install + validate that released binary over net -- proven live but ungoverned (receipts in /tmp). | A pure rg-free verifier (`net-only-live-drive.mjs`: schema + digest + build + validate) seals the real drives (senderId WIN) + the released-CLI net-only proof (collab-cli-v0.15.0 rejects init/post/poll/wait/delta, observed on the VM) into a committed receipt; the digest + verdict re-derive deterministically at gate time. | `node reviewer-workstation/net-only-live-drive.selftest.mjs` (7/7) + the committed receipt (digest re-derivation via the verifier main); gated by `net-only-live-drive`. |
| LBA-REQ-069 | The system shall record, as a committed fail-closed receipt, that ONE release-with-review loop is bound to a single candidate over the net-only bus -- the reviewer VM staged the candidate over `lbabus net`, a human Ed25519-signed a visual PASS/FAIL of THAT candidate (component/version/commit/vsixSha256), and the signed verdict announced over `net` with its semantic type -- so a fail-closed gate proves the staged, signed, and announced candidate are the SAME (no stage-one / sign-another / announce-a-third). | LBA-REQ-068 (stage over net), LBA-REQ-057 (signed visual verdict), and LBA-REQ-058 (bus announce) were each proven in isolation; nothing bound them to one candidate in one loop, so the staging, the signed verdict, and the announce could drift apart. `gateReleaseWithReview` composes visual review with the MACHINE gate, not with a net-staged candidate. | A pure rg-free verifier (`release-with-review-drive.mjs`) REUSES verifyReviewerVerdict/gateVisualReview/buildVerdictBusPost + adds the binding (staged WIN drive <-> verdict target <-> derived announce), sealing one real round (ext 0.5.0 staged over net, signed PASS, announced RESOLVED) into a committed receipt; the digest + verdict re-derive deterministically. | `node reviewer-workstation/release-with-review-drive.selftest.mjs` (7/7) + the committed receipt (binding + digest via the verifier main); gated by `release-with-review-drive`. |
| LBA-REQ-070 | The system shall record, as a committed fail-closed receipt, that a release candidate publishes ONLY when BOTH the machine corroboration gate (a quorum verdict + an enrolled sign-off over it, ADR-0018) AND the human visual gate (an enrolled signed PASS of the built candidate, LBA-REQ-057) pass, AND both name the SAME net-staged candidate (LBA-REQ-068/069) -- so a fail-closed gate proves the machine quorum, the human visual verdict, and the net stage all name one candidate (no machine-PASS-A + human-PASS-B). | `gateReleaseWithReview` already ANDs the machine + visual gates, but ANDs two INDEPENDENT decisions -- nothing checks that the machine quorum consensus, the visual verdict target, and the net-staged candidate are the SAME candidate, so a machine PASS of A could be published with a human PASS of B. | A pure rg-free verifier (`composite-release-decision.mjs`) REUSES gateReleaseWithReview + adds the cross-gate binding (quorum consensus.version/sourceCommit == candidate == visual target, staged over net by a WIN drive); seals one real round (ext 0.5.0: passing quorum + enrolled sign-off + signed visual PASS + net stage) into a committed receipt; digest + verdict re-derive deterministically. | `node reviewer-workstation/composite-release-decision.selftest.mjs` (7/7) + the committed receipt (both gates + binding + digest via the verifier main); gated by `composite-release-decision`. |
| LBA-REQ-071 | The extension release workflow shall block publishing a `.vsix` unless a committed composite release-decision proves BOTH gates pass for the tagged candidate version -- the `agreement` job runs `verify-composite-release.mjs` (fail-closed) and the publish `release` job depends on `agreement` -- so no extension release publishes without the bound composite decision (LBA-REQ-070). | LBA-REQ-070/ADR-0051 GOVERNED the composite decision as a committed receipt + a CI gate, but that only proved the pattern in the local-gate suite; nothing BLOCKED a real publish. extension-release.yml already enforces the plane agreement + the human visual verdict in its agreement job (release needs agreement); the composite decision was not yet in that chain. | `verify-composite-release.mjs` REUSES the gated composite `validateReceipt` to require the committed receipt to name the tagged candidate + be proven (exit 0 clear / 1 fail-closed); the extension-release.yml agreement job runs it after verify-visual-review; the release job `needs: [build, agreement]`. | The gate `composite-release-enforced` asserts (offline) the CLI clears ext 0.5.0 + fails closed for a version with no decision, and that extension-release.yml wires the CLI in the publish-gating agreement job. |
| LBA-REQ-072 | The system shall prove that a Linux and a Windows launch-to-ready benchmark receipt measure the SAME benchmark via a machine-independent launch identity (metric + workload + sample count) -- so their plane-specific timings are legitimately comparable -- and a fail-closed gate rejects an identity mismatch, a non-cross-plane pair, or a tampered receipt. | Cross-plane PARITY is governed for deterministic benchmarks whose value is plane-independent (mprr seriesHash LBA-REQ-014; VI Analyzer resultHash LBA-REQ-015/043), but the flagship exact-12-FPS launch-to-ready benchmark measures a plane-DEPENDENT quantity (~2604 ms Linux vs ~2410 ms Windows), so there is no identical series to anchor -- today's launch cross-plane receipts compare timing deltas as witnesses, proving nothing about whether the two planes ran the SAME benchmark. | `launchParity.mjs` anchors on the launch SPEC (`launchIdentity` = sha256 over metric + workload + n), records the plane-specific timing (mean/delta/faster-plane) as witnesses, and seals a committed `cross-plane-launch-parity-receipt@1` derived from the real committed launch trends; the gate re-derives it + checks it reflects the real trend means. | `node experiments/launch-parity/launchParity.selftest.mjs` (7/7) + the committed receipt (identity + digest via the verifier main, grounded in the committed fixtures experiments/launch-parity/fixtures/{linux,win}-launch-trend.json); gated by `cross-plane-launch-parity`. |
| LBA-REQ-073 | The system shall prove fulfillment of a DISPATCHED cross-plane benchmark run by validating that >= N distinct enrolled mesh actors from the requested planes each returned a valid plane-tagged receipt for the SAME benchmark identity -- so a fail-closed gate proves the mesh run was fulfilled by enough independent cross-plane actors, with no central results database (the returned receipts ARE the result). | The North Star is an actor mesh where a requester dispatches a cross-plane benchmark + independent volunteer golden-VM actors return plane-tagged receipts. The pieces exist (mesh-actor registration LBA-REQ-039; provider-delegation CLAIM/ACK/DONE LBA-REQ-018; cross-plane launch identity LBA-REQ-072) but nothing composed them into a FULFILLMENT proof -- the roadmap Phase 3 / section-8 mesh metric. | `meshFulfillment.mjs` REUSES the LBA-REQ-072 launch identity as the cross-actor agreement invariant + seals a committed `mesh-run-fulfillment-receipt@1`: a dispatched labview-ide-launch run fulfilled by 2 golden-VM actors (golden-linux LINUX + golden-win WIN) each returning its real plane-tagged launch-trend receipt. | `node experiments/mesh-fulfillment/meshFulfillment.selftest.mjs` (7/7) + the committed receipt (fulfillment + identity agreement + digest via the verifier main); gated by `mesh-run-cross-plane-fulfillment`. |
| LBA-REQ-074 | The system shall dispatch a cross-plane benchmark run GitHub-natively via a `repository_dispatch` event carrying a validated `mesh-run-dispatch@1` request bound to its fulfillment, and gate the returned receipts on cross-plane fulfillment -- so a fail-closed gate proves the dispatch->fulfill loop is wired with no central server (the repo IS the queue). | LBA-REQ-073 governs mesh-run FULFILLMENT, but the GitHub-native DISPATCH transport did not exist -- no repository_dispatch workflow, no committed dispatch-request contract binding a dispatch to its fulfillment (the roadmap Phase 3 GitHub-native queue). | `meshDispatch.mjs` validates a `mesh-run-dispatch@1` request (benchmarkId + spec + minActors + planes + dispatchId, carrying the LBA-REQ-072 identity) fail-closed; `.github/workflows/mesh-run.yml` triggers on `repository_dispatch[mesh-run]`, validates the dispatch, then gates `meshFulfillment`; the committed request binds to the LBA-REQ-073 fulfillment (same identity). | `node experiments/mesh-fulfillment/meshDispatch.selftest.mjs` (7/7) + the committed request (via the CLI) + the dispatch<->fulfillment binding + the mesh-run.yml wiring; gated by `mesh-run-dispatch-wired`. |
| LBA-REQ-075 | The system shall fold the governed mesh-run receipts (dispatch, fulfillment, cross-plane parity) into a coverage matrix + a consistency ledger -- which benchmarks x which planes x how many actors fulfilled, and whether each run's dispatch/fulfillment/parity name the SAME identity -- so a fail-closed gate proves the operator-facing mesh dashboard reflects the receipts it summarizes. | The mesh dispatch->fulfill loop is closed (LBA-REQ-072/073/074) but those receipts are three separate artifacts with no single governed view of which benchmarks are fulfilled, across which planes, by how many actors -- the roadmap Phase 3->4 cross-plane-comparison-at-scale dashboard (the benchmark observatory LBA-REQ-054 is the single-plane precedent). | `meshObservatory.mjs` folds the committed dispatch + fulfillment + parity receipts into a `mesh-coverage-observatory@1` matrix + ledger, re-derived byte-stably from the source receipts (currency) + grounded in the real fulfillment (identity + actors + planes). | `node experiments/mesh-fulfillment/meshObservatory.selftest.mjs` (7/7) + the committed observatory (via the CLI) + the re-fold currency + the grounding; gated by `mesh-coverage-observatory`. |
| LBA-REQ-076 | The system shall expand a validated mesh-run dispatch into per-plane actor tasking and validate the returned-receipt collection that feeds fulfillment, both identity-bound to the dispatch -- so a fail-closed gate proves every collected receipt provably descends from the dispatched tasks and ran the SAME benchmark. | The mesh dispatch->fulfill loop is governed at its ends (LBA-REQ-074 dispatch + LBA-REQ-073 fulfillment) but the MIDDLE -- how a dispatch tasks actors + how their receipts are collected -- was ungoverned, so an assembled receipt set could bypass the fan-out. The roadmap live fan-out needs an identity-bound tasking + collection contract. | `meshFanout.mjs` derives an `actor-tasking@1` set from the dispatch (one identity-bound task per requested plane) + validates a `receipt-collection@1` mapping returned receipts back to tasks; the committed tasking re-derives from the dispatch + the collection reconstructs the committed LBA-REQ-073 fulfillment; `.github/workflows/mesh-run.yml` runs the fan-out step. | `node experiments/mesh-fulfillment/meshFanout.selftest.mjs` (7/7) + the committed tasking + collection (via the CLI) + the tasking currency + the fulfillment reconstruction + the mesh-run.yml wiring; gated by `mesh-live-fanout-wired`. |
| LBA-REQ-077 | The system shall admit a returned mesh-actor receipt into a verified collection only when it carries a valid attestation from its declared, enrolled actor -- so a fail-closed gate proves each collected receipt provably came from a REAL enrolled actor (not a fabricated trend). | The fan-out (LBA-REQ-076) proves a receipt is identity-bound + structurally valid but not that it came from a real enrolled actor -- a rogue participant could fabricate a plausible trend. A public volunteer mesh needs each receipt cryptographically bound to the enrolled actor that produced it; the ADR-0016 enrolled-key engine already exists to reuse. | `meshVerifiedTier.mjs` REUSES acg-provenance `signBundle`/`verifyWitnessAttestation` (Ed25519, ADR-0016): each returned receipt is signed by the actor's enrolled key, and a `verified-receipt-collection@1` admits it only when the attestation verifies against the enrolled `mesh-actor-keys.json` allowlist; the committed verified collection re-verifies its attestations offline. | `node experiments/mesh-fulfillment/meshVerifiedTier.selftest.mjs` (7/7) + the committed verified collection (via the CLI) + every collected receipt attested by its declared enrolled actor + the mesh-run.yml wiring; gated by `mesh-verified-tier-attested`. |
| LBA-REQ-078 | The system shall admit a verified mesh-actor attestation only when it carries an inclusion proof against a transparency-log tree head signed by the enrolled log key -- so a fail-closed gate proves the mesh receipts are enrolled-signed AND publicly auditable (append-only, tamper-evident). | The verified tier (LBA-REQ-077) binds a receipt to its enrolled actor, but the set of attestations is not publicly auditable -- a compromised key could sign + nothing records the attestations in an append-only log. Release provenance already solved this (the ADR-0022 signed Merkle transparency log); the mesh should reuse it. | `meshTransparency.mjs` REUSES the acg-transparency engine (`recordRelease`/`verifyReleaseInclusion`, RFC-6962): each verified-tier attestation is recorded into a signed Merkle tree, and a `logged-verified-collection@1` admits it only when its inclusion proof reconstructs the enrolled-key-signed tree head; the committed logged collection re-verifies offline. | `node experiments/mesh-fulfillment/meshTransparency.selftest.mjs` (7/7) + the committed logged collection (via the CLI) + the signed tree head + every inclusion proof + the mesh-run.yml wiring; gated by `mesh-attestations-transparency-logged`. |

---

### LBA-REQ-001: Standalone extraction of hooking and agentic infrastructure

- Status: Proposed
- Area: Packaging
- Statement: The hooking and agentic infrastructure currently developed on
  `vi-history-suite` `develop`/`prototype` shall be packaged as a **standalone
  VS Code extension** (`labview-benchmark-actor`) with no build- or run-time
  dependency on `vi-history-suite` internals.
- Acceptance Criteria:
  - The extension builds, packages (`.vsix`), and activates without any
    `vi-history-suite`-private module on its dependency graph.
  - Shared logic reused from `vi-history-suite` is vendored or published as an
    explicit dependency with a pinned version, not referenced by relative path.
  - The extracted surface is enumerated (a manifest of moved modules) so the
    origin in `vi-history-suite` can be retired or redirected deterministically.
- Change Guidance: Prefer a clean dependency boundary over a fork; record the
  moved-module manifest in the CM plan.

### LBA-REQ-002: Install on Codespace or Vagrant golden VM

- Status: Proposed
- Area: Deployment
- Statement: The extension shall install and activate on **(a)** a GitHub
  Codespace and **(b)** a Vagrant "golden" VM, from the same published artifact.
- Acceptance Criteria:
  - A documented install route produces an activated extension on a Codespace
    with no manual host-specific patching.
  - The same artifact installs on a Vagrant golden VM provisioned from a
    recorded base image, and activation is confirmed by a first-run signal.
  - Host prerequisites (LabVIEW runtime, container runtime, ports) are stated
    per target and checked at activation with actionable remediation.
- Change Guidance: Keep the golden-VM provisioning declarative and versioned so
  the benchmarking baseline is reproducible.

### LBA-REQ-003: Agentic infrastructure drives benchmark runs

- Status: Proposed
- Area: Benchmarking
- Statement: The extension shall expose the agentic infrastructure as the
  driver for **benchmark runs**, producing a time-series of metrics and a
  time-indexed sequence of captured pictures (frames) for each run.
- Acceptance Criteria:
  - A benchmark run emits a schema-versioned result containing (i) an ordered
    metric time-series and (ii) an ordered set of captured pictures, each
    stamped with a monotonic run-relative timestamp.
  - Metric samples and captured pictures share one run clock so any time can be
    resolved to both a metric value and the nearest picture.
  - A run is reproducible: the same inputs and golden VM produce an
    equivalently-shaped result (bounded numeric variance is allowed and
    documented).
  - Captured pictures are recorded into the VM-local **mprr ring buffer**
    (long-packet stream) and indexed via the short-packet stream; the
    run-result frame `ref` points at that local store, never at bytes carried
    over the coordination bus (LBA-REQ-009, ADR-0005).
- Change Guidance: Treat the run-result schema as the contract between the
  actor and the viewer; version it explicitly. Frame payloads are stored via
  mprr, not embedded in the envelope. mprr's short-packet analysis summary
  already yields the ordered timeline (`timingTicks64` + `frameId` +
  `payloadDescriptorId`) this contract needs — confirmed by a headless live
  capture (see `experiments/mprr-live-capture/`).

### LBA-REQ-004: Benchmark time-cursor (draggable vertical line)

- Status: Proposed
- Area: User Interface
- Statement: The benchmark viewer shall render the metric time-series with a
  **draggable vertical cursor** spanning the chart's Y extent; dragging it
  left↔right shall select a point on the time (X) axis.
- Acceptance Criteria:
  - The cursor is draggable with pointer and keyboard (arrow keys step by one
    sample; Home/End jump to run start/end).
  - The selected time is displayed numerically and stays within the run's time
    bounds (no selection outside the recorded window).
  - Dragging is smooth (the cursor tracks input without a full re-render) and
    the selected time updates continuously during the drag.
- Change Guidance: The cursor position is the single source of truth for the
  linked picture panel (LBA-REQ-005); keep them bound to one selected-time
  value.

### LBA-REQ-005: Time-indexed picture shown below the benchmark

- Status: Proposed
- Area: User Interface
- Statement: Directly below the benchmark chart, the viewer shall display the
  **captured picture indexed at the cursor's selected time**, updating as the
  cursor moves.
- Acceptance Criteria:
  - The picture shown is the frame whose timestamp is nearest at-or-before the
    selected time (documented nearest-rule), with its index and timestamp
    labeled.
  - When the cursor moves, the picture updates to the newly-indexed frame
    without desynchronizing from the cursor's selected time.
  - If no picture exists at/near the selected time, the panel shows an explicit
    "no frame at this time" state rather than a stale image.
  - The displayed picture is read from the **VM-local mprr review-capture
    store** (the cleanroom), not fetched over the coordination bus
    (LBA-REQ-009, ADR-0005).
- Change Guidance: Index pictures by run-relative timestamp so cursor→picture
  resolution is O(log n) and deterministic. mprr's short-packet stream already
  supplies this index as `timingTicks64` (100 ns timing authority) keyed to
  `frameId`/`payloadDescriptorId`; a live capture confirmed the resolve path
  end-to-end (see `experiments/mprr-live-capture/`).

### LBA-REQ-006: Multi-VM Vagrant benchmarking topology

- Status: Proposed
- Area: Deployment
- Statement: The system shall support **multiple Vagrant VMs spawned
  concurrently**, each running the extension, participating in one benchmarking
  session.
- Acceptance Criteria:
  - A declarative topology spawns N VMs, each provisioned with the extension
    activated and a unique participant identity.
  - Each VM runs benchmarks independently and stores its results in its **own
    local mprr ring buffer**; VMs do **not** compare runs across each other and
    exchange **no run data** — only inter-actor coordination crosses the bus
    (LBA-REQ-007, LBA-REQ-010).
  - VM teardown is clean and leaves no orphaned bus listeners or lock state.
- Change Guidance: Keep participant identity and topology declarative so a
  session is reproducible and auditable.

### LBA-REQ-007: TCP/UDP coordination bus (replaces GitHub Discussion)

- Status: Proposed
- Area: Coordination Transport
- Statement: Cross-VM coordination shall use a **local TCP and UDP message
  bus** in place of a GitHub Discussion, so benchmarking runs without external
  network or GitHub availability.
- Acceptance Criteria:
  - Reliable, ordered coordination messages (claims, handoffs, results) use
    **TCP**; low-latency presence/liveness and time-sync beacons use **UDP**.
  - Messages are schema-versioned and carry sender identity, timestamp, and a
    session id; a late-joining VM can reconstruct current session state.
  - The bus degrades safely: a lost UDP beacon does not corrupt TCP-ordered
    state, and a dropped TCP peer is detected and surfaced.
  - No coordination path depends on `github.com` or a Discussion at run time.
  - The bus carries **inter-actor communication only** (claim / handoff / ack /
    done / progress / note) — the GitHub-Discussion replacement. It carries
    **no run data, run/frame metadata, or images**; the entire mprr ring buffer
    stays VM-local (LBA-REQ-009, ADR-0005).
- Change Guidance: Mirror the semantics of the GitHub-Discussion collab bus
  (claim / handoff / ack / done, check-before-publish) so the coordination model
  is preserved while the transport changes. `[Assumption]` bind to loopback or
  the private Vagrant network by default; do not expose the bus publicly.

### LBA-REQ-008: Standards-baseline stamp and move-readiness

- Status: Proposed
- Area: Configuration Management
- Statement: This specification package shall carry the `repo-standards-review`
  release it was authored against, and shall be structured to **move** to the
  `labview-benchmark-actor` repository without losing traceability.
- Acceptance Criteria:
  - The package overview and CM plan both name `repo-standards-review`
    **v0.2.19** (commit `d44f210d`).
  - The `docs/` lane layout matches the standards runner's expected structure
    (requirements, architecture, testing, cm, information-for-users, plus the
    information-item map).
  - Requirement IDs are stable across the move (no renumbering on relocation).
- Change Guidance: If the baseline bumps, update the stamp in `README.md` and
  `docs/cm/cm-plan.md` together and re-run the standards validation.

### LBA-REQ-009: VM cleanroom image storage via the mprr ring buffer

- Status: Proposed
- Area: Storage / Capture
- Statement: Captured pictures shall be stored **locally within each VM
  (a cleanroom)** using the existing **mprr** ring buffer, as metadata-indexed
  payload, and shall not be transported over the coordination bus.
- Acceptance Criteria:
  - Pictures are written to the VM-local mprr **long-packet** ring buffer;
    their index/timestamp is written to the **short-packet** stream, per mprr's
    governed dual-packet buffering policy (mprr ADR-0024).
  - The mprr ring buffer (short **and** long packet) stays entirely VM-local;
    **nothing from it is sent over the coordination bus**, which is inter-actor
    communication only (LBA-REQ-007). Runs are not correlated across VMs.
  - The mprr ring buffer model is **owned in-repo** (absorbed dependency-free
    under `experiments/mprr-ring/`, ADR-0009), retaining the frozen
    TDMS-compatible `1.0` replay contract as design lineage; the ring buffer,
    transport, and buffering policy are reused from that self-owned model, not
    re-implemented and not tracked as an external `svelderrainruiz/mprr`
    dependency.
  - `[Confirmed 2026-07-27]` a benchmark frame maps onto exactly one mprr
    long-packet payload: a headless dual-packet live capture (mprr `develop`,
    .NET 8) produced 20/20 frames, each `frameId` bracketed by short-packet
    `frame-start`/`frame-end` and joined to one long-packet payload via
    `payloadDescriptorId`, all `correlationOutcome=authoritative`,
    `driftClass=none` (see `experiments/mprr-live-capture/`).
- Change Guidance: Treat the absorbed mprr model as the authority for the ring
  buffer and replay transport; a schema move requires a successor ADR here
  (ADR-0005, ADR-0009) before this contract can move.

### LBA-REQ-010: Own-run review, host concentration, and the ollama comparison layer

- Status: Proposed
- Area: Analysis
- Statement: Each actor shall review only its **own** previous runs; completed
  runs shall be **concentrated onto the operator's host** out-of-band (not over
  the coordination bus) to feed an **ollama-based comparison layer** that
  compares previous runs.
- Acceptance Criteria:
  - The time-cursor viewer (LBA-REQ-004/005) operates over the **local** actor's
    own run history; there is **no cross-VM run comparison** and no run data on
    the bus.
  - Completed runs are collected from each VM cleanroom to the operator's host
    by an explicit concentration step (e.g. exporting/mounting the VM's mprr
    review-capture store), **never** over the coordination bus.
  - A host-side **ollama** layer compares previous runs (metrics and frames)
    over the concentrated corpus to improve the analysis; it runs on the
    operator's machine, not inside an actor VM.
  - `[Open]` the concentration mechanism and the ollama layer's I/O contract are
    follow-ups (ADR-0006).
- Change Guidance: Keep coordination (bus) and run data (VM-local + host
  concentration) strictly separate; the bus is never a run-data channel.

### LBA-REQ-011: CPU/RAM/disk usage correlation with a pre/post-trigger window

- Status: Proposed
- Area: Analysis / Resource correlation
- Statement: The system shall correlate **CPU, RAM, and disk** usage samples to
  the benchmark **frame timeline** on a shared epoch-ms / frame axis and, anchored
  on a **trigger** instant (e.g. the LabVIEW Getting-Started-Window-visible frame
  or the benchmark-start marker), shall compute a **pre/post-trigger window
  analysis** — count, mean, min, max and the post-minus-pre delta — for each
  metric.
- Acceptance Criteria:
  - Every resource sample resolves to a frame index (floor of elapsed / frame
    interval; null before frame zero, never clamped), matching the frame-index
    rule the picture-cursor viewer uses (LBA-REQ-005).
  - The trigger instant resolves to a `triggerFrameIndex`, and each sample is
    classified `pre` or `post` relative to it, with `sinceTriggerMs` recorded.
  - Per metric (CPU %, RAM MB, disk %) a pre-window and a post-window summary
    (count, mean, min, max) and a `deltaMean = post.mean − pre.mean` are emitted;
    a sample whose counter was absent (null) is skipped in that metric's summary.
  - The core is pure and deterministic (no I/O, no capture dependency) so the
    local gate re-validates it: `[Confirmed 2026-07-28]` the self-test is 9/9
    green over a canonical series with a Getting-Started-Window-visible trigger at
    frame 12 (see `experiments/resource-usage-correlation/`).
- Change Guidance: Sampling (typeperf / logman / Get-Counter) and the live
  Getting-Started-Window capture live in the capture harness (the maintainer / VM
  step); keep this module pure so it stays a re-runnable gate artifact.

---

### LBA-REQ-012: Version-pinned agent base instructions

- Status: Proposed
- Area: Agentic infrastructure (extends LBA-REQ-001, LBA-REQ-003)
- Statement: The system shall embed a canonical agent base-instructions document
  (`AGENTS.md`) in the `lbabus` binary and expose it via `lbabus agents`
  (print / `--out <path>` / `--check <path>`), so that every session using a
  given `lbabus` version shares byte-identical base instructions that can be
  hardened version-over-version.
- Acceptance Criteria:
  - The instructions are embedded in the versioned binary; `lbabus agents`
    prints them with a `sha256`-stamped, version-tagged header.
  - `--out <path>` materializes them to a known file location; `--check <path>`
    exits non-zero when a local copy has drifted from the embedded canonical.
  - The `ci-agents` release-harness stage gates the embed round-trip and the
    drift detection, so every published version's instructions are verified.
- Change Guidance: Iterate the source in `tools/collab-cli/agents/AGENTS.md` and
  cut a new release; do not hand-edit materialized copies.

---

### LBA-REQ-013: Prioritized, addressable coordination messages

- Status: Superseded (ADR-0048 -- retired with the GitHub-Discussion transport, off-Discussions step 8b)
- Area: Agentic infrastructure (extends LBA-REQ-007, LBA-REQ-012)
- Supersession: RETIRED. This capability -- message priority triage (`P0`-`P3`, `--min-priority`) + plane
  addressing (`--to`/`--to-me`) -- lived entirely in the GitHub-Discussion transport's `lbabus post`/`poll`/`wait`
  commands + the `CollabMessage`/`Priority` model, all removed under the off-Discussions migration (ADR-0040
  live-only net, ADR-0047 CLI transport removal). Under the live-only `lbabus net` TCP model there is no async
  inbox to triage (messages are live + point-to-point) and `net send --hosts` already targets a specific peer,
  so priority + plane-addressing are moot; the net `BusEnvelope` (`bus-msg@1`) deliberately carries neither.
  Operator decision 2026-08-03 (retire, option B). A future net-envelope priority/addressing feature would be a
  NEW requirement, not a revival of this one.
- Historical statement (no longer implemented): The coordination bus shall let a sender tag a message with a
  priority tier and an explicit addressee, and shall let a reader filter its inbox by both. It was implemented
  via `lbabus post --priority`/`--to` + `poll`/`wait --min-priority`/`--to-me` over the additive, flat-scalar,
  back-read-compatible `vihs-collab-msg@v1` envelope (verified cross-plane, finding 17812593).
- Change Guidance: retired -- do not re-add priority/addressing to the removed Discussion path. If wanted on
  `net`, govern it as a new requirement + ADR on the `bus-msg@1` envelope.

### LBA-REQ-014: Cross-plane benchmark comparison

- Status: Proven
- Area: Analysis / storage (extends LBA-REQ-009 storage, LBA-REQ-004 viewer,
  LBA-REQ-010 analysis)
- Statement: The system shall let each plane (LINUX, WIN) produce a
  deterministic benchmark run from the SAME mprr short-packet input, store it on
  a plane-local big drive, and compare the two planes' runs of a shared
  `benchmarkId` -- reporting numeric metric deltas AND content-digest agreement,
  so the next agent can repeat the comparison and get the same verdict.
- Acceptance Criteria:
  - The absorbed mprr short-ring core (`ingestShortPackets`) deterministically
    projects a short-packet stream to a viewer-renderable `[{ t, v }]` series +
    a benchmark summary (blocks, boundary-variation, admission), byte-identical
    for identical input on BOTH planes (the deterministic cross-plane anchor).
  - The shipped viewer renders that series; the deterministic screenshot harness
    captures it twice and asserts BYTE-IDENTICAL per plane (repeatability),
    recording `seriesHash` + `pngSha256`.
  - The benchmark store registers each plane's run (ring-buffer capture BY
    REFERENCE) under a shared `benchmarkId`, and `crossPlaneCompare` reports
    numeric `deltas` + a `digests` section: the deterministic `seriesHash` MUST
    match across planes; the per-plane `pngSha256` is a visual witness; a
    single-plane compare fails closed.
  - The comparison is re-runnable and deterministic (mprr core + projection +
    store are dependency-free): gated by `verify-mprr-ring` (9/9),
    `verify-benchmark-store` (6/6), and local gates #27/#28.
- Change Guidance: Keep the mprr core + projection deterministic and
  dependency-free -- the cross-plane anchor rests on a byte-identical
  `seriesHash`. Treat a cross-OS screenshot pixel difference as an expected
  witness, not a failure. Proven 2026-07-31: a REAL second-plane (WIN) Node run
  (win32/x64, Node v22.15.0, on `actor-win11-decouple` over WinRM) independently
  produced the identical `seriesHash` `7ad1c75d...`, and `crossPlaneCompare`
  confirms the match with all metric deltas 0 (`cross-plane-comparison-receipt.json`,
  gate `cross-plane-comparison-proven-green`). The prior identical-to-LINUX WIN
  `pngSha256` was a synthetic placeholder and has been removed; the per-plane WIN
  screenshot visual witness remains a maintainer step (browser, non-CI).

### LBA-REQ-015: VI Analyzer as a cross-plane benchmark

- Status: Proven
- Area: Analysis / quality (extends LBA-REQ-014; operator VI-Analyzer directive)
- Statement: The system shall install the LabVIEW VI Analyzer Toolkit in the
  Windows clean room and summarize a VI Analyzer run over a repo's VIs into a
  deterministic, ORDER-INDEPENDENT result (per-run pass/fail/error counts + the
  enumerated per-VI findings + a resultHash), so a VI Analyzer run becomes a
  cross-plane-comparable benchmark: two planes summarizing the same run produce
  the same resultHash.
- Acceptance Criteria:
  - The Windows docker clean room installs the VI Analyzer toolkit license
    (`ni-labview-vi-analyzer-toolkit-lic`) from the LabVIEW offline feed,
    enabling `LabVIEWCLI -OperationName RunVIAnalyzer`
    (`cleanroom/docker-windows/install-vi-analyzer.ps1`; Vagrant-reusable).
  - The REAL `LabVIEWCLI RunVIAnalyzer` report (ASCII/HTML) is FAILURE-ORIENTED:
    it emits a run summary of counts and enumerates ONLY the failures + testing
    errors per VI -- passes are never listed. So the normalized report is the
    faithful shape `{ config?, summary: { passed, failed, error, skipped?,
    unloadable? }, findings: [{ viPath, test, result: fail|error }] }`; a clean
    all-pass run (e.g. the icon-editor CI gate) is the summary counts with an
    EMPTY findings array.
  - `summarizeViAnalyzerReport()` normalizes that report to
    `{ totalTests, passedTests, failedTests, errorTests, skippedTests,
    unloadableTests, totalFindings, findingsByVi, pass, resultHash }`; the
    `resultHash` is deterministic, ORDER-INDEPENDENT, and LOCALE-INDEPENDENT
    (code-unit canonical order over the counts + sorted findings), so an
    identical report produces an identical `resultHash` on both planes.
    Consistency teeth: the fail/error findings counts MUST equal the summary
    failed/error counts.
  - A committed JSON Schema (`vi-analyzer-report.schema.json`) + a dependency-free
    validator (`validate-vi-analyzer-report.mjs`, the producing plane's pre-send
    self-check) lock the normalized-report input contract; a reference ASCII->v2
    parser (`parse-vi-analyzer-ascii.mjs`) turns the real CLI report into it.
  - The summary projects to benchmark-store metrics (numeric counts + the
    `resultHash` digest), so `crossPlaneCompare` reports count deltas + the
    `resultHash` agreement (the `resultHash` MUST match cross-plane).
  - The REAL run is proven cross-plane by the CI OS matrix: the committed real
    report (`experiments/vi-analyzer/icon-editor-report.json`, WIN's attested
    all-pass icon-editor run) is pinned by local gate
    `vi-analyzer-real-report-cross-plane-green`, and the LBA Local Gates workflow
    runs on BOTH ubuntu-latest and windows-latest -- so both operating systems
    computing the same `resultHash` for the same real report IS the two-plane
    agreement.
  - The REAL run is ALSO proven cross-plane by two INDEPENDENT LIVE runs (the
    stronger form): the LINUX clean room (64-bit LabVIEW 2026 on Ubuntu/VBox) and
    the WIN clean room (32-bit LabVIEW 2026 on Windows/VBox) EACH ran
    `LabVIEWCLI RunVIAnalyzer` on the same shipped `LabVIEWCLIExampleProject`
    (3 VIs -> 69 tests) as a 6-run determinism trend, and both produced the
    byte-identical `resultHash 0419a449...`
    (`compare-vi-analyzer-trend-cross-plane.mjs` reports `match=true`, exiting 1
    on mismatch). Timing legitimately differs (LINUX cold/warm 2.15x; WIN 19.34x
    -- Windows first-launch mass-compile/indexing), which the store
    `crossPlaneCompare` reports as numeric deltas while the `resultHash` digest
    matches. Receipts: `vi-analyzer-trend-live-evidence.json` (LINUX),
    `vi-analyzer-trend-live-evidence-WIN.json` (WIN), and
    `vi-analyzer-trend-cross-plane-receipt.json`; `verify-vi-analyzer-trend.mjs`
    re-derives every run's hash from committed data (no clean room needed to
    re-check).
  - Gated: `verify-vi-analyzer-result` (7/7), local gates
    `vi-analyzer-result-model-green` + `vi-analyzer-report-schema-green` +
    `vi-analyzer-ascii-parser-green` + `vi-analyzer-real-report-cross-plane-green`.
- Change Guidance: Keep `summarizeViAnalyzerReport` deterministic +
  order-independent + locale-independent (the cross-plane anchor is the
  `resultHash`; sort by code unit, never `localeCompare`). The normalized shape
  mirrors the tool's real failure-oriented output; do NOT reintroduce a
  per-test-pass enumeration the CLI cannot emit. Proven 2026-07-28
  (operator-authorized): WIN ran the real `LabVIEWCLI RunVIAnalyzer` on the
  icon-editor VIs (452 passed / 0 failed, attested on the bus); the all-pass
  report `experiments/vi-analyzer/icon-editor-report.json` (resultHash
  `df9c8d1e...`) is proven cross-plane by the CI OS matrix (see the criterion
  above). WIN's independent re-commit from its Windows machine is welcome as
  corroboration.

### LBA-REQ-016: GitFlow branch governance

- Status: Proven
- Area: Configuration Management (extends LBA-REQ-008; ADR-0010)
- Statement: The repository shall adopt **GitFlow** as its branch-governance
  doctrine — `main` as the protected production branch and `develop` as the
  integration branch, with feature/release/hotfix branch rules — so its
  configuration management passes the authoritative `repo-standards-review` CM
  gate (ISO 10007 §5, ISO/IEC/IEEE 12207) without weakening the CI-owned,
  protected-`main` release-tag publish authority.
- Acceptance Criteria:
  - The CM plan (`docs/cm/cm-plan.md`) states the GitFlow rules: feature
    branches from and back into `develop`; release branches from `develop`,
    merged to `main` and `develop`, then deleted; hotfix branches from `main`,
    merged to `main` and `develop`; SemVer tags on `main`; coverage retained on
    the tagged release path.
  - The decision is recorded in
    `docs/architecture/adr/ADR-0010-gitflow-branch-governance.md`.
  - A `develop` integration branch exists off `main`; features target `develop`
    and `main` advances only through a release (or hotfix) merge, so the
    protected-`main` + CI-owned-tag publish model is unchanged.
  - `repo-standards-review --profile release-gate` reports the `cm` gate PASS
    with no `release-workflow-no-gitflow` contradiction.
- Change Guidance: The CM plan is the canonical governance record; keep the
  GitFlow rules and the SemVer / coverage-on-release lines intact so the CM gate
  stays green. Proven 2026-07-31: the `cm` gate flipped FAIL→PASS under
  `repo-standards-review` v0.2.19 once the governance was recorded (the
  `release-workflow-no-gitflow` contradiction cleared).

---

### LBA-REQ-017: LabVIEW authoring-lane dependency manifest

- Status: Proven
- Area: Authoring lane (Windows/ActiveX build reproducibility)
- Statement: The system shall record every LabVIEW authoring-lane dependency as
  a version-pinned entry in a governed dependency manifest.
- Rationale: The authoring lane (`labview_assistant` + its DQMH dependency + the
  `.vipb` VI-Package build) must build reproducibly on the Windows clean room,
  which requires every dependency pinned to a concrete, verifiable version rather
  than a floating reference.
- Acceptance Criteria:
  - `experiments/labview-authoring/dep-manifest.json` (`dep-manifest@1`) records
    each authoring dependency with a `pinStatus` of `resolved` — carrying a
    concrete git SHA, pip version, or vipc — or `tbd-*` (a pin LINUX still has to
    verify on the VM; allowed to omit its concrete value but not its shape).
  - `verify-dep-manifest.mjs` validates the manifest shape and pin format
    fail-closed: it rejects a bad schema, a malformed SHA, an unknown plane, a
    missing python bitness, a bad `pinStatus`, or a `resolved` entry with an
    empty version.
  - Gated: `verify-dep-manifest.mjs` + `verify-dep-manifest.selftest.mjs` run in
    `verify-local-gates` (an authoring-namespaced check).
- Change Guidance: Keep the manifest single-purpose (pin format + shape only, not
  live resolution) so the check stays deterministic and offline. Authored under
  the `repo-standards-review` singular-requirement directive (one `shall`).

---

### LBA-REQ-018: Provider-delegated cleanroom AI uplift

- Status: Proven
- Area: Distributed CI (AI-provider uplift over the coordination bus; ADR-0011)
- Statement: The system shall delegate a validated uplift task to a
  capability-matched cleanroom AI provider over the coordination bus.
- Rationale: Uplift and documentation-drafting work runs where the licensed
  tooling and capability differentiation live (cleanroom actors running Ollama /
  Copilot CLI / Codex), so the host observes each cleanroom's gated outcome over
  the existing `lbabus` transport rather than hosting providers centrally.
- Acceptance Criteria:
  - `delegateUplift.mjs` validates an `lba-uplift-task@v1` spec, drives a provider
    through the provider-agnostic adapter seam (`providerAdapters.mjs`), applies a
    deterministic acceptance gate (pass and fail), and writes an
    `lba-uplift-delegation-receipt@v1` announced as an ADR-0003 `DONE` frame.
  - The registry/router (`registry.mjs`) dispatches a `CLAIM` only to a live,
    capability-matched worker; the persistent worker pool bounds concurrency; the
    quality pre-gate short-circuits a weak / off-topic / refusal draft.
  - Each uplift domain gates fail-closed: coverage-lift (a proposed test gated on
    the measured line coverage of a target module), evidence (receipt gathering +
    summary accuracy), risky-test (external-tool gate), and VIPM credential +
    capability routing.
  - Gated: the ten `provider-delegation/verify-*.mjs` self-tests run in
    `verify-local-gates`, all deterministic and offline (mock adapter, no GPU /
    no network).
- Change Guidance: Keep the harness provider-agnostic (the adapter seam) and
  composed of existing infra (ADR-0003 bus + `ollama-drive` + `ollama-comparison`);
  do not introduce a new transport. Decision recorded in ADR-0011. Authored under
  the `repo-standards-review` singular-requirement directive (one `shall`).

### LBA-REQ-019: MCP server agent tool surface

- Status: Proven
- Area: Agentic infra (Model Context Protocol tool surface; ADR-0012)
- Statement: The system shall expose the benchmark actor's tools to a coding
  agent through a Model Context Protocol server.
- Rationale: Coding agents consume tooling through MCP. The actor already holds
  value an agent wants — host capabilities, the deterministic mprr benchmark
  series, and the `lbabus` coordination bus — so a standard MCP surface lets an
  agent discover and call those tools directly rather than through bespoke VS
  Code commands.
- Acceptance Criteria:
  - The pure JSON-RPC 2.0 handler (`benchmarkActorMcpServer.ts`) answers
    `initialize`, `tools/list`, and `tools/call` over newline-delimited stdio,
    publishing exactly four tools — `get_host_capabilities`,
    `get_benchmark_series`, `poll_coordination_bus`, `post_coordination_note` —
    and returns `-32601` / `-32602` for an unknown method / tool.
  - A missing `lbabus` degrades to a soft `isError` tool result, not a transport
    crash, so the agent can act on the message.
  - The definition provider (`benchmarkActorMcpServerProvider.ts`) registers with
    VS Code under the same id the manifest contributes, launching the bundled
    dependency-free stdio entry (`runBenchmarkActorMcpServer.ts`).
  - The bundled tool-doc check keeps `docs/mcp-tools.md` in sync with the
    published registry.
  - Gated: `test/mcp-server.mjs` (pure-core, activation, and stdio legs) and
    `scripts/mcpToolDoc.mjs --check` run under `npm test`, all deterministic and
    host-free (no real VS Code, no display, no live `lbabus`).
- Change Guidance: Keep the protocol logic a pure handler with injected deps and
  the stdio entry dependency-free (Node built-ins only) so no new runtime
  dependency enters the packaged `.vsix`. Decision recorded in ADR-0012. Authored
  under the `repo-standards-review` singular-requirement directive (one `shall`).

### LBA-REQ-020: Bidirectional release sign-off

- Status: Proven
- Area: CM / release governance (bidirectional WIN<->LINUX plane sign-off)
- Statement: The system shall block a component release from publishing until
  both the WIN and LINUX planes have recorded an agreed sign-off for that exact
  component version.
- Rationale: A shared release — the `collab-cli` bus binary (`collab-cli-vX.Y.Z`)
  or the VS Code extension `.vsix` (`ext-vX.Y.Z`) — is co-owned by both planes.
  Letting either plane publish unilaterally would ship an unreviewed change, so
  each component's release workflow fails closed until both planes commit an
  explicit `agreed:true` sign-off for the exact version.
- Acceptance Criteria:
  - `verify-release-agreement.mjs` reads `tools/collab-cli/release-agreement.json`
    (`release-agreement@v2`) and exits 0 only when every required plane (WIN and
    LINUX) records `agreed:true` for the `<component, version>` being published.
  - The gate fails closed: it exits 1 on a missing, withheld (`agreed:false`), or
    unparseable sign-off, and exits 2 on a usage error, so an absent ledger never
    reads as consent.
  - `<version>` accepts the bare SemVer or the tagged form (`collab-cli-vX.Y.Z` /
    `ext-vX.Y.Z`); the default component is `collab-cli` and `--component <name>`
    selects another (e.g. `extension`).
  - Gated in CI: both `.github/workflows/extension-release.yml` and
    `.github/workflows/collab-cli-release.yml` run the gate before their publish
    job, so neither plane can unilaterally ship a shared release.
- Change Guidance: Keep the gate fail-closed and keep both release workflows
  calling it before publish. New required planes extend `requiredPlanes`. Authored
  under the `repo-standards-review` singular-requirement directive (one `shall`).

### LBA-REQ-021: Test-to-requirement correspondence gate

- Status: Proven
- Area: Assurance / traceability (ISO/IEC/IEEE 42010 correspondence graph; ADR-0013)
- Statement: The system shall reject any governed test file that does not
  correspond to at least one requirement in the traceability register.
- Rationale: A test that maps to no requirement is either an untraceable
  capability or dead weight. Enforcing the test-to-requirement correspondence as
  a fail-closed gate keeps the 29119 test suite tied to the 29148 requirements,
  and seeds the 42010 correspondence graph (ADR-0013) whose later rules extend
  the same engine to the decisions and views.
- Acceptance Criteria:
  - `verify-correspondences.mjs` enumerates the governed test set from the
    working tree — `test/*.mjs`, `experiments/**/verify-*.mjs`, `*.selftest.mjs`,
    `*.playwright.{mjs,cjs}`, `playwright/*.mjs`, and `tools/**/verify-*` — and
    exits 1 listing any file absent from every RTM CodeRef (rule TR-1).
  - The engine additionally enforces the ADR-to-requirement (AD-1) and
    requirement-to-view (VW-1) correspondence rules fail-closed: every ADR traces
    to a requirement and is registered in the `overview.md` decision register, and
    every requirement is described by an architecture view (the ADR-0013
    reconciliation).
  - Gated in `verify-local-gates`; deterministic, offline, dependency-free.
- Change Guidance: A new governed test must be added to an RTM CodeRef (or the
  test and its implementation removed) to pass TR-1; a new ADR must trace to a
  requirement and be registered in `overview.md`, and a new requirement must be
  described by a view, to keep AD-1 / VW-1 green (ADR-0013). Authored under the
  `repo-standards-review` singular-requirement directive (one `shall`).

### LBA-REQ-022: Generated traceability matrix

- Status: Proven
- Area: Assurance / traceability (ISO/IEC/IEEE 42010 correspondence graph, Stage 3; ADR-0013)
- Statement: The system shall generate the requirement traceability matrix from
  the governed requirement, test, and decision sources.
- Rationale: Hand-maintaining the requirement -> view -> decision -> test -> code
  cross-references invites drift. Deriving a single matrix from the canonical
  sources (the SRS, the RTM, the architecture description, and the ADR register)
  keeps the traceability view honest and current by construction, and makes the
  correspondence graph (ADR-0013) presentable, not only enforceable.
- Acceptance Criteria:
  - `generate-traceability.mjs` reads requirement ids + titles from
    `docs/requirements/srs.md`, status / TestID / CodeRef count from
    `docs/requirements/rtm.csv`, the addressing architecture view from
    `docs/architecture/overview.md` (the `### N.M ... addresses` headings), and
    the decisions from the ADR index `README.md` "Traces to" column, then writes
    `docs/requirements/traceability-matrix.md` (one row per requirement).
  - The generator is deterministic: `--check` re-derives the matrix and exits
    non-zero when the committed file drifts from the sources.
  - Gated: `traceability-matrix-current` runs `--check` in `verify-local-gates`,
    so the derived view cannot rot.
- Change Guidance: Never hand-edit `traceability-matrix.md` -- re-run the
  generator and commit. When a source changes (a requirement, a test mapping, a
  view, or an ADR trace), regenerate. Decision recorded in ADR-0013. Authored
  under the `repo-standards-review` singular-requirement directive (one `shall`).

### LBA-REQ-023: Actor Corroboration Grid (multi-witness release corroboration)

- Status: Proven
- Area: Assurance / release corroboration (ISO/IEC/IEEE 42010; ADR-0014)
- Statement: The system shall gate each governed component release on an on-demand
  corroboration quorum in which a majority of independent witnesses across distinct
  environments agree on the release's deterministic anchors.
- Rationale: A single cleanroom is an unwitnessed single point of trust. Requiring a
  majority of independent, distinct-environment witnesses to agree on the deterministic
  anchors raises release confidence and makes a drifted or forged witness detectable as
  a quorum divergence rather than a silent pass.
- Acceptance Criteria:
  - The Actor Corroboration Grid (ADR-0014) collects a signed receipt bundle from the
    initial three heterogeneous witnesses (Codespace-Linux, VirtualBox-Linux, Windows).
  - OS-independent anchors (viewer `seriesHash`, `lbabus` version + `sourceCommit`,
    gate-suite `verdict`) must agree across all participating witnesses; Linux-only
    anchors (pinned `pngSha256`, Ubuntu codename) across the Linux subset;
    capability / host / timestamps are recorded witnesses.
  - The quorum passes on a >=2-of-3 majority; a sub-majority blocks the release and
    opens a divergence issue.
  - A valid quorum spans distinct environments (N-of-a-kind rejected); each witness
    signs its receipt bundle; consumption verifies the attestation before install.
- Change Guidance: Umbrella requirement for the ACG platform (ADR-0014), delivered
  design-first. The sub-requirement family shipped -- LBA-REQ-024 (quorum), 026 (independence),
  027 (reviewer sign-off), 028 (mesh), 029 (MCP), 030 (governance) Proven, 025 (provenance)
  enrolled-chain Proven -- and the end-to-end grid `experiments/acg-grid/grid.mjs` composes them
  into one release gate (independence + quorum + attestation + mesh + human sign-off; self-test 6/6,
  gated by `acg-grid-e2e`), with the real {codespace, host} grid corroborated through every machine
  stage and held only at the human sign-off (`acg-grid-run-live`). 025's remaining external bits
  (sigstore-keyless OIDC + rekor) stay Planned. Authored under the `repo-standards-review`
  singular-requirement directive (one `shall`).

### LBA-REQ-024: Corroboration quorum + graded confidence

- Status: Proven
- Area: Assurance / release corroboration (ADR-0015)
- Statement: The system shall pass the release corroboration quorum only when a majority
  of participating witnesses agree on their applicable OS-independent anchors and the
  graded anchor-agreement fraction meets the configured threshold.
- Rationale: A single witness is an unwitnessed point of trust. Grading agreement across a
  majority of heterogeneous witnesses tolerates one outage while still requiring genuine
  cross-environment corroboration.
- Acceptance Criteria:
  - The verdict is the fraction `matched / applicable` anchor dimensions under the tiered
    model (OS-independent anchors across all witnesses; Linux-only across the Linux subset).
  - It passes on a >=2-of-3 majority meeting the threshold.
  - A sub-majority or below-threshold result blocks the release and opens a divergence
    issue naming the dissenting witness and anchor.
- Change Guidance: Sub-requirement of LBA-REQ-023 (ADR-0015). DELIVERED as
  `experiments/acg-quorum/compare-witnesses.mjs` (self-test 7/7), gated by
  `acg-quorum-compare-witnesses`, with the fail-closed witness-bundle assembler
  `experiments/acg-quorum/assemble-witness.mjs` (self-test 9/9, gated by
  `acg-quorum-assemble-witness`) composing each witness's gate/render/capability
  receipts into the bundle the quorum ingests. LIVE-corroborated by a real {CODESPACE (noble),
  LINUX host} grid whose committed bundles + `corroboration-receipt.json` are re-derived tamper-
  evidently by `acg-quorum-live-corroboration` (verdict pass; the Ubuntu-codename divergence is
  graded, not fatal). Authored under the `repo-standards-review`
  singular-requirement directive (one `shall`).

### LBA-REQ-025: Corroboration provenance + attestation

- Status: Proven
- Area: Assurance / supply-chain provenance (ADR-0016)
- Statement: The system shall block consumption of a release artifact until its
  corroboration attestation chain verifies.
- Rationale: An unattested or tampered artifact must not be installed on the strength of a
  verdict alone; verifying the signed chain before consumption closes that gap.
- Acceptance Criteria:
  - Each witness signs its receipt bundle (sigstore keyless where an OIDC identity exists,
    an enrolled key otherwise); the verdict, artifacts, and human sign-off are attested.
  - Provenance is stored on the Release, in the repo, in a transparency log, and on the
    mesh ledger.
  - A standalone verify tool and the reviewer-workstation install both verify the chain
    before install.
- Change Guidance: Sub-requirement of LBA-REQ-023 (ADR-0016). The verify-before-consume engine
  `experiments/acg-provenance/attest.mjs` (Ed25519 enrolled-key attestations + a consume decision
  that re-computes the quorum over the attested bundles; self-test 10/10, gated by
  `acg-provenance-attest`) has shipped, AND the real enrolled-key chain is proven on the live grid
  (the codespace and host each signed their own bundle; verify-before-consume = consume:true,
  gated by `acg-provenance-verify-before-consume`). The reviewer-workstation verify-before-install
  (LBA-REQ-031, ADR-0022), the self-hosted Merkle transparency log (the offline rekor analogue), and the
  mesh ledger (LBA-REQ-028) have since shipped, and the sigstore-KEYLESS + public-rekor tier is now wired
  via `.github/workflows/acg-keyless-attest.yml` (cosign keyless `sign-blob` under an Actions OIDC identity
  -> a short-lived Fulcio certificate + a public rekor entry, gated for drift by
  `acg-keyless-attest-workflow-wired`). The live keyless-attest run has now DEMONSTRATED the Fulcio/rekor
  evidence (workflow_dispatch run 30701351016 keyless-signed the release-provenance bundle -> public rekor
  logIndex 2311970781, recorded in `experiments/acg-transparency/keyless-attest-evidence.json` (run 30703064254 ->
  rekor logIndex 2312189991). PROVEN: the provenance is now stored ON THE RELEASE -- the immutable prerelease
  `acg-attest-v0.0.2` carries the keyless-signed `.sigstore` bundle + certificate + signature attached at
  creation -- completing all four storage locations (Release, repo, transparency log, mesh ledger) and the full
  chain. The real ext-v*/collab-cli-v* release lanes are hardened through the same mechanism: the shared
  `.github/actions/keyless-attest` composite action keyless-signs their artifacts (cosign, Actions OIDC ->
  Fulcio + public rekor) and attaches the signatures at creation (drift-gated by `release-lanes-keyless-attested`).
  The reviewer-workstation then cosign-verifies the .vsix keyless signature before install (network-gated,
  fail-closed; drift-gated by `reviewer-workstation-keyless-verify-wired`).
  Authored under
  the `repo-standards-review` singular-requirement directive (one `shall`).

### LBA-REQ-026: Witness independence

- Status: Proven
- Area: Assurance / anti-forgery (ADR-0017)
- Statement: The system shall reject a corroboration quorum whose witnesses do not span
  distinct enrolled environments.
- Rationale: N identical nodes are not N independent witnesses; requiring distinct enrolled
  environments prevents one actor from forging agreement with look-alike witnesses.
- Acceptance Criteria:
  - A valid quorum spans distinct enrolled environments.
  - A non-enrolled witness, or one that duplicates an already-counted environment, does not
    count toward the majority.
  - Each counted witness's identity is recorded in the provenance.
- Change Guidance: Sub-requirement of LBA-REQ-023 (ADR-0017). DELIVERED as
  `experiments/acg-independence/independence.mjs` (assessIndependence: a witness counts only if
  its plane/os environment is enrolled, its identity is recorded, and it does not duplicate an
  already-counted environment; independent iff >= quorumMin distinct enrolled environments;
  self-test 9/9, gated by `acg-independence-quorum`). The committed live {CODESPACE, LINUX} grid
  is independent with recorded identities, re-derived tamper-evidently by `acg-independence-live`.
  Authored under the `repo-standards-review` singular-requirement directive (one `shall`).

### LBA-REQ-027: Reviewer station + human sign-off

- Status: Proven
- Area: Assurance / human-in-the-loop (ADR-0018)
- Statement: The system shall block a corroborated release from publishing until a recorded
  human sign-off accompanies the machine quorum verdict.
- Rationale: Machine corroboration establishes reproducibility, but a human still judges
  whether the result looks correct; requiring a recorded sign-off alongside the quorum keeps
  that judgment explicit and un-skippable.
- Acceptance Criteria:
  - The human visual gate runs on either the Windows reviewer VM or a zero-install Linux
    browser codespace (reviewer's choice).
  - A release publishes only when the machine quorum passes and the signed human sign-off is
    recorded; the sign-off does not substitute for the quorum.
  - Single reviewer now; architected for a multi-reviewer human quorum later.
- Change Guidance: Sub-requirement of LBA-REQ-023 (ADR-0018). DELIVERED as
  `experiments/acg-reviewer/sign-off.mjs` -- an Ed25519 human sign-off (from either station) that
  blocks publish until a recorded, enrolled, approving sign-off accompanies the exact passing
  machine-quorum verdict (the sign-off never substitutes for the quorum; multi-reviewer-ready via
  `minReviewers`); self-test 10/10, gated by `acg-reviewer-sign-off`. The real corroborated release
  is shown BLOCKED pending sign-off (`acg-reviewer-release-decision`); recording a real sign-off is
  the reviewer's judgement step. Authored under the `repo-standards-review` singular-requirement
  directive (one `shall`).

### LBA-REQ-028: Mesh verdict beacon

- Status: Proven
- Area: Assurance / distributed collection (ADR-0019)
- Statement: The system shall beacon each witness's corroboration verdict over the lbabus
  coordination mesh.
- Rationale: Verdicts already travel the bus via the gate-suite beacon; collecting each
  witness's outcome over the existing mesh gives a live, distributed view without a new
  transport.
- Acceptance Criteria:
  - Each witness joins the lbabus mesh and beacons its verdict (reusing the gate-suite verdict
    beacon and the mesh topology).
  - A mesh ledger records the beaconed verdicts and feeds the provenance store (ADR-0016).
  - No new transport: the mesh reuses the ADR-0003 coordination-bus wire format.
- Change Guidance: Sub-requirement of LBA-REQ-023 (ADR-0019). DELIVERED as
  `experiments/acg-mesh/verdict-beacon.mjs` (a comms-only `bus-msg@1` verdict NOTE over the shared
  busFrame -- no new transport; a tamper-evident MeshLedger feeding provenance; `quorumFromLedger`
  resolving beaconed witnesses to bundles by digest; self-test 8/8, gated by `acg-mesh-verdict-beacon`).
  Proven live on loopback (the real {codespace, host} verdicts beaconed over `bus-msg@1` 127.0.0.1 TCP
  -> ledger -> quorum pass, `acg-mesh-loopback-evidence`); a multi-node / VM mesh is the same mechanism
  scaled. Authored under the `repo-standards-review` singular-requirement directive (one `shall`).

### LBA-REQ-029: MCP orchestration surface

- Status: Proven
- Area: Agentic infrastructure (ADR-0020, extends ADR-0012)
- Statement: The system shall expose the corroboration grid's operations to agents through
  the Model Context Protocol tool surface.
- Rationale: Agents already consume actor tools through the MCP server (ADR-0012); exposing
  the grid's operations on the same surface lets an agent orchestrate corroboration directly
  rather than through bespoke commands.
- Acceptance Criteria:
  - The ADR-0012 MCP surface gains grid tools: `spin_up_witness`, `run_quorum`,
    `get_confidence`, `verify_attestation`, `teardown`.
  - The surface is designed now and implemented in a later phase.
- Change Guidance: Sub-requirement of LBA-REQ-023 (ADR-0020). DELIVERED as
  `experiments/acg-mcp/grid-tools.mjs` + `server.mjs` -- the grid tools (`spin_up_witness`,
  `run_quorum`, `get_confidence`, `verify_attestation`, `teardown`, plus `check_independence`
  + `assemble_witness`, and the transparency verify tools `verify_inclusion` + `verify_before_install`,
  ADR-0022) over the same dependency-free JSON-RPC 2.0 MCP contract as the ADR-0012
  server, composing the engines; self-test 13/13 incl. a spawned stdio round-trip, gated by
  `acg-mcp-grid-surface`. spin_up_witness/teardown return provisioning plans (live execution is
  the operator step). The surface is now FOLDED into the single extension MCP server binary:
  `scripts/stage-acg-mcp.mjs` bundles the grid-tools closure into `out/acg-mcp-bundle/` (shipped in the
  `.vsix`), and `src/mcp/runBenchmarkActorMcpServer.ts` dynamically imports it so the one shipped server's
  `tools/list` publishes all 13 tools (4 core + 9 grid); the folded stdio surface is asserted by the
  `mcp-server` test and `docs/mcp-tools.md` is gated to 13 tools. Authored under the `repo-standards-review`
  singular-requirement directive (one `shall`).

### LBA-REQ-030: Pull requests target develop

- Status: Proven
- Area: Configuration management / branch governance (ADR-0021, refines ADR-0010)
- Statement: The system shall require every non-release pull request to target the develop
  integration branch.
- Rationale: GitFlow makes develop the integration branch (ADR-0010), but stale main-based
  pull requests (#211 / #215 / #217) dumped integration content onto the release branch
  because no rule stated where feature work targets.
- Acceptance Criteria:
  - Every non-release pull request targets develop.
  - Main receives only release/hotfix merges via a no-fast-forward merge.
  - A pull request found on the wrong base is re-targeted or closed rather than merged.
- Change Guidance: Refines ADR-0010 (ADR-0021). DELIVERED as the base-branch guard
  `experiments/acg-governance/pr-base-branch-guard.mjs` (blocks any non-release head targeting
  main -- develop and feature/authoring included; only release/* and hotfix/* target main;
  self-test 11/11) enforced on pull requests by `.github/workflows/pr-base-branch-guard.yml`,
  gated by `acg-governance-pr-base-branch` + `acg-governance-pr-base-branch-workflow-wired`.
  Authored under the `repo-standards-review` singular-requirement directive (one `shall`).

### LBA-REQ-031: Transparency-log inclusion + verify-before-install

- Status: Proven
- Area: Assurance / supply-chain transparency (ADR-0022, extends ADR-0016)
- Statement: The system shall admit a component release for installation only after its
  corroboration attestation is proven included in the signed transparency log.
- Rationale: Provenance that lives only beside a verdict can be silently dropped or forged.
  Recording each witness attestation in an append-only, Ed25519-signed Merkle transparency
  log (RFC 6962) makes an unattested or un-logged release refusable before install, with
  tamper-evident inclusion proofs.
- Acceptance Criteria:
  - Each witness attestation is a leaf in a signed Merkle log; the signed tree head binds the
    root, size, and log identity.
  - An inclusion proof reconstructs the signed root from a single leaf without the whole log;
    a consistency proof shows the log was only appended to between two signed heads.
  - The reviewer-workstation install plus a standalone verifier admit a release only when at
    least the quorum minimum of enrolled-witness attestations are proven included; a missing
    or tampered proof blocks the install (fail-closed).
- Change Guidance: Extends ADR-0016 (ADR-0022); delivers the offline-verifiable
  transparency-log and reviewer-workstation-verify clauses of LBA-REQ-025. DELIVERED as
  `experiments/acg-transparency/transparency-log.mjs` (RFC 6962 domain-separated hashing,
  inclusion + consistency proofs, Ed25519 signed tree heads; self-test 26/26, gated by
  `acg-transparency-log`), LIVE over the real {codespace, host} attestations recorded under one
  signed head (`acg-transparency-log-live`), with the verifier
  `experiments/acg-transparency/verify-release-inclusion.mjs` (admits the real bundle, blocks a
  tampered one; gated by `acg-transparency-verify-before-install`) wired fail-closed into
  `reviewer-workstation/provision.ps1` before the `.vsix` install
  (`acg-transparency-verify-before-install-wired`). LBA-REQ-025's sigstore-keyless OIDC and
  public-rekor clauses remain the networked tier and stay Planned. Authored under the
  `repo-standards-review` singular-requirement directive (one `shall`).

---

### LBA-REQ-032: Mesh-stress performance-signature calibration

- Status: Proven
- Area: Analysis / mesh-stress performance signature (mesh-stress-signature@v1)
- Statement: The system shall calibrate a stress-ladder performance-signature
  curve from repeated per-rung benchmark signatures so an observed signature maps
  to an inferred stress level within the calibrated tolerance band.
- Rationale: The mesh-stress program (mesh-stress-signature@v1, design #272)
  re-verifies the maximum drop-free streaming ceiling under a stressed actor mesh
  where each actor runs at a different stress level; calibrating each actor's
  42-counter performance signature across the stress ladder turns raw per-actor
  counters into a monotone, separable, repeatable stress read for later ladder
  testing. Builds on performance-counter-correlation@v2 (LBA-REQ-011).
- Acceptance Criteria:
  - A performance signature is the repetitive (stable) plus outlier features of
    the per-actor counter series across repeated runs; a feature is signature when
    its across-repeat coefficient-of-variation is within the stability threshold,
    else it is noise.
  - The calibration curve gives, per counter-feature dimension, an expected value
    plus a tolerance band per stress rung, and its fit is scored against the design
    invariants monotone (salient features track the rung), separable (adjacent rung
    bands resolve on at least one dimension), and repeatable (each rung retains
    stable signature features); a non-tracking feature is dropped.
  - An observed signature inverse-reads to an inferred stress rung with a
    confidence derived from the band distance.
  - The commanded ladder is monotone (CPU cap decreases, workload increases from
    idle to saturate) and pins each mesh actor to a distinct level.
- Change Guidance: The three pure engines (signature extractor, calibration-curve
  fitter, stress orchestrator) are delivered under `experiments/mesh-stress-signature/`
  (mesh-stress-signature@v1), each with a self-test gated in `verify-local-gates`
  and mapped in the RTM; the live Windows/Linux mesh ladder run is the remaining
  phase. Builds on LBA-REQ-011 (performance-counter-correlation@v2). Authored under
  the singular-requirement directive (one `shall`).

---

### LBA-REQ-033: Personal golden-VM onboarding for the LabVIEW community

- Status: Proven
- Area: Deployment / onboarding (personal golden VM, Ubuntu + LabVIEW CE)
- Statement: The system shall provision a from-scratch Ubuntu 24.04 golden VM
  with activated LabVIEW 2026 Community Edition plus VIPM, confirming the
  activation with a headless probe VI before registering the VM as a mesh actor.
- Rationale: The single most valuable missing capability (maintainer interview,
  2026-08) is fully-automated, from-scratch provisioning of a Ubuntu VM with
  LabVIEW Community Edition + VIPM, so that once the member activates them the
  tool confirms activation and mints their personal golden VM. The proven golden
  box today is Windows-only, which excludes the Linux community and blocks the OS
  axis of cross-plane comparison. On-host inspection confirms the concrete spine:
  LabVIEW 2026 CE for Linux installs from the NI apt repo, ships `LabVIEWCLI`
  headless operations, and installs VIPM; activation is interactive (ADR-0023).
- Acceptance Criteria:
  - `lba init` detects the host (Windows / Linux) and hypervisor (VirtualBox +
    Vagrant, or Hyper-V/WSL2 on Windows) and provisions a clean Ubuntu 24.04
    (Noble) VM.
  - The NI apt repo is added with the committed GPG key and
    `ni-labview-2026-community` plus `vipm` install non-interactively.
  - Activation is a hybrid step: the member signs in to their NI account and
    activates; automation handles everything before and after.
  - Activation is confirmed functionally by a headless `LabVIEWCLI -OperationName
    RunVI ... -Headless` probe VI that emits a signed `activation-receipt@1`; a
    functional probe is chosen over parsing NI license files.
  - On a confirmed receipt the personal golden VM is minted locally (a
    re-importable box, no shared registry) and registered as an actor in
    `mesh-actors.csv`.
- Change Guidance: COVERED by composition -- `lba init` (`scripts/lba.mjs`) orchestrates
  the six roadmap Sec 4 flow steps, each realized by a Proven slice (LBA-REQ-044 provisioner
  installs LabVIEW + VIPM, LBA-REQ-049 headless readiness, LBA-REQ-038 activation receipt,
  LBA-REQ-039 mesh registration); `experiments/first-win/firstWinOnboarding.mjs` composes them
  into a `first-win-onboarding@1` receipt and the `first-win-onboarding` gate fails closed unless
  every step resolves to a committed realization and activation was confirmed live (proven
  end-to-end on `lba-golden`: fresh Ubuntu 24.04 VM -> LabVIEW 2026 CE + VIPM -> NI-account
  activation -> headless RunVI 42). Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-034: Governed 26514 information for users

- Status: Proven
- Area: Documentation / information for users (ISO/IEC/IEEE 26514:2022)
- Statement: The system shall keep the bounded ISO/IEC/IEEE 26514
  information-for-users product set complete and command-covering, so a
  fail-closed gate blocks the build when a required user-information item is
  missing or a contributed command is undocumented.
- Rationale: A `repo-standards-review` audit scored the repo 25/25 on the scored
  lenses but found the substantive gaps live where conformance is not gated; the
  weakest surface was 26514 user information (a single user guide). Gating a
  bounded 26514 product set keeps user information from drifting from the product
  (ADR-0024).
- Acceptance Criteria:
  - The bounded product set exists under `docs/information-for-users/`: a
    navigation hub, getting started, user guide, command reference, glossary,
    FAQ, audience-and-task model, delivery profile, information plan, and a
    conformance boundary; each is non-trivial.
  - The command reference covers every VS Code command the extension contributes
    (cross-checked against `package.json`).
  - The conformance boundary states a bounded product claim and explicitly
    disclaims full process conformance to 26514 Clauses 5-6 (`26514 §4`).
  - The navigation hub indexes every item; a self-test proves the checker fails
    closed on an empty or incomplete set.
- Change Guidance: The checker `experiments/information-for-users/verify-information-for-users.mjs`
  plus its self-test are gated by `information-for-users-26514` in
  `verify-local-gates` and mapped in the RTM; the set is registered in the 15289
  information item map. Authored under the singular-requirement directive (one
  `shall`).

---

### LBA-REQ-035: Generated test report and configuration status accounting

- Status: Proven
- Area: Assurance / configuration management (ISO/IEC/IEEE 29119-3 test report; ISO 10007 / ISO/IEC/IEEE 12207 status accounting)
- Statement: The system shall generate the test report and configuration
  status-accounting record from the verification apparatus, so a fail-closed gate
  blocks the build when the committed record drifts from the gates, correspondence
  rules, requirements, and decisions it accounts for.
- Rationale: The repo kept a test *plan* (design) but no executed test *report*
  (ISO/IEC/IEEE 29119-3) and no *configuration status accounting* record (ISO
  10007); a deeper clause-level standards audit found the executed outcomes and
  the controlled configuration state were never recorded as governed information
  items. A single hand-written report would drift; generating it from the very
  apparatus CI enforces keeps the outcomes current by construction (ADR-0025).
- Acceptance Criteria:
  - `docs/testing/test-report.md` exists and is GENERATED (never hand-edited): it
    states the 29119-2 completion criteria, enumerates the fail-closed gate
    inventory and the correspondence rules (29119-3 executed evidence), records
    the coverage floors, and accounts the requirement / ADR / gate / test-item
    configuration state (ISO 10007 status accounting).
  - The generator is deterministic (no timestamps / HEAD): two renders are
    byte-identical, so `--check` is a reliable drift gate.
  - The `test-report-current` gate fails closed when the committed report drifts
    from the sources; the self-test also proves fail-closed detection on any
    mutation.
- Change Guidance: The generator `experiments/reqs-coverage/generate-test-report.mjs`
  plus its self-test are gated by `test-report-current` in `verify-local-gates`
  and mapped in the RTM; the report is registered in the 15289 information item
  map. Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-036: Resolvable, invariant-complete release procedure

- Status: Proven
- Area: Configuration management / release process (ISO/IEC/IEEE 15289 procedure; ISO/IEC/IEEE 12207 / ISO 10007 release process)
- Statement: The system shall keep the ISO/IEC/IEEE 15289 release procedure
  resolvable and invariant-complete, so a fail-closed gate blocks the build when
  the procedure cites a workflow or script that does not resolve or omits a
  required release invariant.
- Rationale: A deeper clause-level standards audit found the repo carried a 12207
  move/transition procedure but no *release* procedure information item — the
  signed, corroborated release flow was scattered across the CM plan's branch
  governance and the corroboration-grid requirements. A procedure that could
  silently cite a renamed workflow would mislead a releaser; gating it keeps the
  procedure resolvable by construction (ADR-0026).
- Acceptance Criteria:
  - `docs/release/release-procedure.md` exists and gives the step-by-step signed,
    corroborated release: release branch → version bump → `--no-ff` merge to
    `main` → corroboration quorum → bidirectional agreement → keyless signing
    (Fulcio + rekor) → transparency-log inclusion → immutable GitHub Release →
    verify-before-install → merge back.
  - Every workflow / script / action path the procedure cites resolves on disk.
  - The procedure names every required release invariant (SemVer tag on `main`,
    bidirectional agreement, keyless signing, transparency-log inclusion,
    verify-before-install).
  - The checker fails closed when a cited path is missing or a required invariant
    is dropped (proven by the self-test).
- Change Guidance: The checker `experiments/release/verify-release-procedure.mjs`
  plus its self-test are gated by `release-procedure-references-resolve` in
  `verify-local-gates` and mapped in the RTM; the procedure is registered in the
  15289 information item map. Authored under the singular-requirement directive
  (one `shall`).

---

### LBA-REQ-037: Continuous five-lens compliance self-audit

- Status: Proven
- Area: Assurance / configuration management (repo-standards-review five-lens rubric over 29148/42010/29119/10007/15289/26514)
- Statement: The system shall self-audit its five-lens standards posture at
  clause-evidence granularity, so a fail-closed gate blocks the build when any
  lens drops below its target score or a required information item, wired gate, or
  clause anchor is missing.
- Rationale: The standards audit's meta-finding (F4) was that non-gated
  conformance is where standards drift silently, and the coarse 25/25 was a
  point-in-time score rather than a continuously-verified guarantee. A generated,
  fail-closed self-audit that re-scores the repo against the repo-standards-review
  five-lens rubric on every change makes full compliance corroborated by
  construction rather than asserted (ADR-0027).
- Acceptance Criteria:
  - `experiments/compliance/verify-compliance-posture.mjs` encodes each lens's
    level-5 clause-evidence — real information items, wired fail-closed gates, and
    standard clause anchors — and scores REQ/ARCH/TEST/CM/DOC.
  - `docs/compliance/compliance-posture.md` is generated and reports 25/25 with a
    per-lens evidence checklist; `--check` fails closed if the posture is below
    target or the scorecard drifts.
  - The scoring fails closed on any single missing clause-evidence item (proven by
    the self-test), and the deep-compliance artifacts (test report, release
    procedure) are load-bearing across lenses.
- Change Guidance: The checker `experiments/compliance/verify-compliance-posture.mjs`
  plus its self-test are gated by `continuous-compliance-self-audit` in
  `verify-local-gates` and mapped in the RTM; the scorecard is registered in the
  15289 information item map. Authored under the singular-requirement directive
  (one `shall`).

---

### LBA-REQ-038: LabVIEW activation confirmation via a headless known-answer probe

- Status: Proven
- Area: Deployment / onboarding (ADR-0023 Phase 1 — personal golden-VM activation confirmation)
- Statement: The system shall confirm LabVIEW activation with a headless
  known-answer probe VI, so a fail-closed gate refuses an install whose activation
  receipt does not show the probe executed and returned the known answer.
- Rationale: ADR-0023's onboarding hinges on confirming activation before minting
  a personal golden VM, and license-file parsing is brittle for Community Edition.
  A functional probe — `LabVIEWCLI RunVI` on the shipped, canonical
  `AddTwoNumbers.vi` — that must return the known answer is the robust signal and
  doubles as the benchmark-execution path. This is the first delivered slice of
  the Planned LBA-REQ-033 umbrella, proven live on the reference host's activated
  LabVIEW 2026.
- Acceptance Criteria:
  - `experiments/activation/probe-activation.sh` runs `LabVIEWCLI -OperationName
    RunVI` headless (Xvfb) on the known-answer probe VI and captures a raw result.
  - `buildActivationReceipt.mjs` produces a deterministic `activation-receipt@1`
    whose digest covers only the verdict-bearing fields (inputs, expected + parsed
    output, exit code, success, VI name, LabVIEW version), so a committed real
    capture replays offline byte-stably.
  - Activation is confirmed only when the probe exits cleanly, reports success,
    and returns the expected sum; the checker FAILS CLOSED on a non-zero exit, a
    wrong value, a missing success line, a tampered digest, or a contradicted
    verdict.
  - A committed REAL capture + receipt (LabVIEW 2026, 20 + 22 = 42) is the live
    evidence; CI replays it deterministically without LabVIEW.
- Change Guidance: The builder/validator `experiments/activation/buildActivationReceipt.mjs`
  plus its self-test are gated by `activation-receipt-confirms-activation` in
  `verify-local-gates` and mapped in the RTM. Authored under the
  singular-requirement directive (one `shall`).

---

### LBA-REQ-039: Mesh-actor registration gated on activation

- Status: Proven
- Area: Deployment / onboarding (ADR-0023 Phase 1 — register the golden VM as a mesh actor)
- Statement: The system shall register a golden VM as a mesh actor only after its
  activation receipt confirms LabVIEW is activated, so a fail-closed gate refuses
  registration for an unconfirmed or tampered receipt.
- Rationale: ADR-0023's onboarding invariant is that activation is confirmed
  before a VM joins the mesh. Binding registration to the LBA-REQ-038 activation
  receipt enforces that an unactivated or non-operational box cannot be enrolled
  as a benchmark actor — the confirmation and the enrollment are one fail-closed
  chain.
- Acceptance Criteria:
  - `registerGoldenActor` validates the `activation-receipt@1` (schema, digest,
    verdict) and only then composes the golden `mesh-actors.csv` row.
  - Registration is idempotent: re-registering the same role + actor_id replaces
    the row and preserves existing mesh rows.
  - An unactivated or tampered receipt is REFUSED and the registry is left
    untouched (proven by the self-test).
- Change Guidance: The registrar `experiments/activation/registerMeshActor.mjs`
  plus its self-test are gated by `mesh-actor-registration-requires-activation` in
  `verify-local-gates` and mapped in the RTM. Authored under the
  singular-requirement directive (one `shall`).

---

### LBA-REQ-040: Distributed capacity-weighted parallel workload

- Status: Proven
- Area: Deployment / distributed execution (ADR-0028; docs/roadmap.md North Star mesh)
- Statement: The system shall distribute an independent-task workload across a
  budget-capped pool of ripgrep-only instances proportional to each instance's
  capacity, so a fail-closed gate proves the shards ran disjointly on distinct
  instances with every task passing.
- Rationale: The North Star is on-demand distributed benchmark runs across planes
  with no central aggregation (docs/roadmap.md). A capacity-weighted executor that
  dynamically discovers a budget-capped pool (this host + codespaces + local VMs),
  splits the workload proportionally, and runs the shards concurrently — every
  instance searching with ripgrep only — is the first distributed-execution
  primitive and spreads load off the host, the only instance with LabVIEW
  (ADR-0028). Deliberately not two-instance-specific: N heterogeneous instances.
- Acceptance Criteria:
  - `discoverPool` enumerates the host (always) + labview-benchmark-actor
    codespaces + running VMs up to a conservative budget (default host + 2
    remote), concurrency = pool size; stopped instances may be resumed up to the
    cap.
  - `capacityWeightedPartition` splits the task list proportional to static
    per-type weights (host fastest); the split is deterministic given the weights.
  - Per-type SSH adapters (local / `gh codespace ssh` / `vagrant ssh`) run the
    shards concurrently; every instance attests ripgrep-only search.
  - `validateReceipt` fails closed unless the capacity split re-derived from the
    recorded weights reproduces the disjoint shards, the instances are distinct,
    all searched with ripgrep, and every task passed.
  - Live evidence: 42 self-tests split host 25 / codespace 9 / codespace 8 across
    three instances, all passed concurrently; the receipt replays offline in CI.
- Change Guidance: The executor `experiments/parallel/parallelWorkload.mjs` +
  `runParallel.mjs` and the self-test are gated by `distributed-parallel-workload`
  in `verify-local-gates` and mapped in the RTM. Authored under the
  singular-requirement directive (one `shall`).

---

### LBA-REQ-041: Capability-aware distributed task routing

- Status: Proven
- Area: Deployment / distributed execution (ADR-0029; extends ADR-0028)
- Statement: The system shall route each distributed task only to an instance
  advertising the capability the task requires, so a fail-closed gate proves every
  task ran on a capability-matching instance.
- Rationale: The distributed executor (ADR-0028) is heterogeneous, but LabVIEW
  lives only on capable instances (this host and, later, LabVIEW VMs) — a VI task
  sent to a node-only codespace would simply fail. Capability-aware routing sends
  each task only where it can run: LabVIEW work to LabVIEW-capable instances,
  non-LabVIEW parts to codespaces, so the fleet does real cross-plane work
  correctly (ADR-0029, operator directive).
- Acceptance Criteria:
  - Instances advertise capabilities (host: `labview` iff LabVIEWCLI present +
    `node`; codespace: `node`); tasks declare required capabilities.
  - `routeByCapability` capacity-weight-splits each capability group across only
    the advertising instances, and throws if a required capability is
    unsatisfiable.
  - `validateRouting` fails closed unless every task ran on a capability-matching
    instance, the re-route from the recorded capabilities + weights reproduces the
    shards, they are disjoint + cover every task + distinct-instance + ripgrep-only
    + all passed.
  - Live evidence: a real `LabVIEWCLI RunVI` activation probe routed to the host
    while 43 node self-tests spread across the host + two codespaces, all passed;
    the receipt replays offline in CI.
- Change Guidance: The router `experiments/parallel/capabilityRouter.mjs` +
  `runCapabilityRouted.mjs` and the self-test are gated by `capability-aware-routing`
  in `verify-local-gates` and mapped in the RTM. Authored under the
  singular-requirement directive (one `shall`).

---

### LBA-REQ-042: Cross-plane LabVIEW liveness

- Status: Proven
- Area: Deployment / cross-plane (ADR-0030; extends ADR-0029; advances ADR-0023 Phase 1)
- Statement: The system shall confirm cross-plane LabVIEW liveness by running the
  known-answer activation probe on every LabVIEW plane, so a fail-closed gate
  proves at least two independent LabVIEW planes are activated and operational.
- Rationale: Real cross-plane comparison (the North Star) needs more than one
  activated LabVIEW plane. The capability router (ADR-0029) now reaches the host
  plus a LabVIEW VM (the Phase 1 golden VM, ADR-0023). Running the known-answer
  probe on each plane concurrently and asserting each returns the answer proves the
  fleet has independent, activated, operational LabVIEW planes to compare across
  (ADR-0030).
- Acceptance Criteria:
  - `runCrossPlaneLiveness.mjs` discovers every LabVIEW plane (the host if
    LabVIEWCLI is present + running VirtualBox VMs answering `ls LabVIEWCLI` over
    their ssh forward) and runs `LabVIEWCLI RunVI` on the shipped `AddTwoNumbers.vi`
    on each concurrently.
  - `validateLiveness` fails closed unless >= 2 distinct planes each returned the
    known answer (`7 + 5 = 12`), reported RunVI success, and are activated.
  - Live evidence: this host + the Ubuntu 24.04 golden VM
    (`lba-ubuntu2404-labview2026-scratch`), both LabVIEW 2026 activated, both
    returning 12; the receipt replays offline in CI.
- Change Guidance: The core `experiments/activation/crossPlaneLiveness.mjs` +
  `runCrossPlaneLiveness.mjs` and the self-test are gated by
  `cross-plane-labview-liveness` in `verify-local-gates` and mapped in the RTM.
  Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-043: Cross-plane VI Analyzer determinism

- Status: Proven
- Area: Deployment / cross-plane comparison (ADR-0031; extends ADR-0030; builds on LBA-REQ-015)
- Statement: The system shall verify cross-plane benchmark determinism by comparing
  the same VI Analyzer config's deterministic resultHash across every LabVIEW plane,
  so a fail-closed gate proves the planes agree.
- Rationale: Cross-plane liveness (ADR-0030) proved the fleet has >= 2 activated
  LabVIEW planes; the North Star is objective, reproducible cross-plane
  *comparison*. LBA-REQ-015's resultHash canonicalizes a VI Analyzer run so it is
  machine-independent, so running the same config on each plane and asserting the
  hashes match proves benchmark equivalence rather than a subjective claim
  (ADR-0031).
- Acceptance Criteria:
  - `runCrossPlaneViAnalyzer.mjs` runs the shipped `LabVIEWCLIExampleProject` on
    every LabVIEW plane concurrently and computes each plane's resultHash via the
    established `summarizeViAnalyzerReport` (LBA-REQ-015).
  - `validateComparison` fails closed unless >= 2 distinct planes each carry a
    resultHash and ALL resultHashes are identical (the consensus).
  - Live evidence: this host + the Ubuntu golden VM, both LabVIEW 2026, 69 tests,
    a byte-identical resultHash; the receipt replays offline in CI.
- Change Guidance: The core `experiments/vi-analyzer/crossPlaneComparison.mjs` +
  `runCrossPlaneViAnalyzer.mjs` and the self-test are gated by
  `cross-plane-vi-analyzer-determinism` in `verify-local-gates` and mapped in the
  RTM. Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-044: Provisioner installs LabVIEW and VIPM

- Status: Proven
- Area: Deployment / onboarding (ADR-0023 Phase 1 -- the from-scratch golden-VM provisioner)
- Statement: The system shall provision the from-scratch Ubuntu golden VM with both
  LabVIEW 2026 Community and VIPM, so a fail-closed gate blocks the build when the
  provisioner omits either install.
- Rationale: ADR-0023's golden VM is "Ubuntu + LabVIEW + VIPM", but the provisioner
  installed only LabVIEW (from the NI apt repo). VIPM is a standalone JKI Debian
  package, not in the NI repo, so it needs its own step. Adding the VIPM install
  completes the golden-VM automation, and a gate keeps both installs present
  (advances the Planned LBA-REQ-033 umbrella under ADR-0023).
- Acceptance Criteria:
  - `cleanroom/ubuntu-labview/provision-guest.sh` installs `ni-labview-2026-community`
    from the NI apt repo signed by the committed keyring.
  - It installs VIPM from the JKI package server
    (`https://packages.jki.net/vipm/preview/vipm_latest_preview_amd64.deb`) via
    `dpkg -i` + `apt-get install -f`, idempotent via a `dpkg -s vipm` guard.
  - `checkProvisioner` fails closed unless both install steps are present.
  - Live evidence: VIPM 26.3.1-4000 was installed on the real scratch VM
    (`lba-ubuntu2404-labview2026-scratch`) from the JKI source; the receipt records it.
- Change Guidance: The checker `experiments/provisioner/checkProvisioner.mjs` plus
  its self-test are gated by `provisioner-installs-labview-and-vipm` in
  `verify-local-gates` and mapped in the RTM. Authored under the
  singular-requirement directive (one `shall`).

---

### LBA-REQ-045: Human-assisted VM bridge

- Status: Proven
- Area: Deployment / onboarding (ADR-0032 -- human-in-the-loop secret safety)
- Statement: The system shall provide a human-assisted terminal bridge to the golden
  VM that lets an automation agent drive the VM's interactive shell while a human
  types any password or token directly on the VM, so a fail-closed gate proves
  credentials never transit the agent.
- Rationale: Agent-driven golden-VM onboarding (ADR-0023) needs secrets -- LabVIEW
  and VIPM activation, sudo passwords -- that must never pass through the automation
  agent or the LLM. A shared tmux session that lives on the VM lets the agent drive
  every non-secret step while the human supplies a credential in-band, exactly at the
  prompt (ADR-0032).
- Acceptance Criteria:
  - `tools/vm-bridge/vm-bridge.sh` drives the VM's shell over ssh via tmux
    `send-keys`/`capture-pane` (run/send/keys/read) and offers a human `attach`.
  - `secret?` detects a credential prompt so the agent hands off instead of answering.
  - The bridge is secret-safe: no `--password`/`--token` flag, no `read -s`, no
    `sshpass`, no credential env var. `checkVmBridge` fails closed on any of these.
  - Live evidence: the agent drove the scratch VM and a real `password:` prompt was
    detected (agent exit 42) + handed off to the human, never answered; the receipt
    records it.
- Change Guidance: The checker `experiments/vm-bridge/checkVmBridge.mjs` plus its
  self-test are gated by `vm-bridge-human-assisted-secret-safety` in
  `verify-local-gates` and mapped in the RTM. Authored under the singular-requirement
  directive (one `shall`).

---

### LBA-REQ-046: VIPM functionally installs a community package

- Status: Proven
- Area: Deployment / onboarding (ADR-0023 Phase 1 -- functional VIPM on the golden VM)
- Statement: The system shall prove VIPM functionally installs a LabVIEW community
  package into the golden VM's LabVIEW package library, so a fail-closed gate blocks the
  claim unless the operator-designated self-test package installed cleanly with its
  files landing in vi.lib.
- Rationale: LBA-REQ-044 proves the provisioner INSTALLS the VIPM tool; the golden VM
  is only "Ubuntu + LabVIEW + VIPM" (ADR-0023) once VIPM actually WORKS to install a
  package. The operator designated g-cli (`wiresmith_technology_lib_g_cli`) as the VIPM
  self-test; installing it also exercises real dependency resolution.
- Acceptance Criteria:
  - On the from-scratch golden VM, VIPM (Community Edition) installs the self-test
    package g-cli plus its dependency closure into LabVIEW 2026.
  - Each installed package leaves a `files-installed` manifest in the VIPM package
    database and its VIs land under `vi.lib`.
  - `validateVipmInstallReceipt` fails closed unless every recorded package installed
    cleanly (`No Errors`, > 0 files), vi.lib gained files, the designated package is
    present, and the verdict-bearing digest is intact.
  - Live evidence: VIPM 26.3.1-4000 installed g-cli 3.0.1.98 (+ LUnit, LUnit-for-G-CLI,
    Rainbow Terminal) on `lba-golden`; 279 files under vi.lib; the receipt records it.
- Change Guidance: The receipt validator
  `experiments/vipm-install/vipmInstallReceipt.mjs` plus its self-test are gated by
  `vipm-functional-package-install` in `verify-local-gates` and mapped in the RTM.
  Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-047: Live golden-VM status and idle-time analysis

- Status: Proven
- Area: Deployment / onboarding (ADR-0023 Phase 1 -- live golden-VM visibility)
- Statement: The system shall stream the golden VM live status and analyze a captured
  timeline for idle spans, so a fail-closed gate proves the committed idle-time analysis
  is correctly derived from the samples.
- Rationale: The human-assisted golden-VM workflow has long stretches of "dead time"
  invisible to both human and agent -- LabVIEW sitting idle while VIPM silently waits to
  connect is the archetype. A live monitor that streams the VM's CPU busy% over the
  bridge, plus a deterministic idle-time analysis of a captured timeline, surface and
  quantify that dead time so it can be driven out (advances ADR-0023 Phase 1).
- Acceptance Criteria:
  - `experiments/vm-live-status/vm-live-status.sh` streams overall CPU busy% (plus
    LabVIEW cpu/mem + vipm/Xvfb presence) over the bridge and can capture an NDJSON series.
  - `vmStatusAnalysis.mjs` derives contiguous idle vs busy spans, idle %, and the longest
    idle run from a sample series.
  - `validateStatusTimelineReceipt` fails closed unless the committed analysis re-derives
    exactly from the samples and the digest is intact.
  - Live evidence: a real 44s capture on `lba-golden` (a mid-capture CPU burst) yielded
    63.6% idle, two idle spans, longest idle run 18s; the receipt records it.
- Change Guidance: The analyzer `experiments/vm-live-status/vmStatusAnalysis.mjs` plus its
  self-test are gated by `vm-live-status-idle-analysis` in `verify-local-gates` and mapped
  in the RTM. Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-048: Golden-VM Mass Compile benchmark

- Status: Proven
- Area: Deployment / benchmark (ADR-0023 Phase 1 -- the golden VM as a benchmark actor)
- Statement: The system shall benchmark the golden VM by mass-compiling the public
  icon-editor source with LabVIEWCLI, so a fail-closed gate proves the committed benchmark
  result is correctly derived and cross-plane comparable.
- Rationale: The golden VM exists to run objective, reproducible benchmarks -- the North
  Star is cross-plane comparison. A MassCompile of a pinned public source
  (`ni/labview-icon-editor`) is a real LabVIEW workload whose machine-independent result
  (VI count + bad count + success) is comparable across planes, with the compile time as
  the performance metric. This replaces the deferred VI Analyzer benchmark (operator-directed).
- Acceptance Criteria:
  - `LabVIEWCLI -OperationName MassCompile` compiles the icon-editor `resource/` source
    headless-as-actor (Xvfb, VI Server 3363).
  - `massCompileBenchmark.mjs` records the result (directory, VI/CTL count, bad-VI count,
    success) plus a timing-invariant `resultHash` and the compile time.
  - `validateMassCompileReceipt` fails closed unless the `resultHash` re-derives from the
    result, the verdict matches the rule, the bad-VI list is consistent with its count, and
    the digest is intact.
  - Live evidence: MassCompile of `ni/labview-icon-editor` `resource/` on `lba-golden`
    compiled 307 VIs/CTLs with 0 bad and "operation succeeded" in ~24s; the receipt records it.
- Change Guidance: The benchmark validator `experiments/mass-compile/massCompileBenchmark.mjs`
  plus its self-test are gated by `mass-compile-benchmark` in `verify-local-gates` and mapped
  in the RTM. Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-049: Golden-VM provisioner headless-LabVIEW readiness

- Status: Proven
- Area: Deployment / provisioning (ADR-0023 Phase 1 -- the one-command golden VM)
- Statement: The system shall verify the golden-VM provisioner installs every
  headless-LabVIEW prerequisite -- Xvfb, VI Server (TCP 3363) configuration for both LabVIEW
  executable basenames, quoted access lists, and the post-install reboot -- so a fail-closed
  gate proves a fresh one-command provision yields a headless-benchmark-ready VM.
- Rationale: The near-term First Win is a one-command from-scratch golden VM, but a fresh
  provision was NOT headless-ready until three fixes were applied by hand during bring-up:
  Xvfb was missing, the VI Server config had to be written for BOTH `labview.conf` and
  `labviewcommunity.conf` (LabVIEW picks its config file by the launched exe basename), and
  the install needed a reboot before VI Server would bind :3363. Folding those into the
  provisioner and gating its completeness keeps that knowledge from silently regressing.
- Acceptance Criteria:
  - `provision-guest.sh` apt-installs `xvfb` (headless display for `LabVIEWCLI` over SSH).
  - It writes the VI Server config (`server.tcp.enabled`, port 3363, quoted access lists)
    into both `labview.conf` and `labviewcommunity.conf` under the primary user's home.
  - It addresses the post-install reboot (documented, with an opt-in `PROVISION_REBOOT=1`).
  - `validateReadinessReceipt` re-derives the checks from the ACTUAL script text and fails
    closed if any prerequisite is absent, the ready verdict is forged, or the digest is
    tampered.
- Change Guidance: The verifier `experiments/provisioner-readiness/provisionerReadiness.mjs`
  plus its self-test are gated by `provisioner-headless-readiness` in `verify-local-gates`
  and mapped in the RTM. The committed receipt is bound to the real `provision-guest.sh`, so
  editing the provisioner requires regenerating the fixture. Authored under the
  singular-requirement directive (one `shall`).

---

### LBA-REQ-050: Cross-plane benchmark grid

- Status: Proven
- Area: Deployment / cross-plane comparison (ADR-0031; roadmap Phase 4)
- Statement: The system shall unify the golden-VM LabVIEW benchmarks into a cross-plane
  grid that records, per benchmark, the machine-independent identity on each plane and the
  performance metric, so a fail-closed gate proves identities agree across planes and no
  determinism violation is admitted.
- Rationale: The golden VM exists to enable objective, reproducible cross-plane comparison
  -- the North Star. A single generated grid that shows every benchmark's identity
  agreement across planes (proof LabVIEW reproduces) plus its performance (the actual
  benchmark) is the artifact that comparison is for; gating it fail-closed makes a
  cross-plane determinism violation impossible to merge. First slice of the benchmark-grid
  arc (roadmap Phase 4), now proven across the OS axis (Linux + Windows).
- Acceptance Criteria:
  - `benchmarkGrid.mjs` assembles committed per-benchmark cross-plane receipts into a
    `cross-plane-benchmark-grid@1` receipt, deriving each benchmark's identity agreement +
    consensus hash from its planes.
  - The grid is OK iff no benchmark's planes disagree on identity AND at least one
    benchmark is cross-plane-proven (>= 2 agreeing planes).
  - `generate-benchmark-grid.mjs` renders `docs/benchmarks/benchmark-grid.md` and the
    pipeline keeps it current; `validateBenchmarkGrid` fails closed on a determinism
    violation, a forged agreement/verdict, or a tampered digest.
  - Live evidence: VI Analyzer (host + scratch VM) and Mass Compile of the icon-editor
    `resource/` source each agree on identity across their planes; Mass Compile is proven
    across the OS axis -- host + lba-golden (Linux) + win-VITLT-SERGIO (Windows LabVIEW 2026),
    3/3 agreeing on resultHash bf722123; the compile-time delta (39s / 24s / 211s) is the
    performance metric.
- Change Guidance: The grid assembler `experiments/benchmark-grid/benchmarkGrid.mjs` plus
  its self-test are gated by `cross-plane-benchmark-grid` in `verify-local-gates` and
  mapped in the RTM. `docs/benchmarks/benchmark-grid.md` is GENERATED -- never hand-edit;
  re-run `generate-benchmark-grid.mjs`. Authored under the singular-requirement directive
  (one `shall`).

---

### LBA-REQ-051: Icon-editor Packed Library build benchmark

- Status: Proven
- Area: Deployment / benchmark (ADR-0033 -- the 2-actor icon-editor grid, builder actor)
- Statement: The system shall build the ni/labview-icon-editor Editor Packed Library inside
  the NI LabVIEW container as a benchmark, so a fail-closed gate proves the committed build
  result is correctly derived and cross-plane comparable.
- Rationale: The operator-directed 2-actor icon-editor grid reproduces the project's real CI
  -- one actor builds the Packed Project Library (PPL), one runs the LUnit tests. The builder
  is the icon-editor's own "Editor Packed Library" build spec, which native `LabVIEWCLI
  ExecuteBuildSpec` runs in the NI LabVIEW container (`nationalinstruments/labview:2026q1-linux`)
  where LabVIEW is licensed + headless (RunVI known-answer confirmed) -- no g-cli required for
  the build.
- Acceptance Criteria:
  - `LabVIEWCLI -OperationName ExecuteBuildSpec` builds the "Editor Packed Library" spec of
    `lv_icon_editor.lvproj` in the NI container and emits `lv_icon.lvlibp`.
  - `pplBuildBenchmark.mjs` records the machine-independent build identity (project + target +
    build spec + generated artifact + success) plus the build time (and byte size).
  - `validatePplReceipt` fails closed unless the `resultHash` re-derives, the verdict matches
    the rule, and the digest is intact.
  - Live evidence: the NI container built `lv_icon.lvlibp` (2.9 MB) from the pinned icon-editor
    (`9545c483`) in ~59s, `ExecuteBuildSpec operation succeeded`.
- Change Guidance: The builder `experiments/ppl-build/pplBuildBenchmark.mjs` plus its
  self-test are gated by `ppl-build-benchmark` in `verify-local-gates` and mapped in the RTM.
  The companion TESTER actor (LUnit via g-cli) is the next slice per ADR-0033. Authored under
  the singular-requirement directive (one `shall`).

---

### LBA-REQ-052: g-cli launcher built from Rust + proven on host

- Status: Proven
- Area: Deployment / benchmark (ADR-0033 -- the 2-actor icon-editor grid, tester-actor enabler)
- Statement: The system shall build the g-cli launcher from its Rust source and prove it on
  this host, so a fail-closed gate confirms the committed round-trip is correctly derived and
  cross-plane comparable.
- Rationale: The grid's TESTER actor runs the icon-editor LUnit suite via `g-cli ... lunit`.
  On Linux g-cli ships no prebuilt binary: the launcher is the `rust-proxy` crate
  (`G-CLI/G-CLI`) that opens a TCP server, launches LabVIEW on the target VI, and streams the
  VI's arguments / output / exit code back over the socket. Building it from source and
  proving a real LabVIEW round-trip on this host is the enabler for that actor.
- Acceptance Criteria:
  - `cargo build --release` builds the `g-cli` binary from the pinned source.
  - `g-cli` detects the host LabVIEW install and completes a full round-trip: it launches the
    target VI, which echoes the args back over TCP and sets the exit code.
  - `gcliProxyBenchmark.mjs` records the machine-independent proof identity (tool + version +
    source commit + operation + args in + echoed text + exit code + LabVIEW version/bitness).
  - `validateGcliReceipt` fails closed unless the echo matches the args sent, the `resultHash`
    re-derives, the verdict matches the rule, and the digest is intact.
  - Live evidence: g-cli 3.0.1 built from Rust in ~6.7s, then drove host LabVIEW 2026
    (headless) to run `Echo Parameters.vi`, which echoed `hello/from/host` and exited 0.
- Change Guidance: The builder + validator `experiments/g-cli-proxy/gcliProxyBenchmark.mjs`
  plus its self-test are gated by `g-cli-proxy-proof` in `verify-local-gates` and mapped in
  the RTM. With the launcher proven, the tester-actor slice is realized by LBA-REQ-053
  (`g-cli lunit` with the LUnit framework from `icon-editor-developer.vipc`, not
  `runner_dependencies.vipc`). Authored under the
  singular-requirement directive (one `shall`).

---

### LBA-REQ-053: Icon-editor LUnit test benchmark

- Status: Proven
- Area: Deployment / benchmark (ADR-0033 -- the 2-actor icon-editor grid, tester actor)
- Statement: The system shall run the ni/labview-icon-editor LUnit suite via g-cli as a
  benchmark, so a fail-closed gate proves the committed test inventory is correctly derived
  and cross-plane comparable.
- Rationale: This is the TESTER actor of the operator-directed 2-actor icon-editor grid
  (companion to the builder, LBA-REQ-051). The Rust-built g-cli (LBA-REQ-052) runs the
  project's real unit tests via `g-cli lunit`. The LUnit framework is installed from the
  project's CORRECT `icon-editor-developer.vipc` (the developer/test dependency) -- NOT the
  CI-runner `runner_dependencies.vipc`, which needlessly bundles the g-cli VIPM package
  (the launcher is built from Rust) and the PowerShell-automation glue.
- Acceptance Criteria:
  - `g-cli --lv-ver 2026 --arch 64 lunit -- -r <report.xml> lv_icon_editor.lvproj` discovers
    the project's LUnit test classes, runs them, and emits a JUnit report.
  - `lunitTestBenchmark.mjs` records the machine-independent test inventory (sorted
    `class/case` set + suite structure) plus the observed outcomes (passed/failed/errored).
  - `validateLunitReceipt` fails closed unless the inventory length matches the total, the
    `resultHash` re-derives, the verdict matches the rule, and the digest is intact.
  - Live evidence: g-cli lunit ran the suite on `lba-golden` -- 4 LUnit classes / 25 cases
    (10 passed, 2 failed, 8 errored, 5 setup/helper), a well-formed 14.7 KB JUnit report in
    5.4 s. The 8 errors are window-geometry / INI tests that need a real editor window,
    unavailable under headless xvfb.
- Change Guidance: The tester `experiments/lunit-test/lunitTestBenchmark.mjs` plus its
  self-test are gated by `lunit-test-benchmark` in `verify-local-gates` and mapped in the
  RTM. The benchmark asserts the tester actor EXECUTED the suite + produced a well-formed
  report matching its inventory (the machine-independent identity), not that the icon-editor
  tests are all green (outcomes are environment-dependent). With builder (LBA-REQ-051) +
  tester proven, the 2-actor icon-editor grid is complete. Authored under the
  singular-requirement directive (one `shall`).

---

### LBA-REQ-054: Benchmark Observatory (suite-wide coverage + determinism map)

- Status: Proven
- Area: Deployment / benchmark (ADR-0034 -- the observatory above the cross-plane grid)
- Statement: The system shall assemble every committed benchmark receipt into a
  benchmark-type x plane coverage matrix (the Benchmark Observatory), so a fail-closed gate
  proves the suite-wide determinism ledger and coverage are correctly derived.
- Rationale: The suite now spans several benchmark types (VI Analyzer, Mass Compile, the
  icon-editor PPL build + LUnit test) across several planes (bare-metal host, golden VM, NI
  container, Windows). The per-benchmark grid (ADR-0031) proves determinism but offers no
  suite-wide view. One governed artifact must map what has been measured where, whether it
  reproduces, and what to measure next.
- Acceptance Criteria:
  - `benchmarkObservatory.mjs` folds every committed benchmark receipt into a benchmark-type
    x plane coverage matrix, a determinism ledger (identity must agree across a benchmark's
    planes), and a data-driven frontier (the empty cells).
  - The observatory is derived from committed receipts (pure + offline) and the generated
    `docs/benchmarks/benchmark-observatory.md` is regenerated in the `lba verify` pipeline.
  - `validateObservatory` fails closed on a determinism violation, a coverage matrix that
    contradicts the receipts, a stale surface, a forged verdict, or a tampered digest.
  - Derived evidence: 4 benchmark types x 5 planes, 2 cross-plane-proven (Mass Compile 3
    planes, VI Analyzer 2 planes), 2 pending, 0 violations, ~35% cell coverage, 13-cell
    frontier.
- Change Guidance: The `experiments/benchmark-observatory/` model + generator + self-test are
  gated by `benchmark-observatory` in `verify-local-gates` and mapped in the RTM. The
  observatory composes with -- does not replace -- the grid (ADR-0031) + the 2-actor
  icon-editor grid (ADR-0033); new benchmark types / planes / projects slot in as receipts.
  Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-055: Handoff Beacon -- capture-status (human-in-the-loop signal)

- Status: Proven
- Area: Deployment / agentic (ADR-0035 -- the Handoff Beacon Protocol)
- Statement: The system shall emit a machine-readable capture-status beacon for each
  LabVIEW-launch capture (capturing -> stopped/failed), so a fail-closed gate proves the rich
  stop payload (wroteToDisk, peak write throughput + its frame, per-disk breakdown) is
  correctly derived and an agent can await a human-in-the-loop step.
- Rationale: The reviewer VM exists because some steps need a human -- run a VI, then click
  Stop. Those steps are invisible to the agent except through chat, so it guesses or re-asks.
  A capture-status beacon turns the human's Stop into an AWAITED, machine-observable event and
  carries a pointer straight to the evidence (the peak-write frame), so human assistance is
  leveraged efficiently. This is the first instance of the Handoff Beacon Protocol (ADR-0035).
- Acceptance Criteria:
  - `buildCaptureStatus` derives, from the capture's resource samples, `wroteToDisk` (a
    per-disk write rate above a threshold for a minimum number of samples), the peak write
    MB/s + the disk + the frame index where it peaked, and a per-physical-disk write/read peak
    breakdown; `buildCapturingStatus` / `buildFailedStatus` cover the other lifecycle states.
  - The extension writes `capture-status.json` into the run dir at capture START and STOP (or
    FAILED on assembly error), best-effort (never perturbing the capture).
  - `reviewer-workstation/await-handoff.sh` runs the guest poll ONCE and blocks until the
    beacon resolves (stopped|failed) or a timeout, printing the resolved payload -- the one
    sanctioned poll in the agentic flow.
  - `validateCaptureStatus` fails closed on a wrong schema, an unknown state, or a stopped/
    failed beacon missing its payload.
  - On STOP the Frame Correlator opens on the beacon's peak-write frame (derived via
    `peakFrameIndexOf` / `readPeakFrameIndex`, clamped into range by `clampFrameIndex` and
    carried into the correlator model by `buildCorrelatorModel`), so the human + agent land on
    the evidence rather than scrubbing from frame 0.
- Change Guidance: The `experiments/handoff-beacon/` payload builder + self-test are gated by
  `handoff-capture-status` in `verify-local-gates` and mapped in the RTM; the builder is staged
  into `media/` and loaded by `src/extension.ts`. The protocol extends (ADR-0035) with an
  agent->human request beacon, a keyless-signed reviewer verdict beacon, and a bus post; each
  ships as its own governed slice. Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-056: Handoff Beacon -- agent->human request (human-step barrier)

- Status: Proven
- Area: Deployment / agentic (ADR-0036 -- agent->human request beacon, under the Handoff Beacon Protocol ADR-0035)
- Statement: The system shall surface an agent's request for a human step as an in-VM VS Code
  notification whose "Mark step done" / "Skip" actions emit a machine-readable op-done beacon,
  so a fail-closed gate proves the request/answer payloads are correctly derived and the agent
  can await a human-in-the-loop step it initiated.
- Rationale: The capture-status beacon (LBA-REQ-055) let the agent AWAIT a human step (Stop).
  This closes the OTHER direction: the agent's ASK -- "run this VI", "activate LabVIEW", "log in
  to VIPM" -- was invisible except through chat, so it re-asked and wasted turns. Making the ask
  a first-class, in-VM, machine-observable event (a reusable human-step BARRIER) lets the agent
  request a manual step and resume exactly when the human answers.
- Acceptance Criteria:
  - `buildAgentRequest` / `buildOpDone` derive the `agent-request@1` / `op-done@1` payloads;
    `validateAgentRequest` / `validateOpDone` fail closed on a wrong schema, an empty id/title,
    or an unknown outcome; `selectPendingRequest` returns the newest unanswered request
    (deterministic), so an answered ask is never re-surfaced.
  - The extension watches `handoff/requests/` and surfaces the newest pending request as a
    `showInformationMessage` with "Mark step done" (prompts an optional note) and "Skip"; both
    actions are also palette commands (`labviewBenchmarkActor.markStepDone` / `.skipStep`), so
    the barrier is answerable without a mouse; the answer is written to `handoff/done/<id>.json`.
  - `reviewer-workstation/request-step.sh` writes the request beacon into the VM (via the same
    pure builder) and runs the guest poll ONCE, blocking until the op-done answer resolves
    (`done|skipped`) or a bounded timeout -- the one sanctioned poll in the flow.
- Change Guidance: The `experiments/handoff-beacon/handoffRequest.mjs` builder + self-test are
  gated by `handoff-request` in `verify-local-gates` and mapped in the RTM; the builder is staged
  into `media/` and loaded by `src/extension.ts`. This is the agent->human tier of the Handoff
  Beacon Protocol (ADR-0035); the keyless-signed reviewer verdict beacon + the bus post ship as
  their own governed slices. Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-057: Handoff Beacon -- reviewer visual verdict (signed human PASS/FAIL)

- Status: Proven
- Area: Deployment / agentic (ADR-0037 -- reviewer visual verdict beacon, under the Handoff Beacon Protocol ADR-0035)
- Statement: The system shall emit a signed reviewer visual verdict (`reviewer-verdict@1` mapping to
  `acg-human-signoff-v1`) for an extension release candidate, so a fail-closed gate proves the human's
  PASS/FAIL of the built candidate is Ed25519-signed by an enrolled reviewer and gates the release
  alongside the plane agreement.
- Rationale: The reviewer VM exists for the human's VISUAL PASS/FAIL of a candidate -- the thing the
  whole reviewer gate is for. That verdict was informal (a chat "looks good" or a hand-edited
  release-agreement signoff). Making it a signed, candidate-bound, verifiable artifact turns the human
  gate into a governed release input, and -- because enrolled Ed25519 needs no OIDC -- it is signed IN
  the VM where the human is (keyless cosign layers on in CI).
- Acceptance Criteria:
  - `buildReviewerVerdict` / `validateReviewerVerdict` derive the candidate-bound verdict (target
    component/version/commit/vsixSha256 + evidence), fail-closed; `reviewerVerdict.mjs` is
    dependency-free so it stages into the extension's `media/` and signs headless.
  - `signReviewerVerdict` maps the verdict to an `acg-human-signoff-v1` bound to its canonical digest
    (a `pass` is an `approve`); `verifyReviewerVerdict` fails closed on a wrong schema, a tampered
    verdict, an un-enrolled reviewer, a mismatched key, or a bad signature.
  - `gateVisualReview` publishes only on a `pass` verdict with >= minReviewers verified enrolled
    approvals; `release-with-review.mjs`'s `gateReleaseWithReview` composes it with the ADR-0018
    `gateReleasePublish` so the machine corroboration and the human's PASS are independently required.
  - The extension's Render Reviewer Verdict command signs the verdict in the VM (enrolled reviewer
    key) into `handoff/verdicts/`; `reviewer-workstation/render-verdict.sh` sets the target + collects
    it; `tools/collab-cli/verify-visual-review.mjs` gates a release's `visualReview` block against the
    committed `reviewer-allowlist.json`; CI keyless-cosign counter-signs the verdict bundle.
- Change Guidance: `experiments/handoff-beacon/reviewerVerdict.mjs` + its self-test are gated by
  `handoff-verdict` and mapped in the RTM; the builder is staged into `media/` + loaded by
  `src/extension.ts`. Reviewer keys are enrolled via `reviewer-workstation/enroll-reviewer.mjs` (the
  private key stays local; the public key is committed to `reviewer-allowlist.json`). This is the
  verdict tier of the Handoff Beacon Protocol (ADR-0035); the `lbabus` post ships as its own governed
  slice. Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-058: Handoff Beacon -- reviewer verdict bus announcement

- Status: Proven
- Area: Deployment / agentic (ADR-0038 -- reviewer verdict bus announcement, under the Handoff Beacon Protocol ADR-0035)
- Statement: The system shall announce a signed reviewer verdict on the `lbabus` coordination bus with
  a semantic message type (pass -> RESOLVED, changes -> REFINE, fail -> BLOCKED) carrying the full
  signed verdict, so a fail-closed gate proves the announcement is correctly derived and remote actors
  see the human's PASS/FAIL.
- Rationale: The reviewer's signed verdict (LBA-REQ-057) stayed local (a file + the release-agreement);
  the `lbabus` bus (a GitHub Discussion the WIN + LINUX planes read) is how the actors coordinate, so a
  remote actor had no way to see that a human reviewed + PASSED (or blocked) a candidate. Announcing the
  verdict makes it an actionable coordination event -- the final tier of the Handoff Beacon Protocol.
- Acceptance Criteria:
  - `buildVerdictBusPost` derives the `lbabus post` from a signed verdict record `{ verdict, signOff }`:
    a SEMANTIC `type` by verdict (RESOLVED/REFINE/BLOCKED), `task` = `<component>-release-<version>`,
    `ref` = the candidate commit, `priority`; an unknown/malformed record fails safe to BLOCKED.
  - The message BODY posted is the FULL signed verdict JSON (`--message-file`), so the bus carries the
    verifiable `acg-human-signoff-v1` + `reviewer-verdict@1`, not just a summary.
  - The extension posts the verdict from the reviewer VM immediately after signing, BEST-EFFORT (a
    missing `lbabus` / GH token is logged, never thrown into the signing flow); the release CI posts it
    automatically after `verify-visual-review` (`post-verdict.mjs`, `continue-on-error`). Both derive
    the post from the same `buildVerdictBusPost`.
- Change Guidance: `buildVerdictBusPost` lives in the staged, gated `reviewerVerdict.mjs` (gate
  `handoff-verdict`, self-test 7/7); `src/extension.ts` (`busPostArgs` + `postVerdictToBus`) +
  `reviewer-workstation/post-verdict.mjs` + the `extension-release.yml` bus step are mapped in the RTM.
  This is the FINAL tier of the Handoff Beacon Protocol (ADR-0035). Authored under the
  singular-requirement directive (one `shall`).

---

### LBA-REQ-059: Host<->VM-agent closed loop over the lbabus net TCP bus

- Status: Proven
- Area: Deployment / agentic (ADR-0039 -- host<->VM-agent closed loop over TCP, off GitHub Discussions)
- Statement: The system shall close the host<->VM-agent coordination loop over the `lbabus net` TCP bus --
  after driving the reviewer VM's Copilot agent, the host awaits the agent's reply frame correlated by task
  id (fail-closed on mismatch/timeout), and the signed reviewer verdict announces with a semantic net type
  (RESOLVED/REFINE/BLOCKED) -- so a fail-closed gate proves the read-back + the semantic types are correctly
  derived and coordination rides TCP, not a GitHub Discussion.
- Rationale: `drive-agent-chat.sh` drove the VM's chat FIRE-AND-SCREENSHOT (a human read PNGs); there was no
  programmatic read-back, so the host agent could not close the loop. The verdict announcement (LBA-REQ-058)
  rode a GitHub Discussion; an operator directive ("TCP, deprecate the use of github discussions") moves
  coordination onto the private TCP bus that already exists (`lbabus net`, LBA-REQ-007, ADR-0003/0004).
- Acceptance Criteria:
  - `await-agent-reply.mjs` runs `lbabus net listen`, parses the rendered frame, and returns the VM agent's
    reply CORRELATED by `--task` + `--type`; it FAILS CLOSED on a task mismatch or a timeout (never accepts an
    uncorrelated frame as the answer).
  - `drive-agent-closed-loop.sh` composes the two halves: it starts the awaiter, then keyboard-injects the
    prompt PLUS a deterministic report-back line (single-line; a newline would submit early) so the VM agent
    replies over TCP.
  - The `net` envelope type set carries RESOLVED/REFINE/BLOCKED (option A), so a signed verdict announces over
    `net` as a first-class semantic event (pass->RESOLVED), preserving ADR-0038's semantics off the Discussion bus.
  - Comms-only holds (ADR-0003): the reply/announcement is a one-line status only, never run data.
- Change Guidance: `await-agent-reply.mjs` (+ `.selftest.mjs`), `drive-agent-closed-loop.sh`, and
  `closed-loop-readback-proof.sh` live under `reviewer-workstation/`; the net type set is `BusWire.Types` in
  `tools/collab-cli/Net.cs`. The FULL retirement of the GitHub-Discussion transport is deferred (ADR-0039
  Consequences). Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-060: Live-only net coordination -- the receive-log + net poll read side

- Status: Proven
- Area: Deployment / agentic (ADR-0040 -- live-only net coordination, off GitHub Discussions)
- Statement: The system shall provide a live-only net coordination read side -- a per-actor local receive-log
  written by `lbabus net listen --log` and read by `lbabus net poll` (filtered by type/task; fail-closed
  without a log) -- so a fail-closed gate proves post->log->poll round-trips over TCP and coordination reads no
  longer depend on a GitHub Discussion.
- Rationale: ADR-0039 moved the host<->VM-agent loop + the reviewer-verdict announcement onto `net` TCP; an
  operator directive ("TCP, deprecate the use of github discussions") moves the rest of coordination off
  Discussions. A Discussion did two jobs -- live relay + async persistence; `net send`/`listen` already cover
  the live relay, but the READ side (poll) had no net equivalent. The operator chose a LIVE-ONLY model (no
  central/async store): each actor logs what it hears while online.
- Acceptance Criteria:
  - `net listen --log <file>` appends every received frame to a per-actor JSONL receive-log (BusWire.ToJson),
    best-effort (a log error never breaks the listener).
  - `net poll [--log <file>] [--tail N] [--type T] [--task T]` reads + filters the local receive-log
    (BusWire.FromJson), mirroring the Discussion `poll` UX; with no log it prints nothing + exits 0; with no
    `--log`/`VIHS_COLLAB_NET_LOG` it FAILS CLOSED.
  - Comms-only holds (ADR-0003): the receive-log stores only small coordination frames, never run data.
  - Accepted tradeoff: a peer offline at post time misses the frame -- no async catch-up.
- Change Guidance: `CmdListen --log` + `CmdPoll` + `BusWire.ToJson`/`FromJson` live in
  `tools/collab-cli/Net.cs`; the loopback proof is `experiments/net-coordination/net-coordination-log-proof.sh`
  (committed receipt `net-coordination-log-receipt.json`). This is the FIRST increment of retiring the
  GitHub-Discussion transport (ADR-0040); the call-site migrations + removal are deferred. Authored under the
  singular-requirement directive (one `shall`).

---

### LBA-REQ-061: Bus transport selection in the extension -- Discussion default, net opt-in

- Status: Proven
- Area: Deployment / agentic (ADR-0041 -- bus transport selection, off GitHub Discussions step 2)
- Statement: The system shall let the extension select the coordination-bus transport -- GitHub Discussion
  (default) or the live-only `lbabus net` TCP bus (opt-in via `busTransport`/`busNetHosts`/`busNetLog`) -- so
  `postNote`/`pollBus`/the reviewer-verdict announcement ride `net send`/`net poll` when configured, and a
  fail-closed gate proves the switch + the Discussion-safe default.
- Rationale: ADR-0040 gave `net` a live-only coordination model; the extension still shelled the
  GitHub-Discussion `post`/`poll` for `pollBus`/`postNote`/the verdict announcement. Step 2 of the
  off-Discussions migration lets the extension select the transport WITHOUT breaking existing users -- the
  Discussion stays the default; `net` is opt-in during the transition.
- Acceptance Criteria:
  - Config `labviewBenchmarkActor.busTransport` (`discussion` default | `net`) + `busNetHosts` (CSV peer
    host(s)) + `busNetLog` (local receive-log path).
  - Under `net`: `postNote` -> `net send --hosts <hosts> --type NOTE`; `pollBus` -> `net poll --log <log>`;
    the verdict announcement -> `busSendArgs` (`net send --type <RESOLVED/...> --task <release-task>
    --message-file <verdict>`), reusing the semantic net types (ADR-0039).
  - The Discussion default is unchanged (no user-facing change; the remediation-on-ENOENT + `busPostArgs`
    tests still hold); the verdict announcement stays best-effort.
- Change Guidance: `busConfig` + `busSendArgs` + the transport branches live in `src/extension.ts`; the config
  is in `package.json`; `busSendArgs` + the branches are unit-covered in `test/extension-activation.mjs`; gate
  `bus-transport-select`. The MCP tools + `post-verdict.mjs` + the release CI are the NEXT increments (ADR-0041
  Consequences). Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-062: MCP coordination tools transport selection -- Discussion default, net opt-in

- Status: Proven
- Area: Deployment / agentic (ADR-0042 -- MCP transport selection, off GitHub Discussions step 3)
- Statement: The system shall let the extension's MCP coordination tools select the transport -- the provider
  passes the bus-transport config as env (`VIHS_COLLAB_TRANSPORT`/`VIHS_COLLAB_NET_HOSTS`/`VIHS_COLLAB_NET_LOG`)
  and the stdio server routes `poll_coordination_bus`/`post_coordination_note` to `net poll`/`net send` under
  `net` (Discussion default) -- so the agent tool surface coordinates over TCP when configured, proven by a
  fail-closed gate.
- Rationale: ADR-0041 migrated the extension's own commands to a selectable transport; the extension's MCP
  server -- a separate stdio process that cannot read vscode config directly -- still shelled the
  GitHub-Discussion `poll`/`post`. Step 3 migrates the agent tool surface too, via env passed at launch.
- Acceptance Criteria:
  - `busEnvFromConfig` (provider) maps `busTransport`/`busNetHosts`/`busNetLog` to `VIHS_COLLAB_TRANSPORT`/
    `VIHS_COLLAB_NET_HOSTS`/`VIHS_COLLAB_NET_LOG`, set on the launched `McpStdioServerDefinition` env; empty
    values omitted (Discussion default).
  - `pollBusArgs`/`postNoteArgs` (server) route `poll_coordination_bus` -> `net poll --log` and
    `post_coordination_note` -> `net send --hosts` under `net`, else the Discussion `poll`/`post`.
  - The tool schemas + the MCP tool doc are unchanged; tools stay soft-`isError` on a missing CLI.
- Change Guidance: `busTransport`/`pollBusArgs`/`postNoteArgs` in `src/mcp/runBenchmarkActorMcpServer.ts`;
  `busEnvFromConfig` + the env-passing `provideMcpServerDefinitions` in
  `src/mcp/benchmarkActorMcpServerProvider.ts`; unit-covered in `test/mcp-server.mjs`; gate
  `mcp-net-transport`. `post-verdict.mjs` + the release CI + the Discussion-transport removal are the NEXT
  increments (ADR-0042 Consequences). Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-063: post-verdict.mjs transport selection -- Discussion default, net opt-in

- Status: Proven
- Area: Deployment / agentic (ADR-0043 -- post-verdict transport selection, off GitHub Discussions step 4)
- Statement: The system shall let the reviewer-workstation verdict announcer (`post-verdict.mjs`) select the
  transport -- GitHub Discussion (default) or the live-only `lbabus net` TCP bus (opt-in via
  `VIHS_COLLAB_TRANSPORT`/`VIHS_COLLAB_NET_HOSTS`) -- so a signed verdict announces via `net send` with the same
  semantic type when configured, and a fail-closed gate proves the argv under both transports.
- Rationale: ADR-0041/0042 migrated the extension's own commands + its MCP tools; the reviewer verdict is also
  announced via `post-verdict.mjs` (the release CI calls it `--print-args`; a reviewer can run it by hand),
  which still built only the Discussion `post` argv. Step 4 makes it transport-selectable too.
- Acceptance Criteria:
  - Under `VIHS_COLLAB_TRANSPORT=net`, `post-verdict.mjs` emits `net send [--hosts <peers>] --type <RESOLVED/...>
    --task <release-task> --message-file <verdict>` (the net envelope carries no priority/ref -- they live in
    the signed verdict JSON); else the Discussion `post` argv (with `--priority`/`--ref`).
  - `--print-args` / `--dry-run` / the default post all honor the transport.
  - The Discussion default is unchanged, so the release CI (which runs `--print-args`) is unchanged.
- Change Guidance: the transport branch is in `reviewer-workstation/post-verdict.mjs`; gate
  `post-verdict-net-transport`. The release-CI announce under live-only (no net peer in CI; the committed signed
  verdict is the durable record) + deprecating/removing the Discussion transport are the NEXT increments
  (ADR-0043 Consequences). Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-064: Drop the release-CI GitHub-Discussion verdict announce

- Status: Proven
- Area: Deployment / agentic (ADR-0044 -- drop the release-CI Discussion announce, off GitHub Discussions step 5)
- Statement: The system shall NOT announce the reviewer verdict to a GitHub Discussion from the release publish
  workflow -- the durable record of the human PASS is the committed signed verdict (release-agreement
  `visualReview`, keyless counter-signed); under the live-only net model CI has no bus peer -- so a fail-closed
  gate proves the publish workflow carries no GitHub-Discussion announce.
- Rationale: ADR-0038 had the release CI announce the signed verdict to the `lbabus` GitHub-Discussion bus. The
  off-Discussions migration (ADR-0040..0043) moved coordination onto the live-only `net` bus, but CI runs in
  ephemeral Actions with no persistent `net` peer -- a net announce there has no listener. The human PASS is
  already durably recorded as the committed signed verdict (gated by verify-visual-review + keyless
  counter-signed), so the CI announce is redundant + is dropped.
- Acceptance Criteria:
  - The `Set up .NET` + `Announce the reviewer verdict on the coordination bus` steps are removed from
    `.github/workflows/extension-release.yml`; the publish pipeline touches no GitHub Discussion.
  - The committed signed verdict (staged for keyless counter-sign + committed in the release-agreement) remains
    the durable record; `verify-visual-review` still gates the release.
  - Off-CI, the live announce stays available via `post-verdict.mjs`/the extension over `net` (ADR-0041/0043).
- Change Guidance: the removal is in `.github/workflows/extension-release.yml`; gate
  `release-no-discussion-announce`. Supersedes the CI-announce portion of ADR-0038/LBA-REQ-058. The FINAL step
  -- deprecating + removing the Discussion transport (Program.cs + GraphQL) + the CI mock GraphQL harness -- is
  deferred (ADR-0044 Consequences). Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-065: Flip the coordination default to net + graceful no-op when unconfigured

- Status: Proven
- Area: Deployment / agentic (ADR-0045 -- flip the coordination default to net, off GitHub Discussions step 6)
- Statement: The system shall default the coordination-bus transport to the live-only `lbabus net` TCP bus
  (GitHub Discussion becomes a legacy opt-out) AND degrade gracefully when net is unconfigured -- `net poll`
  with no receive-log and `net send --skip-if-no-peer` with no peer both exit 0 with a hint (no error, no dead
  loopback) -- so a fresh install coordinates over TCP once a peer/log is set and does nothing quietly until then.
- Rationale: off-Discussions steps 1-5 (ADR-0040..0044) made `net` available in the extension, the MCP surface,
  and post-verdict.mjs, and dropped the release-CI Discussion announce -- but each kept Discussion the DEFAULT
  (opt-in net) during the transition. With the net loop proven live (ADR-0039) + no CI Discussion use, the only
  thing pinning Discussion as the default is inertia. Flipping naively would error/hang an unconfigured install
  (net poll no-log was fail-closed; net send no-peer sat in a dead loopback), so the flip is paired with a
  graceful no-op.
- Acceptance Criteria:
  - `labviewBenchmarkActor.busTransport` defaults to `net`; the extension, the MCP provider + stdio server, and
    post-verdict.mjs all default to `net`; Discussion is the legacy opt-out (`busTransport: "discussion"` /
    `VIHS_COLLAB_TRANSPORT=discussion`).
  - `net poll` with no receive-log exits 0 with a hint (softened from fail-closed); `net send --skip-if-no-peer`
    with no peer exits 0 with a hint; the extension/MCP/post-verdict callers pass `--skip-if-no-peer` when no
    host is configured -- an unconfigured net-default install is a silent no-op.
  - `npm test` proves the extension + MCP default flip; the net-coordination-log receipt proves the graceful
    poll (`pollWithoutLogGraceful`).
- Change Guidance: the flip is in package.json + src/extension.ts + src/mcp/* + reviewer-workstation/post-verdict.mjs;
  the graceful branches are in tools/collab-cli/Net.cs. Gates `net-default-graceful` + `bus-transport-select`
  (default === 'net'). Updates the ADR-0041/0042/0043 defaults + softens the ADR-0040 poll fail-closed. The FINAL
  step -- deprecating + removing the Discussion transport (Program.cs + GraphQL) + the CI mock GraphQL harness --
  is deferred (ADR-0045 Consequences). Authored under the singular-requirement directive (one `shall`).

---

### LBA-REQ-066: Collapse the coordination product surface to net-only

- Status: Proven
- Area: Deployment / agentic (ADR-0046 -- collapse the product surface to net-only, off GitHub Discussions step 7)
- Statement: The system shall coordinate over the live-only `lbabus net` TCP bus ONLY across its product surface
  (the extension commands + the MCP coordination tools + the reviewer verdict announcer) -- the GitHub-Discussion
  transport opt-out is removed (no `busTransport` selection, no consumer builds a Discussion `post`/`poll` argv)
  -- so a fail-closed gate proves the product surface is net-only.
- Rationale: off-Discussions steps 1-6 (ADR-0040..0045) made `net` the default with Discussion a legacy opt-out,
  but the product surface still carried the Discussion arms (the extension's busPostArgs + busTransport
  selection, the MCP tools' VIHS_COLLAB_TRANSPORT selection, post-verdict.mjs's post --priority/--ref branch).
  With net proven live (ADR-0039) + the default (ADR-0045), the opt-out is dead weight on the surface users +
  agents actually touch. Removing it is the first half of the final teardown, split from the CLI transport
  removal (step 8) because the CLI's Discussion commands share GitHubGraphQL.cs with selfcheck/defect + the ci
  mock harness.
- Acceptance Criteria:
  - The `labviewBenchmarkActor.busTransport` setting is removed; `busNetHosts`/`busNetLog` remain.
  - The extension (`busConfig` -> {netHosts, netLog}; pollBus -> `net poll`, postNote + verdict -> `net send`;
    no `busPostArgs`), the MCP provider + stdio server (`busEnvFromConfig` maps only NET_HOSTS/NET_LOG;
    `pollBusArgs`/`postNoteArgs` net-only; no `VIHS_COLLAB_TRANSPORT`), and `post-verdict.mjs` (`net send` only,
    no `--priority`/`--ref`) build only the net argv.
  - The graceful no-op (ADR-0045) is preserved (`--skip-if-no-peer`; `net poll` no-log exits 0).
- Change Guidance: the collapse is in package.json + src/extension.ts + src/mcp/* + reviewer-workstation/post-verdict.mjs;
  gates `bus-transport-select` + `mcp-net-transport` + `post-verdict-net-transport` (now net-only) +
  `net-default-graceful`, unit-covered by test/extension-activation.mjs + test/mcp-server.mjs. Supersedes the
  transport-selection portion of ADR-0041/0042/0043. The FINAL step -- removing the Discussion transport from
  the CLI (Program.cs post/poll/wait/init/delta + GitHubGraphQL Discussion methods) + the ci mock GraphQL
  harness + collab-cli docs -- is deferred (ADR-0046 Consequences, step 8). Authored under the
  singular-requirement directive (one `shall`).

---

### LBA-REQ-067: Remove the GitHub-Discussion transport from the lbabus CLI

- Status: Proven
- Area: Deployment / agentic (ADR-0047 -- remove the CLI Discussion transport, off GitHub Discussions step 8 / final)
- Statement: The system shall NOT expose a GitHub-Discussion coordination transport from the `lbabus` CLI -- the
  `init`/`post`/`poll`/`wait`/`delta` subcommands and the GraphQL Discussion client are removed (GitHubGraphQL
  keeps only the REST release-tag + issue-comment calls for `selfcheck`/`defect`), leaving the live-only
  `lbabus net` TCP bus as the sole coordination transport -- so a fail-closed gate proves the CLI carries no
  Discussion transport.
- Rationale: step 7 (ADR-0046) made the coordination product surface net-only, leaving the CLI's own Discussion
  commands (init/post/poll/wait/delta) reachable by nothing in the product. This final step removes them + the
  GraphQL Discussion client, completing the off-Discussions migration (steps 1-8). GitHubGraphQL.cs was shared:
  selfcheck reads release tags (REST) + defect appends an issue comment (REST) -- those keepers stay.
- Acceptance Criteria:
  - `Program.cs` no longer dispatches `init`/`post`/`poll`/`wait`/`delta` (the `Cmd*` methods + help entries +
    the `EnforceVersionOrNull` guard + the `ParseAll`/`SeedBody`/`Eq`/`Dur` helpers are gone); `version`/
    `capabilities`/`selfcheck`/`grep`/`defect`/`net`/`resource`/`agents`/`docs` remain.
  - `GitHubGraphQL.cs` is REST-only (drops the Discussion records + `Query`/`ResolveContext`/`FindDiscussion`/
    `CreateDiscussion`/`EnsureDiscussion`/`ListComments`/`AddComment`; keeps `ListReleaseTags` + `AddIssueComment`);
    `Config.cs` drops the discussion-only fields (`Category`/`Title`/`AgentId`/`Counterpart`/`AddressesMe`).
  - The 12 discussion / version-guard ci cases are retired (the grep + defect + runner-meta cases remain); the
    build + a CLI smoke test verify the removal.
- Change Guidance: the removal is in tools/collab-cli/{Program.cs, GitHubGraphQL.cs, Config.cs} + the ci cases;
  gate `cli-no-discussion-transport`. A doc/cleanup follow-up (step 8b) sweeps the stale docs (collab-cli
  README/AGENTS.md, ci/README.md, docs/mcp-tools.md, reviewer-manual-test-plan.md, root README.md) + trims the
  ci mock's vestigial GraphQL/release handlers + retires experiments/ollama-bus/bus-agent.mjs -- none block a
  gate. Completes the off-Discussions migration. Authored under the singular-requirement directive (one `shall`).

### LBA-REQ-068: Net-only live VM-agent drive (govern the released-CLI closed loop as a committed receipt)

- Status: Proven
- Area: Deployment / agentic (ADR-0049 -- net-only live VM-agent drive, off GitHub Discussions -- productized)
- Statement: The system shall record, as a committed fail-closed receipt, that the host drove the reviewer VM's
  Copilot agent to run the RELEASED net-only `lbabus` (collab-cli 0.15.0, pulled from the immutable
  `collab-cli-v0.15.0` GitHub Release) and the VM reported task-correlated results back over the `lbabus net`
  TCP bus -- the sole coordination path, since the released CLI rejects the retired
  `init`/`post`/`poll`/`wait`/`delta` Discussion commands -- so a fail-closed gate proves the end-to-end
  net-only drive loop is reproducible off any GitHub-Discussion dependency.
- Rationale: LBA-REQ-059 (ADR-0039) proved the host<->VM-agent read-back CORRELATION, but while the CLI still
  shipped a GitHub-Discussion transport (the VM ran lbabus 0.13.0). The off-Discussions migration then completed
  (LBA-REQ-060..067) and collab-cli 0.15.0 shipped net-only (`collab-cli-v0.15.0`); the host drove the reviewer
  VM to INSTALL + VALIDATE that released binary over `net` (install, benchmark re-drive 2604.2 ms/5 PASS, and
  the WIN 0.15.0 sign-off). That capability was proven live but ungoverned -- the receipts lived in `/tmp`.
- Acceptance Criteria:
  - A committed receipt (`reviewer-workstation/net-only-live-drive-receipt.json`, schema
    `net-only-live-drive-receipt@1`) seals >=1 drive from the reviewer VM (senderId `WIN`, matched) over `net`
    plus the released-CLI net-only proof (`releaseTag: collab-cli-v0.15.0`; `init`/`post`/`poll`/`wait`/`delta`
    recorded rejected; an observed `unknown command` on the VM).
  - The verifier (`net-only-live-drive.mjs`) re-derives the digest + verdict DETERMINISTICALLY (no VM / network)
    and FAILS CLOSED on a drive that did not close the loop (a non-`WIN` sender, a disallowed net type, an
    unmatched reply), an incomplete net-only proof, a forged verdict, or a tampered digest (selftest 7/7).
  - Comms-only holds (ADR-0003): each VM reply is a one-line status only, never run data.
- Change Guidance: the verifier + selftest + receipt live under `reviewer-workstation/`
  (`net-only-live-drive.mjs` / `.selftest.mjs` / `net-only-live-drive-receipt.json`); gate `net-only-live-drive`
  in `verify-local-gates`. Refreshing to a future release = re-run the drives (`drive-agent-closed-loop.sh` +
  `await-agent-reply.mjs`) against the new binary + rebuild the receipt with the new `releaseTag`. Authored
  under the singular-requirement directive (one `shall`).

### LBA-REQ-069: Release-with-review drive (bind the net-staged candidate to the signed + announced verdict)

- Status: Proven
- Area: Deployment / agentic (ADR-0050 -- release-with-review drive, off GitHub Discussions -- productized)
- Statement: The system shall record, as a committed fail-closed receipt, that ONE release-with-review loop is
  bound to a single candidate over the net-only bus -- the reviewer VM staged the candidate over `lbabus net`, a
  human Ed25519-signed a visual PASS/FAIL of THAT candidate (component/version/commit/vsixSha256), and the signed
  verdict announced over `net` with its semantic type -- so a fail-closed gate proves the staged, signed, and
  announced candidate are the SAME (no stage-one / sign-another / announce-a-third).
- Rationale: LBA-REQ-068 (stage over net), LBA-REQ-057 (signed visual verdict), and LBA-REQ-058 (bus announce)
  were each proven in ISOLATION; nothing bound them to one candidate in one loop, so -- in principle -- the VM
  could stage candidate A, the human sign B, and the bus announce C. `release-with-review.mjs`
  (`gateReleaseWithReview`) composes the visual verdict with the MACHINE gate (`gateReleasePublish`, ADR-0018),
  not with a net-staged candidate.
- Acceptance Criteria:
  - A committed receipt (`reviewer-workstation/release-with-review-drive-receipt.json`, schema
    `release-with-review-drive-receipt@1`) binds a matched `WIN` staging drive over `net` (LBA-REQ-068) to a
    signed reviewer verdict (LBA-REQ-057) whose `target` is the SAME candidate, and to a `net` announce
    (LBA-REQ-058) correctly derived from the signed verdict (type/task/ref).
  - The verifier (`release-with-review-drive.mjs`) REUSES `verifyReviewerVerdict` / `gateVisualReview` /
    `buildVerdictBusPost` and FAILS CLOSED on a candidate the verdict did not cover, a sign-off that does not
    verify against the enrolled key, a gate that would not publish, a mis-derived announce, or a tampered digest;
    it re-derives the binding + verdict + digest DETERMINISTICALLY (no VM / network / live human). Selftest 7/7.
  - Comms-only holds (ADR-0003): the staged + announced frames are one-line status frames, never run data.
- Change Guidance: the verifier + selftest + receipt live under `reviewer-workstation/`
  (`release-with-review-drive.mjs` / `.selftest.mjs` / `release-with-review-drive-receipt.json`); gate
  `release-with-review-drive` in `verify-local-gates`. The verdict signing scheme is REUSED unchanged from
  `experiments/handoff-beacon/reviewerVerdict.mjs` (LBA-REQ-057/058). Refreshing to a future release = a new
  candidate identity + a fresh signed verdict + a fresh staging drive. Authored under the singular-requirement
  directive (one `shall`).

### LBA-REQ-070: Composite release decision (bind the machine corroboration gate to the human visual gate over one net-staged candidate)

- Status: Proven
- Area: Deployment / agentic (ADR-0051 -- composite release decision, off GitHub Discussions -- productized)
- Statement: The system shall record, as a committed fail-closed receipt, that a release candidate publishes
  ONLY when BOTH the machine corroboration gate (a quorum verdict + an enrolled sign-off over it, ADR-0018) AND
  the human visual gate (an enrolled signed PASS of the built candidate, LBA-REQ-057) pass, AND both name the
  SAME net-staged candidate (LBA-REQ-068/069) -- so a fail-closed gate proves the machine quorum, the human
  visual verdict, and the net stage all name one candidate (no machine-PASS-A + human-PASS-B).
- Rationale: `gateReleaseWithReview` already ANDs the machine gate (`gateReleasePublish`, ADR-0018) + the visual
  gate (`gateVisualReview`, ADR-0037), but ANDs two INDEPENDENT decisions -- nothing checks that the machine
  quorum consensus (version + sourceCommit), the visual verdict target (component/version/commit/vsixSha256), and
  the net-staged candidate are the SAME candidate, so -- in principle -- a machine PASS of candidate A could be
  published with a human PASS of candidate B.
- Acceptance Criteria:
  - A committed receipt (`reviewer-workstation/composite-release-decision-receipt.json`, schema
    `composite-release-decision-receipt@1`) records a passing machine gate (`gateReleasePublish`: quorum PASS +
    an enrolled sign-off over the quorum digest) AND a passing visual gate (`gateVisualReview`: an enrolled signed
    PASS), for ONE candidate.
  - The verifier (`composite-release-decision.mjs`) REUSES `gateReleaseWithReview` and FAILS CLOSED unless BOTH
    gates publish AND the machine quorum consensus (version + sourceCommit), the visual verdict target, and a
    matched `WIN` net staging drive all name the SAME candidate; it re-derives the decision + binding + digest
    DETERMINISTICALLY (no VM / network / live human). Selftest 7/7.
  - Comms-only holds (ADR-0003): the staging frame is a one-line status frame, never run data.
- Change Guidance: the verifier + selftest + receipt live under `reviewer-workstation/`
  (`composite-release-decision.mjs` / `.selftest.mjs` / `composite-release-decision-receipt.json`); gate
  `composite-release-decision` in `verify-local-gates`. The machine gate (`experiments/acg-reviewer/sign-off.mjs`),
  the visual gate + composer (`experiments/handoff-beacon/reviewerVerdict.mjs` + `release-with-review.mjs`), and
  the candidate-binding helpers (`reviewer-workstation/release-with-review-drive.mjs`) are all REUSED unchanged.
  Authored under the singular-requirement directive (one `shall`).

### LBA-REQ-071: Enforce the composite release decision in the extension release workflow

- Status: Proven
- Area: Deployment / agentic (ADR-0052 -- enforce the composite release decision, off GitHub Discussions -- productized)
- Statement: The extension release workflow shall block publishing a `.vsix` unless a committed composite
  release-decision proves BOTH gates pass for the tagged candidate version -- the `agreement` job runs
  `verify-composite-release.mjs` (fail-closed) and the publish `release` job depends on `agreement` -- so no
  extension release publishes without the bound composite decision (LBA-REQ-070).
- Rationale: LBA-REQ-070 (ADR-0051) GOVERNED the composite decision (machine + human gates, bound to one
  net-staged candidate) as a committed receipt + a CI gate, but that only proves the PATTERN in the local-gate
  suite; nothing BLOCKED a real publish. `extension-release.yml` already enforces the WIN<->LINUX plane agreement
  (`verify-release-agreement.mjs`) + the human visual verdict (`verify-visual-review.mjs`) in its `agreement`
  job, with `release` `needs: [build, agreement]`; the composite decision was not yet in that publish-gating chain.
- Acceptance Criteria:
  - `tools/collab-cli/verify-composite-release.mjs --component <name> <version>` REUSES the gated composite
    `validateReceipt` and requires the committed composite receipt to NAME the tagged candidate AND be a proven
    composite decision; it exits 0 (cleared to publish) or 1 (fail-closed) -- e.g. a version with no matching
    proven decision is blocked.
  - `extension-release.yml`'s `agreement` job runs `verify-composite-release.mjs --component extension <version>`
    (after `verify-visual-review`), and the `release` (publish) job `needs: [build, agreement]`, so the composite
    decision gates the publish.
  - The gate `composite-release-enforced` proves both DETERMINISTICALLY (no network): the CLI clears the
    committed ext 0.5.0 candidate + fails closed for a version with no decision, and the workflow wires the CLI in
    the publish-gating agreement job.
- Change Guidance: the enforcement CLI is `tools/collab-cli/verify-composite-release.mjs` (REUSES
  `reviewer-workstation/composite-release-decision.mjs`); the workflow step is in
  `.github/workflows/extension-release.yml`; gate `composite-release-enforced` in `verify-local-gates`. A future
  release adds its own committed composite receipt before it can publish. Authored under the singular-requirement
  directive (one `shall`).

### LBA-REQ-072: Cross-plane launch-benchmark parity (identity is the spec, not the series)

- Status: Proven
- Area: Deployment / benchmark (ADR-0053 -- cross-plane launch-benchmark parity, roadmap Phase 2/4)
- Statement: The system shall prove that a Linux and a Windows launch-to-ready benchmark receipt measure the SAME
  benchmark via a machine-independent launch identity (metric + workload + sample count) -- so their
  plane-specific timings are legitimately comparable -- and a fail-closed gate rejects an identity mismatch, a
  non-cross-plane pair, or a tampered receipt.
- Rationale: cross-plane PARITY is governed for benchmarks whose measured value is deterministic + plane-INDEPENDENT
  (the mprr ring-buffer `seriesHash`, LBA-REQ-014; the VI Analyzer `resultHash`, LBA-REQ-015/043). The flagship
  exact-12-FPS launch-to-ready benchmark (`workload-trend@1`, metric `launchMs`) measures a plane-DEPENDENT quantity
  (~2604 ms Linux vs ~2410 ms Windows), so there is no identical series/result to anchor -- and the existing launch
  cross-plane receipts compare timing/resource deltas as WITNESSES, proving nothing about whether the two planes ran
  the SAME benchmark (the precondition that makes their timings comparable).
- Acceptance Criteria:
  - `launchParity.mjs`'s `launchIdentity` = sha256 over `{ metric, workload, n }` (the benchmark spec),
    deliberately EXCLUDING the plane-dependent timing, the plane, and the hypervisor; two planes running the same
    launch benchmark share it.
  - A committed receipt (`experiments/launch-parity/cross-plane-launch-parity-receipt.json`, schema
    `cross-plane-launch-parity-receipt@1`) proves parity iff both receipts are valid `workload-trend@1`, they are
    cross-plane (one LINUX + one WIN), and their launch identities match; it records the plane means + the signed
    delta + the faster plane as performance WITNESSES. It fails closed on an identity mismatch, a non-cross-plane
    pair, an invalid trend, or a tampered digest (selftest 7/7).
  - The committed receipt is DERIVED FROM the committed launch-trend fixtures (`experiments/launch-parity/fixtures/{linux,win}-launch-trend.json`);
    the gate re-derives it and asserts the plane means equal the real trend means (non-fabricable).
- Change Guidance: the verifier + selftest + receipt live under `experiments/launch-parity/`
  (`launchParity.mjs` / `.selftest.mjs` / `cross-plane-launch-parity-receipt.json`); gate
  `cross-plane-launch-parity` in `verify-local-gates`. A new plane joins by emitting a `workload-trend@1` with the
  same `{ metric, workload, n }`. Complements (does not duplicate) the deterministic-series parity of
  LBA-REQ-014/015/043. Authored under the singular-requirement directive (one `shall`).

### LBA-REQ-073: Mesh-run cross-plane fulfillment (the North Star loop)

- Status: Proven
- Area: Deployment / mesh (ADR-0054 -- mesh-run cross-plane fulfillment, roadmap Phase 3)
- Statement: The system shall prove fulfillment of a DISPATCHED cross-plane benchmark run by validating that
  >= N distinct enrolled mesh actors from the requested planes each returned a valid plane-tagged receipt for the
  SAME benchmark identity -- so a fail-closed gate proves the mesh run was fulfilled by enough independent
  cross-plane actors, with no central results database (the returned receipts ARE the result).
- Rationale: the North Star is a horizontally-scaled, sandbox-isolated actor mesh -- a requester dispatches a
  cross-plane benchmark run and independent volunteer golden-VM actors return plane-tagged receipts (roadmap
  Phase 3, the section-8 metric "a requester dispatches a run and receives >= 2 independent, plane-tagged receipts
  from volunteer actors"). The pieces existed but were uncomposed: LBA-REQ-039 enrolls an actor (not fulfillment);
  LBA-REQ-040/041 prove distributed shards + routing among ripgrep-only instances (not benchmark receipts);
  LBA-REQ-018 proves CLAIM/ACK/DONE dispatch for uplift/doc/test domains (not benchmark-mesh fulfillment).
- Acceptance Criteria:
  - A committed receipt (`experiments/mesh-fulfillment/mesh-run-fulfillment-receipt.json`, schema
    `mesh-run-fulfillment-receipt@1`) records a dispatch (`benchmarkId` + benchmark spec + `minActors` +
    `requestedPlanes`) and the actors' returned runs; it is FULFILLED iff >= `minActors` DISTINCT enrolled actors
    responded, the requested planes are covered, each returned a valid plane-tagged `workload-trend@1` (plane
    matching the actor), and all actors share the dispatched benchmark identity.
  - `meshFulfillment.mjs` REUSES the LBA-REQ-072 `launchIdentity` (`sha256` over metric + workload + n) as the
    cross-actor agreement invariant, and FAILS CLOSED on too few actors, a duplicate actor, an uncovered plane, an
    invalid receipt, an identity disagreement, or a tampered digest (selftest 7/7); the verdict + digest re-derive
    DETERMINISTICALLY (no VM / network / central DB at gate time).
  - The committed receipt seals a REAL run: `labview-ide-launch` fulfilled by `golden-linux` (LINUX) + `golden-win`
    (WIN), each embedding its real plane-tagged launch-trend receipt.
- Change Guidance: the verifier + selftest + receipt live under `experiments/mesh-fulfillment/`
  (`meshFulfillment.mjs` / `.selftest.mjs` / `mesh-run-fulfillment-receipt.json`); gate
  `mesh-run-cross-plane-fulfillment` in `verify-local-gates`. Composes LBA-REQ-039 (actor identity) + LBA-REQ-018
  (dispatch primitives) + LBA-REQ-072 (benchmark identity). The GitHub-native `repository_dispatch` transport is
  the next Phase-3 increment. Authored under the singular-requirement directive (one `shall`).

### LBA-REQ-074: GitHub-native mesh-run dispatch transport (repository_dispatch)

- Status: Proven
- Area: Deployment / mesh (ADR-0055 -- GitHub-native mesh-run dispatch transport, roadmap Phase 3)
- Statement: The system shall dispatch a cross-plane benchmark run GitHub-natively via a `repository_dispatch`
  event carrying a validated `mesh-run-dispatch@1` request bound to its fulfillment, and gate the returned
  receipts on cross-plane fulfillment -- so a fail-closed gate proves the dispatch->fulfill loop is wired with no
  central server (the repo IS the queue).
- Rationale: LBA-REQ-073 governs the FULFILLMENT half of the North Star loop, but the GitHub-native DISPATCH
  transport did not exist -- no `.github/workflows/` used `repository_dispatch`, and there was no committed
  dispatch-request contract binding a dispatch to its fulfillment. The roadmap dispatches on-demand runs through
  the repo (`repository_dispatch` / Actions as the queue) -- no server, fully auditable, "coordinate runs, don't
  hoard data".
- Acceptance Criteria:
  - `meshDispatch.mjs` validates a `mesh-run-dispatch@1` request (`benchmarkId` + `{ metric, workload, n }` spec +
    `minActors` >= 1 + a non-empty valid `requestedPlanes` set + a `dispatchId`) fail-closed, and carries the same
    `launchIdentity` (LBA-REQ-072) as the fulfillment so a dispatch + its fulfillment are provably the SAME run.
  - `.github/workflows/mesh-run.yml` triggers on `repository_dispatch` (event type `mesh-run`; the client_payload
    IS the request), validates the dispatch (`meshDispatch.mjs`), then gates the returned receipts on cross-plane
    fulfillment (`meshFulfillment.mjs`, LBA-REQ-073).
  - The gate `mesh-run-dispatch-wired` proves offline: the request validates + fails closed on a malformed request;
    the committed request BINDS to the LBA-REQ-073 fulfillment (same `benchmarkId` + identity + `minActors` +
    planes); and `mesh-run.yml` is wired (triggers on `repository_dispatch[mesh-run]` + runs both verifiers).
- Change Guidance: the verifier + selftest + committed request live under `experiments/mesh-fulfillment/`
  (`meshDispatch.mjs` / `.selftest.mjs` / `mesh-run-dispatch-request.json`); the workflow is
  `.github/workflows/mesh-run.yml`; gate `mesh-run-dispatch-wired` in `verify-local-gates`. The live fan-out
  (actor tasking + receipt collection as Actions artifacts) is the next Phase-3 increment. Authored under the
  singular-requirement directive (one `shall`).

### LBA-REQ-075: The mesh coverage observatory (fold the mesh-run receipts into a coverage matrix)

- Status: Proven
- Area: Deployment / mesh (ADR-0056 -- the mesh coverage observatory, roadmap Phase 3->4)
- Statement: The system shall fold the governed mesh-run receipts (dispatch, fulfillment, cross-plane parity)
  into a coverage matrix + a consistency ledger -- which benchmarks x which planes x how many actors fulfilled,
  and whether each run's dispatch/fulfillment/parity name the SAME identity -- so a fail-closed gate proves the
  operator-facing mesh dashboard reflects the receipts it summarizes.
- Rationale: the mesh dispatch->fulfill loop is closed (LBA-REQ-072/073/074) but those receipts live as three
  separate artifacts; there is no single governed view answering the operator's question -- which benchmarks have
  been fulfilled, across which planes, by how many actors, and does each run cohere. The benchmark observatory
  (LBA-REQ-054) established the single-plane pattern; the mesh needs its counterpart (roadmap Phase 3->4:
  cross-plane comparison AT SCALE).
- Acceptance Criteria:
  - `meshObservatory.mjs` folds each mesh run -- its dispatch (`mesh-run-dispatch@1`), fulfillment
    (`mesh-run-fulfillment-receipt@1`), and parity (`cross-plane-launch-parity-receipt@1`) -- into a coverage row
    (benchmark id + identity, dispatched, fulfilled, distinct actors, covered planes, parity proven, and a
    `consistent` flag true iff a dispatch + a fulfilled fulfillment are present and every artifact names the SAME
    identity), and derives a coverage matrix + a consistency ledger.
  - The verifier FAILS CLOSED on a run whose dispatch/fulfillment/parity disagree on identity, an un-fulfilled run
    counted coherent, a miscounted coverage statistic, a stale re-fold (the committed observatory must reproduce
    byte-for-byte from the committed source receipts), or a tampered digest.
  - The gate `mesh-coverage-observatory` proves offline: the selftest (7/7); the committed observatory validates +
    is coherent; coverage spans the fulfilled benchmarks across the LINUX + WIN planes; and the folded row is
    grounded in the real LBA-REQ-073 fulfillment (same identity + actor count + covered planes).
- Change Guidance: the verifier + selftest + committed observatory live under `experiments/mesh-fulfillment/`
  (`meshObservatory.mjs` / `.selftest.mjs` / `mesh-coverage-observatory-receipt.json`); gate
  `mesh-coverage-observatory` in `verify-local-gates`. Folding additional fulfilled runs extends the matrix with
  no new machinery. Authored under the singular-requirement directive (one `shall`).

### LBA-REQ-076: The live fan-out contract (actor-tasking + receipt-collection)

- Status: Proven
- Area: Deployment / mesh (ADR-0057 -- the live fan-out contract, roadmap Phase 3)
- Statement: The system shall expand a validated mesh-run dispatch into per-plane actor tasking and validate the
  returned-receipt collection that feeds fulfillment, both identity-bound to the dispatch -- so a fail-closed gate
  proves every collected receipt provably descends from the dispatched tasks and ran the SAME benchmark.
- Rationale: the mesh dispatch->fulfill loop is governed at its two ends (dispatch LBA-REQ-074 + fulfillment
  LBA-REQ-073) but the MIDDLE was not -- nothing governed how a validated dispatch is expanded into per-actor
  tasking, nor how the actors' returned plane-tagged receipts are collected back into the fulfillment input. The
  roadmap live fan-out (task volunteer actors through the repo, collect their receipts as run artifacts) needs an
  identity-bound, fail-closed contract for the tasking + the collection.
- Acceptance Criteria:
  - `meshFanout.mjs` DERIVES an `actor-tasking@1` set from a validated dispatch: one task per requested plane,
    each carrying the `dispatchId`, the `benchmarkId` + `{ metric, workload, n }` spec, the plane, and the
    dispatched `launchIdentity` (LBA-REQ-072). `validateTasking` fails closed on an unbound task, an invalid or
    duplicate plane, a non-canonical `taskId`, a spec that does not hash to the identity, uncovered planes, or a
    tampered digest.
  - `meshFanout.mjs` maps a `receipt-collection@1` -- each returned plane-tagged receipt back to its task,
    producing the `{ actorId, plane, receipt }` set `meshFulfillment` consumes. `validateCollection` fails closed
    on a collected receipt with no matching task, a plane mismatch, an invalid trend, an identity mismatch, a
    duplicate actor, an uncovered tasked plane, or a tampered digest.
  - The gate `mesh-live-fanout-wired` proves offline: the selftest (7/7); the committed tasking + collection
    validate; the tasking re-derives from the committed dispatch (currency); the fan-out is identity-bound
    end-to-end; the collection RECONSTRUCTS the committed LBA-REQ-073 fulfillment (grounding); and `mesh-run.yml`
    runs the fan-out step.
- Change Guidance: the verifier + selftest + committed tasking/collection live under
  `experiments/mesh-fulfillment/` (`meshFanout.mjs` / `.selftest.mjs` / `mesh-run-tasking.json` /
  `mesh-run-collection.json`); the workflow step is in `.github/workflows/mesh-run.yml`; gate
  `mesh-live-fanout-wired` in `verify-local-gates`. Wiring the actors to actually run their task + upload their
  receipt slots into the collection contract with no new governance. Authored under the singular-requirement
  directive (one `shall`).

### LBA-REQ-077: The opt-in verified tier (enrolled-actor receipt attestations)

- Status: Proven
- Area: Deployment / mesh (ADR-0058 -- the opt-in verified tier, roadmap Phase 3)
- Statement: The system shall admit a returned mesh-actor receipt into a verified collection only when it carries a
  valid attestation from its declared, enrolled actor -- so a fail-closed gate proves each collected receipt
  provably came from a REAL enrolled actor (not a fabricated trend).
- Rationale: the fan-out collection (LBA-REQ-076) proves a returned receipt is identity-bound + structurally valid,
  and fulfillment (LBA-REQ-073) proves enough distinct actors responded, but nothing proves a receipt actually came
  from a REAL enrolled actor -- a rogue or buggy participant could fabricate a plausible plane-tagged trend. A
  public volunteer mesh with no central server needs each receipt cryptographically bound to the enrolled actor
  that produced it. The ADR-0016 acg-provenance enrolled-key attestation engine already provides this and is reused.
- Acceptance Criteria:
  - `meshVerifiedTier.mjs` attests each returned receipt with the actor's ENROLLED Ed25519 key by REUSING the
    ADR-0016 `signBundle` (an `acg-witness-attestation-v1` whose subject digest is the canonical digest of the
    exact receipt, whose `witnessIdentity` is the actor id).
  - A `verified-receipt-collection@1` binds a validated LBA-REQ-076 collection (by digest) to one attestation per
    collected receipt; `validateVerifiedCollection` requires the collection to validate, the wrapper to bind to it,
    and -- for every collected receipt -- a valid attestation from its declared, enrolled actor (via
    `verifyWitnessAttestation` against `mesh-actor-keys.json`). It fails closed on an unsigned/forged receipt, an
    un-enrolled actor, a key that does not match the enrolled one, an attestation not by the declared actor, an
    orphan attestation, or a tampered digest.
  - The gate `mesh-verified-tier-attested` proves offline: the selftest (7/7); the committed verified collection
    re-verifies against the committed collection + enrolled keys; every collected receipt is attested by its
    declared enrolled actor; and `mesh-run.yml` runs the verified-tier step. The enrolled PUBLIC keys are committed;
    the private keys are not.
- Change Guidance: the verifier + selftest + committed verified collection + enrolled keys live under
  `experiments/mesh-fulfillment/` (`meshVerifiedTier.mjs` / `.selftest.mjs` / `mesh-run-verified-collection.json` /
  `mesh-actor-keys.json`); the workflow step is in `.github/workflows/mesh-run.yml`; gate
  `mesh-verified-tier-attested` in `verify-local-gates`. Enrolling an actor is publishing its public key to
  `mesh-actor-keys.json`. Authored under the singular-requirement directive (one `shall`).

### LBA-REQ-078: Transparency-log the mesh-actor attestations (public auditability)

- Status: Proven
- Area: Deployment / mesh (ADR-0059 -- transparency-log the mesh-actor attestations, roadmap Phase 3)
- Statement: The system shall admit a verified mesh-actor attestation only when it carries an inclusion proof
  against a transparency-log tree head signed by the enrolled log key -- so a fail-closed gate proves the mesh
  receipts are enrolled-signed AND publicly auditable (append-only, tamper-evident).
- Rationale: the verified tier (LBA-REQ-077) binds each returned receipt to its enrolled actor, but the SET of
  attestations is not publicly auditable -- a compromised actor key could sign a receipt, and nothing records the
  attestations in an append-only, tamper-evident log a third party can audit. Release provenance already solved
  this with the ADR-0022 acg-transparency signed Merkle log (record attestations + admit only with an inclusion
  proof against the signed tree head); the mesh reuses it.
- Acceptance Criteria:
  - `meshTransparency.mjs` records each verified-tier attestation into an RFC-6962 signed Merkle transparency log
    by REUSING the ADR-0022 `recordRelease` (the Merkle tree over the attestation entry leaves + a tree head signed
    by the enrolled log key + a per-attestation inclusion proof).
  - A `logged-verified-collection@1` binds a validated LBA-REQ-077 verified collection (by digest) to the signed
    tree head + one inclusion proof per attestation; `validateLoggedCollection` requires the verified tier to hold,
    the wrapper to bind to it, the signed tree head to verify against the enrolled log key, and -- for every
    attestation -- a valid inclusion proof against that signed root. It fails closed on an unsigned/wrong-key tree
    head, a missing or non-reconstructing inclusion proof, a tree-size mismatch, a binding mismatch, or a tampered
    digest.
  - The gate `mesh-attestations-transparency-logged` proves offline: the selftest (7/7); the committed logged
    collection re-verifies (signed tree head + every inclusion proof); the tree logs every attestation; and
    `mesh-run.yml` runs the transparency step. The enrolled log PUBLIC key is committed; the private key is not.
- Change Guidance: the verifier + selftest + committed logged collection + log key live under
  `experiments/mesh-fulfillment/` (`meshTransparency.mjs` / `.selftest.mjs` / `mesh-run-logged-collection.json` /
  `mesh-log-key.json`); the workflow step is in `.github/workflows/mesh-run.yml`; gate
  `mesh-attestations-transparency-logged` in `verify-local-gates`. A consistency proof between successive tree
  heads (the engine already provides it) extends this to an append-only history. Authored under the
  singular-requirement directive (one `shall`).

---

## Traceability (requirement → architecture view / test)

| Requirement | Architecture view | Test items |
| --- | --- | --- |
| LBA-REQ-001 | Packaging / boundary | T-001 |
| LBA-REQ-002 | Deployment | T-002 |
| LBA-REQ-003 | Actor / run-result | T-003 |
| LBA-REQ-004 | Viewer (cursor) | T-004 |
| LBA-REQ-005 | Viewer (picture panel) | T-005 |
| LBA-REQ-006 | Multi-VM topology | T-006 |
| LBA-REQ-007 | Coordination transport | T-007 |
| LBA-REQ-008 | CM / move | T-008 |
| LBA-REQ-009 | Storage (mprr ring buffer) | T-009 |
| LBA-REQ-010 | Analysis (concentration + ollama) | T-010 |
| LBA-REQ-011 | Analysis (resource correlation) | T-011 |
| LBA-REQ-012 | Agentic infra (base instructions) | T-012 |
| LBA-REQ-013 | Agentic infra (coordination bus) | T-013 |
| LBA-REQ-014 | Analysis (cross-plane compare) | T-014 |
| LBA-REQ-015 | Analysis (VI Analyzer benchmark) | T-015 |
| LBA-REQ-016 | CM (GitFlow branch governance) | T-016 |
| LBA-REQ-017 | Authoring lane (dependency manifest) | T-017 |
| LBA-REQ-018 | Provider delegation (cleanroom AI uplift) | T-018 |
| LBA-REQ-019 | Agentic infra (MCP tool surface) | T-019 |
| LBA-REQ-020 | CM (bidirectional release sign-off) | T-020 |
| LBA-REQ-021 | Assurance (test-to-requirement correspondence) | T-021 |
| LBA-REQ-022 | Assurance (generated traceability matrix) | T-022 |
| LBA-REQ-023 | Corroboration grid (multi-witness release) | T-023 |
| LBA-REQ-024 | Corroboration grid (quorum + confidence) | T-024 |
| LBA-REQ-025 | Corroboration grid (provenance + attestation) | T-025 |
| LBA-REQ-026 | Corroboration grid (witness independence) | T-026 |
| LBA-REQ-027 | Corroboration grid (reviewer + sign-off) | T-027 |
| LBA-REQ-028 | Corroboration grid (mesh verdict beacon) | T-028 |
| LBA-REQ-029 | Agentic infra (MCP grid surface) | T-029 |
| LBA-REQ-030 | CM (PRs target develop) | T-030 |
| LBA-REQ-031 | Corroboration grid (transparency log + verify-before-install) | T-031 |
| LBA-REQ-032 | Analysis (mesh-stress signature) | T-032 |
| LBA-REQ-033 | Deployment (personal golden-VM onboarding) | T-033 |
| LBA-REQ-034 | CM / assurance (26514 information for users) | T-034 |
| LBA-REQ-035 | Assurance (generated test report + status accounting) | T-035 |
| LBA-REQ-036 | CM (release procedure) | T-036 |
| LBA-REQ-037 | Assurance (continuous compliance self-audit) | T-037 |
| LBA-REQ-038 | Deployment (LabVIEW activation confirmation) | T-038 |
| LBA-REQ-039 | Deployment (mesh-actor registration) | T-039 |
| LBA-REQ-040 | Deployment (distributed parallel workload) | T-040 |
| LBA-REQ-041 | Deployment (capability-aware routing) | T-041 |
| LBA-REQ-042 | Deployment (cross-plane LabVIEW liveness) | T-042 |
| LBA-REQ-043 | Deployment (cross-plane VI Analyzer determinism) | T-043 |
| LBA-REQ-044 | Deployment (provisioner installs LabVIEW + VIPM) | T-044 |
| LBA-REQ-045 | Deployment (human-assisted VM bridge) | T-045 |
| LBA-REQ-046 | Deployment (VIPM functionally installs a community package) | T-046 |
| LBA-REQ-047 | Deployment (live VM status + idle-time analysis) | T-047 |
| LBA-REQ-048 | Deployment (golden-VM Mass Compile benchmark) | T-048 |
| LBA-REQ-049 | Deployment (provisioner headless-LabVIEW readiness) | T-049 |
| LBA-REQ-050 | Deployment (cross-plane benchmark grid) | T-050 |
| LBA-REQ-051 | Deployment (icon-editor Packed Library build) | T-051 |
| LBA-REQ-052 | Deployment (g-cli launcher built from Rust) | T-052 |
| LBA-REQ-053 | Deployment (icon-editor LUnit test) | T-053 |
| LBA-REQ-054 | Deployment (benchmark observatory) | T-054 |
| LBA-REQ-055 | Deployment (handoff beacon) | T-055 |
| LBA-REQ-056 | Deployment (handoff beacon -- agent->human request) | T-056 |
| LBA-REQ-057 | Deployment (handoff beacon -- reviewer visual verdict) | T-057 |
| LBA-REQ-058 | Deployment (handoff beacon -- reviewer verdict bus announcement) | T-058 |
| LBA-REQ-059 | Deployment (host<->VM-agent closed loop over TCP) | T-059 |
| LBA-REQ-060 | Deployment (live-only net coordination read side) | T-060 |
| LBA-REQ-061 | Deployment (extension bus transport selection) | T-061 |
| LBA-REQ-062 | Deployment (MCP tools transport selection) | T-062 |
| LBA-REQ-063 | Deployment (post-verdict transport selection) | T-063 |
| LBA-REQ-064 | Deployment (drop release-CI Discussion announce) | T-064 |
| LBA-REQ-065 | Deployment (flip coordination default to net + graceful no-op) | T-065 |
| LBA-REQ-066 | Deployment (collapse coordination product to net-only) | T-066 |
| LBA-REQ-067 | Deployment (remove CLI Discussion transport) | T-067 |
| LBA-REQ-068 | Deployment (net-only live VM-agent drive) | T-068 |
| LBA-REQ-069 | Deployment (release-with-review drive) | T-069 |
| LBA-REQ-070 | Deployment (composite release decision) | T-070 |
| LBA-REQ-071 | Deployment (enforce composite release decision) | T-071 |
| LBA-REQ-072 | Deployment (cross-plane launch benchmark parity) | T-072 |
| LBA-REQ-073 | Deployment (mesh-run cross-plane fulfillment) | T-073 |
| LBA-REQ-074 | Deployment (GitHub-native mesh-run dispatch) | T-074 |
| LBA-REQ-075 | Deployment (mesh coverage observatory) | T-075 |
| LBA-REQ-076 | Deployment (live fan-out contract) | T-076 |
| LBA-REQ-077 | Deployment (opt-in verified tier) | T-077 |
| LBA-REQ-078 | Deployment (mesh attestation transparency log) | T-078 |
