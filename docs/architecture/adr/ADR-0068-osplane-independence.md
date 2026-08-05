# ADR-0068: Corroboration independence is the OS-plane — a cross-plane quorum needs both windows and linux (LBA-REQ-026)

- Status: Accepted
- Date: 2026-08-04
- Deciders: operator (interview 2026-08-04 — "a plane is wherever the extension is installed"; the VMware Ubuntu guest is the LINUX plane; the shipped 1.0.0 corroboration is a defect needing a re-seal) + agent
- Relates to: LBA-REQ-026 (witness-independence — corrected here), ADR-0017 (the original independence definition this SUPERSEDES), LBA-REQ-024 (the quorum this feeds), LBA-REQ-023 / LBA-REQ-025 / LBA-REQ-027 / LBA-REQ-028 (the corroboration stages that compose independence), ADR-0067 / LBA-REQ-086 (cross-plane byte-reproducibility — the enabler that lets a two-plane quorum attest ONE identical artifact)

## Context

ADR-0017 defined witness independence as diversity across a `plane/os` "environment" — and the enrolled set
listed `CODESPACE/linux`, `VBOX/linux`, `WIN/windows`, `LINUX/linux`. But `plane` there is a **context/hypervisor
label** (codespace, vbox, vmware), not the axis that matters. The operator's model (interview 2026-08-04) is that
**a plane is the OS the extension RUNS in** — exactly two, **windows** and **linux** — and the hypervisor
(VirtualBox/VMware/Codespace/native) is a provisioning attribute, not a plane. A VMware Ubuntu guest is the
**linux** plane; N linux contexts (a codespace + a vbox guest + a native host) are **one** linux plane.

Under the old definition the engine counted `CODESPACE/linux` and `LINUX/linux` as two "distinct environments", so
a quorum of two linux witnesses was reported as independent and corroborated. That is false diversity: they run on
the same substrate. Every committed ACG corroboration (`independence-receipt`, `corroboration-receipt`, the mesh
loopback, the grid run, and the shipped **1.0.0** quorum) was built from **linux-only** witness pairs — so their
`independent`/`distinctEnvironments: true` claims did not hold. The operator called the 1.0.0 corroboration a
**defect** requiring a genuine two-plane re-seal.

## Decision

- **Independence is measured on the OS-plane, not on plane/os.** `experiments/acg-independence/independence.mjs`
  now keys on `planeOf(bundle) = bundle.os` (windows|linux); a quorum is independent iff it spans `>= quorumMin`
  distinct enrolled OS-planes — with only two planes, that means **both linux AND windows**. A second witness on
  an already-counted plane collapses (redundant for plane diversity). `enrolled-environments.json` is the two
  planes {linux, windows}; the hypervisor is a recorded attribute.
- **The quorum requires cross-plane too.** `experiments/acg-quorum/compare-witnesses.mjs` reports `crossPlane`
  (distinct OS-planes >= 2) and a corroboration verdict PASSES only when the witnesses are cross-plane (in addition
  to anchor concurrence, consensus gate pass, and confidence). The same correction applies to the throughput-ladder
  corroboration (`compare-ladders.mjs`).
- **Re-state the live evidence honestly.** The committed DEV witness grid is `{codespace, host-linux}` — both the
  linux plane — so it is **single-plane** and, under the corrected engine, is correctly NOT independent / NOT
  cross-plane corroborated. The DEV receipts are regenerated to these truthful values and the live gates
  (`acg-independence-live`, `acg-quorum-live-corroboration`, `acg-provenance-verify-before-consume`,
  `acg-mesh-loopback-evidence`, `acg-grid-run-live`, `acg-reviewer-release-decision`) now assert that the ACG
  **fails closed on single-plane evidence** (the anchors still agree — confidence ~0.92 — but a single plane is not
  a corroboration). The selftests prove the engine ACCEPTS a genuine windows+linux quorum.

## Consequences

- **The corroboration guarantee is now honest.** The ACG withholds machine-corroboration until two genuinely
  distinct OS-planes agree; a linux-only grid can no longer be reported as independently corroborated.
- **The live cross-plane corroboration is PENDING a windows-plane witness.** No committed witness bundle has
  `os: windows`, so a genuine two-plane LIVE quorum requires producing a windows-plane witness (the operator drives
  the Windows plane). ADR-0067 (cross-plane byte-reproducible .vsix) is the enabler: once a windows witness is
  produced, both planes attest the SAME artifact sha256.
- **The shipped v1.0.0 corroboration is a KNOWN DEFECT, tracked for a re-seal.** Its committed quorum
  (`witnesses-1.0.0/` LINUX + VMWARE, both linux) and composite decision are FROZEN release artifacts and are NOT
  rewritten here (that is the operator-gated re-seal). They are honestly flagged; the re-seal will produce a real
  windows-plane + linux-plane quorum over the (now cross-plane reproducible) artifact.
- ADR-0017 is superseded on the independence-axis definition (a note points here). The engines are dependency-free
  and the gates remain offline + deterministic. Authored under the singular-requirement directive.
