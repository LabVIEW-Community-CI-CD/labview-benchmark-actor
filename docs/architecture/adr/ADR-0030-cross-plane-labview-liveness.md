# ADR-0030: Cross-plane LabVIEW liveness — prove ≥ 2 independent activated LabVIEW planes

- Status: Accepted
- Date: 2026-08-02
- Deciders: operator directive (2026-08, "a fresh Linux VM that doubles as Phase 1" + "activation probe on each plane") + agent
- Relates to: LBA-REQ-042, ADR-0029 (capability-aware routing), ADR-0023 (personal golden-VM onboarding), LBA-REQ-038 (activation confirmation), docs/roadmap.md (North Star cross-plane mesh)

## Context

Capability-aware routing (ADR-0029) can send LabVIEW work only to LabVIEW-capable
instances, but with a single LabVIEW plane (the host) there is nothing to compare
*across*. The North Star is real cross-plane comparison, which needs **more than
one** independent, activated, operational LabVIEW plane. The operator directed a
second LabVIEW plane via a Linux VM (doubling as the Phase 1 golden VM, ADR-0023)
and a lightweight **activation probe on each plane** as the first cross-plane
workload.

The Phase 1 golden VM already existed and was running:
`lba-ubuntu2404-labview2026-scratch` (Ubuntu 24.04, LabVIEW 2026 Community,
operator-activated, ssh-forwarded on 127.0.0.1:2222).

## Decision

- **Discover every LabVIEW plane** at run time: the host (if LabVIEWCLI is present)
  plus running VirtualBox VMs that answer `ls LabVIEWCLI` over their ssh forward.
- **Run the known-answer activation probe on each plane concurrently**
  (`LabVIEWCLI RunVI` on the shipped `AddTwoNumbers.vi`, `7 + 5 = 12`), reusing the
  LBA-REQ-038 verdict rule.
- **Aggregate a cross-plane liveness receipt** and **gate it fail-closed**
  (`cross-plane-labview-liveness`): the receipt must show ≥ 2 **distinct** planes,
  each returning its known answer and activated, all live.
- **Ripgrep-only** on every plane (the VM had ripgrep installed to match).

This is requirement **LBA-REQ-042**.

## Consequences

- The fleet now has **two independent, activated LabVIEW planes** proven live —
  this host and the Ubuntu golden VM — the substrate real cross-plane benchmark
  comparison needs.
- Phase 1 (ADR-0023) advances concretely: the golden VM is not just provisioned
  but **proven operational as a LabVIEW plane** through the same activation
  contract used everywhere else.
- The next step is a **cross-plane benchmark** (e.g., VI Analyzer resultHash
  equivalence) distributed across these planes via the capability router — turning
  liveness into comparison.
