# ADR-0023: Personal golden-VM onboarding for the LabVIEW community

- Status: Accepted
- Date: 2026-08-02
- Deciders: maintainer interview (2026-08) + verified on-host LabVIEW-2026-CE-for-Linux facts
- Relates to: LBA-REQ-033, ADR-0011 (provider-delegation cleanroom uplift), ADR-0018 (reviewer station), ADR-0019 (mesh integration)

## Context

The single most valuable thing the project does **not** yet do (maintainer's words) is: *fully automated, from-scratch
provisioning of an Ubuntu VM with LabVIEW Community Edition + VIPM, such that once the user activates them the tool
confirms activation and mints their **personal golden VM**.* The proven golden box today is **Windows-only**
(`actor/win11-labview2026`), which excludes the Linux community and blocks the OS axis of cross-plane comparison.

On-host inspection of the reference machine (Ubuntu running NI's Noble build) establishes the concrete spine: LabVIEW
2026 **Community Edition for Linux** installs from the **NI apt repo**
(`download.ni.com/ni-linux-desktop/LabVIEW/2026/Q1/f1/community/deb/ni-labview-2026/noble`, whose GPG key is already
committed at `cleanroom/ubuntu-labview/ni-labview-2026-noble-community.asc`), ships `LabVIEWCLI` at
`/usr/local/bin/LabVIEWCLI` with headless operations (`RunVI`, `RunVIAnalyzer`, `MassCompile`, `RunUnitTests`), and
installs VIPM at `/usr/local/bin/vipm`. Activation itself is **interactive** (NI-account login) and cannot be fully
headless.

## Decision

- **`lba init` provisions, from scratch, an Ubuntu 24.04 (Noble) golden VM.** It detects the host (Windows / Linux
  desktop) and hypervisor (VirtualBox+Vagrant, or Hyper-V/WSL2 on Windows), adds the NI apt repo with the committed
  GPG key, and installs `ni-labview-2026-community` + `vipm` non-interactively — building on the existing
  `cleanroom/ubuntu-labview/` scaffolding.
- **Activation is a hybrid step.** The human signs in to their NI account and activates LabVIEW CE + VIPM; automation
  handles everything before and after.
- **Activation is CONFIRMED functionally.** The tool runs a committed **headless probe VI** via
  `LabVIEWCLI -OperationName RunVI … -Headless` (under `Xvfb` when needed); success emits a signed
  `activation-receipt@1`. A functional probe is chosen over parsing NI license files (brittle, version-dependent).
- **The personal golden VM is minted LOCALLY** — a re-importable box that stays on the member's machine — and is
  **registered as an actor** in `mesh-actors.csv`. No shared box registry (privacy + bandwidth).
- **`LabVIEWCLI -Headless` is the actor runtime.** The same mechanism that confirms activation runs the benchmark
  suite (launch capture, VI Analyzer, mass-compile, unit tests), so the runtime is uniform across planes.
- **Trust = VM/sandbox isolation.** Distributed runs execute inside the golden VM; provenance-attestation
  (verify-before-consume) remains an **opt-in** stronger tier, not a gate on participation.

This is requirement **LBA-REQ-033**.

The activation-confirmation step is delivered first as requirement **LBA-REQ-038**:
a headless known-answer probe (`LabVIEWCLI RunVI` on the shipped `AddTwoNumbers.vi`)
whose deterministic `activation-receipt@1` gates the build, proven live on the
reference host's activated LabVIEW 2026.

Mesh-actor enrollment is delivered as requirement **LBA-REQ-039**: the golden VM is
registered in `mesh-actors.csv` only after that receipt confirms activation, so
confirmation and enrollment form one fail-closed chain.

The provisioner's install layer is delivered as requirement **LBA-REQ-044**: the
from-scratch Ubuntu VM installs both LabVIEW 2026 Community (NI apt repo) and VIPM
(the JKI Debian package), proven live on the scratch VM.

VIPM's FUNCTIONAL install is delivered as requirement **LBA-REQ-046**: on the golden
VM, VIPM (Community Edition) installs the operator-designated self-test package g-cli
(`wiresmith_technology_lib_g_cli`) plus its dependency closure into LabVIEW's `vi.lib`,
proven live on `lba-golden` -- so the golden VM is "Ubuntu + LabVIEW + VIPM" in the
functional sense, not merely installed.

Live golden-VM visibility is delivered as requirement **LBA-REQ-047**: a monitor streams
the VM's CPU busy% (plus LabVIEW/vipm/Xvfb) over the bridge, and a deterministic idle-time
analysis of a captured timeline surfaces the "dead time" (idle spans, idle %, longest idle
run) so no long silent wait is invisible to human or agent.

A golden-VM benchmark is delivered as requirement **LBA-REQ-048**: LabVIEWCLI mass-compiles
the pinned public `ni/labview-icon-editor` source, recording a machine-independent result
identity (VI count + bad count + success) that is cross-plane comparable plus the compile
time as the performance metric -- so the golden VM is not just provisioned but measurably
exercising LabVIEW.

The one-command provision is hardened as requirement **LBA-REQ-049**: `provision-guest.sh`
installs Xvfb and writes the VI Server (:3363) configuration for both LabVIEW executable
basenames (`labview.conf` + `labviewcommunity.conf`) with quoted access lists, and a
fail-closed gate -- bound to the actual script text -- proves it stays
headless-benchmark-ready, so the three fixes discovered by hand during bring-up cannot
silently regress.

## Consequences

- The **Linux plane** becomes a first-class benchmark actor, unlocking the OS axis of cross-plane comparison
  (Windows-LabVIEW vs Linux-LabVIEW) while the Windows golden box is retained for the other side.
- Community members reach a reproducible LabVIEW benchmark environment with **one command + one activation**.
- Local-only minting keeps member data private and avoids distributing large boxes; the mesh coordinates *runs*,
  not boxes.
- `LabVIEWCLI` becomes the portable, headless runtime the whole benchmark suite and the mesh depend on.

## Alternatives considered

- **Stay Windows-only.** Rejected: excludes the Linux community and forecloses the OS comparison axis.
- **Parse NI license files to confirm activation.** Rejected: brittle and version-dependent; a functional probe VI
  proves the environment actually runs licensed code.
- **Publish minted boxes to a shared registry.** Rejected: privacy and bandwidth cost; local mint + re-import is
  sufficient and keeps ownership with the member.
- **Install via `nipkg` (the Windows NI Package Manager).** Rejected: NI's Linux desktop distribution is **apt**-based;
  `nipkg` is not the Linux path.
