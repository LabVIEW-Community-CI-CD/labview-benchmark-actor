# ADR-0014: Actor Corroboration Grid — multi-witness release corroboration

- Status: Accepted
- Date: 2026-08-01
- Deciders: LINUX plane (operator-directed; 9-round design interview)
- Relates to: LBA-REQ-023 (umbrella), ADR-0010 (branch governance), ADR-0011 (provider-delegation cleanroom uplift), ADR-0012 (MCP tool surface), ADR-0013 (correspondence graph); extends the cross-plane compare (LBA-REQ-014) and the reviewer manual gate.

## Context

The repository proves a release on **one** VirtualBox Ubuntu cleanroom plus a Windows reviewer VM. A single
cleanroom is a single point of trust: if that one environment is mis-provisioned, drifted, or compromised, its
"pass" is unwitnessed. ISO/IEC/IEEE 42010:2022 gives us correspondences to relate architecture-description
elements; the repo already ships the ingredients of *independent, multi-environment* corroboration but has not
composed them into a release gate:

- **Cross-plane digest agreement** — the deterministic `seriesHash` must match across planes while the per-plane
  screenshot is a witness ([LBA-REQ-014](../requirements/srs.md); [experiments/benchmark-store/compare-cross-plane.mjs](../../experiments/benchmark-store/compare-cross-plane.mjs)).
- **A from-source cleanroom bootstrap that self-certifies** via a `gate-suite-receipt.json` verdict ([cleanroom/ubuntu-labview/provision-lbabus-fromsource.sh](../../cleanroom/ubuntu-labview/provision-lbabus-fromsource.sh)).
- **Headless deterministic viewer rendering** + per-plane receipts ([playwright/screenshot.mjs](../../playwright/screenshot.mjs)), a **corroboration-confidence** reference ([experiments/corroboration-confidence-reference.mjs](../../experiments/corroboration-confidence-reference.mjs)), **ephemeral-mesh** spin-up/teardown ([experiments/ephemeral-mesh/](../../experiments/ephemeral-mesh/)), a **verdict beacon over the lbabus bus** (`LBA_GATE_BEACON_HOSTS`), and **boot-benchmark milestones** (`emit-boot-marker.sh`).

Nothing yet composes these into an independent, forgery-resistant, gate-worthy corroboration of a release.

## Decision

Adopt the **Actor Corroboration Grid (ACG)** — an operator-invoked platform in which independent, heterogeneous
**witnesses** corroborate a component release, and their agreement is a signed, attestable **quorum** that gates
the release. The umbrella requirement is **LBA-REQ-023**.

Core model:

- **Witnesses** — initially three heterogeneous nodes: a GitHub **Codespace** (Linux), the **VirtualBox** Ubuntu
  cleanroom (Linux), and the **Windows** plane; extensible to N-of-M and, later, additional providers. Each
  witness builds `lbabus` from the same source@commit, self-certifies via the shared gate-suite, renders the
  deterministic viewer, and emits a signed receipt bundle.
- **Anchors, tiered by OS** — OS-independent anchors (viewer `seriesHash`, `lbabus` version + `sourceCommit`,
  gate-suite `verdict`) must agree across **all** witnesses; Linux-only anchors (the pinned-render-stack
  `pngSha256`, the Ubuntu codename) must agree across the Linux subset; hardware capability, host, and
  timestamps are recorded witnesses, never gated.
- **Quorum + confidence** — a graded confidence (matched dimensions / total) with a majority threshold
  (**≥2 of 3** for the initial grid); a sub-majority **blocks** the release and opens a divergence issue.
- **Provenance** — each witness signs its receipt bundle (sigstore keyless where an OIDC identity exists, an
  enrolled per-witness key otherwise); the aggregated quorum verdict, the release artifacts, and the human
  sign-off are attested; provenance is stored on the GitHub Release, in the repo, in a sigstore transparency
  log, and on the lbabus mesh ledger; consumption **verifies the attestation before install**.
- **Independence** — a valid quorum must span distinct environments (provider/OS diversity; N-of-a-kind is
  rejected), each witness's identity is recorded, and witnesses are enrolled in an allowlist, so agreement
  cannot be forged by one actor.
- **Human layer** — the human visual gate runs on **either** the Windows reviewer VM **or** a zero-install
  Linux browser codespace (reviewer's choice); the signed human sign-off is a **separate** gate layered on top
  of the machine quorum.
- **What it gates** — the extension `.vsix`, the `collab-cli` release, and a unified **attested release bundle**
  tying artifact + provenance + quorum verdict.

This umbrella decision is refined by focused **sub-ADRs** (to follow): the quorum + confidence model,
provenance/attestation, witness-independence, the reviewer station, the mesh integration, and the MCP
orchestration surface (extending ADR-0012).

Delivery is **design-first** and **phased**: Phase 1 stands up the Codespace witness + machine parity (the
single-witness building block); Phase 2 the quorum + confidence engine; Phase 3 provenance/attestation; Phase 4
the reviewer station + mesh + MCP. Multi-cloud reach, a reusable kit, and a multi-reviewer human quorum are
roadmap.

## Consequences

- Release confidence stops depending on a single cleanroom; a drifted or forged witness is detected as a
  **quorum divergence** rather than silently trusted.
- The grid **reuses existing primitives** (cross-plane compare, gate-suite receipt, deterministic viewer,
  ephemeral-mesh, the verdict beacon, boot-benchmark) rather than adding new transports.
- New governed requirements (an LBA-REQ family from LBA-REQ-023) and sub-ADRs land **per phase**, each wired
  into the 42010 correspondence graph (AD-1 / VW-1 / CM-1), so the platform's own traceability cannot rot.
- Pixel-level cross-Linux agreement (`pngSha256` fail-closed) requires a **pinned render stack** and may need
  iteration; until pinned, it is carried as a witness.
- The platform is **operator-invoked** (not automatic CI), keeping cost bounded and a human in the loop.

## Alternatives considered

- **Keep the single VBox cleanroom + Windows reviewer.** Rejected: a single witness is an unwitnessed single
  point of trust; the operator directed independent corroboration.
- **Automate a full ephemeral CI matrix on every push.** Rejected for now: the operator chose on-demand
  invocation to bound cost and keep human judgment in the loop; the ephemeral mechanism is built, but triggered
  deliberately.
- **A single monolithic ADR for the whole platform.** Rejected: the platform spans distinct concerns (quorum,
  provenance, independence, reviewer, mesh, MCP); an umbrella ADR plus focused sub-ADRs keeps each decision
  reviewable and independently traceable.
- **Adopt an external attestation / ALM platform.** Rejected: violates the dependency-free local-gate doctrine
  and the standalone-repository boundary (LBA-REQ-001 / LBA-REQ-008); the grid composes in-repo primitives plus
  standard sigstore verification.
