# labview-benchmark-actor — Roadmap

> **Status:** living document · **Horizon:** multi-year vision + near-term slice · **Owner:** maintainers + the agent
> **Traces to:** the North Star below · formalized in [ADR-0023](architecture/adr/ADR-0023-personal-golden-vm-onboarding.md) and `LBA-REQ-033`.

## 1. North Star

Give **any LabVIEW community member** a one-command path to their own **reproducible, personal "golden" benchmark VM** — Ubuntu 24.04 (Noble) with **LabVIEW 2026 Community Edition** + **VIPM** — and let that VM join a horizontally-scaled, **sandbox-isolated benchmark actor mesh** for **objective, reproducible cross-plane comparison**.

Three things this is, at once (from the maintainer's own words):

1. a **community open-source tool** for the LabVIEW CI/CD ecosystem,
2. a **publishable VS Code Marketplace product**, and
3. a **showcase of agent-driven CI/CD engineering**.

**Primary audiences:** LabVIEW developers, and the autonomous agents that operate the mesh on their behalf.

**What a result is _for_:** objectively comparing performance across **planes** — operating system (Windows-LabVIEW vs Linux-LabVIEW), **physical hardware** (one member's machine vs another's), and **LabVIEW version/configuration** — as a benchmark anyone can re-run and compare, **with no central data hoarding**.

## 2. Principles (the non-negotiables)

- **Reproducibility over telemetry.** The mesh coordinates *runs*, not a central results database. Evidence is a portable receipt, owned by whoever produced it.
- **Real data, no fakes.** Every capability is proven on a real capture with a committed receipt and a fail-closed gate (the discipline that produced the current foundation).
- **Exactly 12 FPS.** The frame-locked capture cadence is the shared clock across every plane and sampler.
- **Sandbox = the golden VM.** Distributed runs execute inside the member's isolated VM; provenance/attestation is an *opt-in* stronger tier, not a gate on participation.
- **Hybrid labor.** Agents drive the automation; a human does the irreducibly-human steps — the NI-account **activation**, hardware, and physical provisioning.
- **Governed by construction.** Requirements ⇄ tests ⇄ ADRs ⇄ views stay in a fail-closed correspondence graph (ISO/IEC/IEEE 29148 / 42010 / 29119). Rigor is a feature, not overhead.
- **Free + non-commercial.** LabVIEW **Community Edition** is the substrate; the extension ships **free** on the Marketplace.

## 3. Where we are (grounded inventory)

The foundation is deep and green (`develop` passing: `verify-local-gates` 129/129, TR-1 93/93, 32 requirements, coverage floors held). Highlights that the roadmap builds directly on:

- **Exact-12-FPS performance-counter pipeline** — cross-platform samplers (Linux `/proc`, Windows PDH), correlation engine, live capture, webview scrubber. See `experiments/resource-usage-correlation/` and `experiments/mprr-capture-ring/`.
- **Mesh-stress-signature program — discrimination proven four ways on real data:** host sequential ladder, host simultaneous 5-actor, single real Win11 VM, and two simultaneous real Win11 VMs (linked clones). Two shipped analysis views (calibration curve + live board). See `experiments/mesh-stress-signature/`.
- **Windows golden box** — `actor/win11-labview2026`, proven end-to-end on NVMe, driven headlessly via `VBoxManage guestcontrol`.
- **Cross-plane comparison** substrate and **VI Analyzer** as a cross-plane benchmark.
- **Coordination bus (`lbabus`)**, **MCP server** (agent tool surface), and a **verify-before-consume provenance/attestation** stack (cosign, transparency log).
- **Governance:** SRS (29148), architecture views + ADRs (42010), RTM, and the `verify-local-gates` fail-closed suite.
- **Ubuntu-LabVIEW scaffolding already present** — `cleanroom/ubuntu-labview/` ships the NI apt GPG key (`ni-labview-2026-noble-community.asc`), `provision-guest.sh`, `build-virtualbox.sh` / `build-vmware.ps1`, a `mesh-actors.csv` registry, and a codespace bootstrap.

### The verified technical spine (measured on the reference host)

The near-term slice is grounded in the **actual activated install** on the maintainer's Ubuntu 26.04 host (running NI's Noble/24.04 build):

| Concern | Ground truth (verified on-host) |
|---|---|
| Install source | NI apt repo `download.ni.com/ni-linux-desktop/LabVIEW/2026/Q1/f1/community/deb/ni-labview-2026/noble` (+ committed GPG key) |
| Packages | `ni-labview-2026-community`, `labview-2026-community-exe`, `ni-labview-command-line-interface`, `vipm` (26.3) |
| LabVIEW | `/usr/local/natinst/LabVIEW-2026-64/labviewcommunity` |
| **Automation + benchmark runtime** | **`LabVIEWCLI -Headless`** at `/usr/local/bin/LabVIEWCLI` — operations `RunVI`, `RunVIAnalyzer`, `MassCompile`, `RunUnitTests`, `CreateComparisonReport`, `CloseLabVIEW` |
| **Activation confirmation** | run a **headless probe VI** via `LabVIEWCLI -OperationName RunVI … -Headless` (functional proof; more robust than parsing license files) |
| VIPM | `/usr/local/bin/vipm` (JKI) |
| Base OS | **Ubuntu 24.04 Noble** (NI's supported target) |

## 4. The near-term slice — **First Win**: `lba init` → a personal golden VM

**Definition of the first win (maintainer-chosen):** *one command mints a personal golden VM, and the tool confirms LabVIEW CE + VIPM activation.*

The flow (hybrid — agent/scripts drive, human activates):

1. **`lba init`** (VS Code command *and* CLI) detects host OS + the best hypervisor (VirtualBox+Vagrant on Windows/Linux; Hyper-V/WSL2 on Windows).
2. Provisions a clean **Ubuntu 24.04 Noble** VM.
3. Adds the **NI apt repo** (committed GPG key) and installs `ni-labview-2026-community` + `vipm` non-interactively.
4. **Hands off to the human** for the one irreducible step: sign in to the NI account and **activate** LabVIEW CE + VIPM.
5. **Confirms activation** by running a committed **headless probe VI** through `LabVIEWCLI` — a functional check that returns a signed *activation receipt*.
6. **Mints the personal golden VM** — snapshots the activated, provisioned state into a re-importable box that stays **local to the member**, and **registers it as an actor** in `mesh-actors.csv`.

**Explicitly not in the first win:** publishing boxes to a shared registry (boxes stay local); central results aggregation.

## 5. The multi-year arc (phased)

Each phase lands as gated, receipt-backed increments; every new capability gets a requirement, a self-test, a gate, and (where architectural) an ADR.

- **Phase 0 — Foundation** *(done)*: the pipeline, mesh-stress program, Windows golden box, cross-plane substrate, MCP, provenance, governance.
- **Phase 1 — Personal Golden VM (Linux)** *(**done** — the First Win, `LBA-REQ-033` **Proven**, ADR-0023)*: one-command `lba init` provision → human activation → `LabVIEWCLI` activation receipt → local golden VM minted + registered as an actor, composed from Proven slices and gated by `first-win-onboarding` (demonstrated live on `lba-golden`). Ubuntu 24.04 Noble; VirtualBox+Vagrant and Hyper-V/WSL2.
- **Phase 2 — The real benchmark suite**: headless LabVIEW benchmarks via `LabVIEWCLI` — IDE/VI **launch-to-ready** (the exact-12-FPS capture, now on Linux), **VI Analyzer**, **mass-compile**, **unit-test** timing — each emitting a portable, plane-tagged receipt. Establish **Linux ⇄ Windows parity** on the shared `benchmarkId` / `seriesHash`.
- **Phase 3 — The actor mesh**: register golden VMs as actors; **on-demand distributed runs** coordinated **GitHub-natively** (`repository_dispatch` / Actions as the queue — zero central infra, auditable) with results returned to the requester (no central DB). Sandbox-isolation trust model; **opt-in** provenance-attested "verified" tier reusing the existing cosign/transparency stack.
- **Phase 4 — Cross-plane comparison at scale**: compare across the three plane axes (OS × hardware × LabVIEW version); reproducible comparison receipts + the analysis views (calibration board, cross-plane agreement). The mesh-stress-signature calibration lets a run **discount** a result captured on a stressed actor.
- **Phase 5 — Marketplace v1.0 + community**: publish the **free** extension; polished onboarding UX; docs + a "join the mesh" quickstart; the agent-driven-CI/CD showcase (agents operate provisioning, gating, and mesh runs end-to-end, with the human doing only activation/hardware).
- **Phase 6+ — Horizon**: a living, community-run cross-plane benchmark; agent-operated onboarding + self-repair; broader hypervisors/hosts as demand appears (macOS/Apple-Silicon remains out until there's a real path).

## 6. Trust & coordination model

- **Trust = VM/sandbox isolation.** A distributed benchmark runs inside the requester-or-volunteer golden VM; the host is never asked to trust foreign code directly.
- **Opt-in "verified" tier.** A requester may publish a **signed** benchmark bundle; actors that choose the stricter tier **verify-before-run** using the existing attestation stack. Isolation is the floor; attestation is the ceiling.
- **Coordination = GitHub-native (recommended).** On-demand runs are dispatched through the repo (issues / `repository_dispatch` / Actions) — no server to run, fully auditable, and a natural fit for "coordinate runs, don't hoard data." `lbabus` remains the in-host/on-LAN bus between an operator and their own actors.

## 7. Risks & how we de-risk

| Risk | Mitigation |
|---|---|
| **Activation is interactive** (NI login) — can't be fully headless | Design for **hybrid**: automate everything up to and after activation; make the human step a single, well-signposted moment; confirm with a functional probe VI. |
| **CE is non-commercial + login-gated** → no hosted CI with LabVIEW | Publish the extension free; keep LabVIEW execution **local/opt-in**; self-hosted runners only for LabVIEW CI. |
| **VM fragility** (clone autologin, headless display, guest sessions) | Encode the hard-won gotchas as scripts + preflight checks; `Xvfb` for headless `LabVIEWCLI`; a reset-once step for fresh clones. |
| **Hardware/disk limits** (large VMs on constrained NVMe) | **Linked clones** (shared base disk) for multi-actor on one host; NVMe-only for durable artifacts. |
| **NI trademark / branding** for a community tool | Neutral naming, clear "community, non-commercial" framing, no NI endorsement implied. |
| **Cross-host reproducibility drift** | Pin the Ubuntu base (24.04 Noble) + the NI repo snapshot; capture full plane metadata on every receipt. |

## 8. Success metrics

- **First win:** a fresh machine → activated personal golden VM in **one command + one human activation**, with an activation receipt.
- **Parity:** identical `seriesHash` for the same benchmark across Linux and Windows planes.
- **Mesh:** a requester dispatches a run and receives ≥ 2 independent, plane-tagged receipts from volunteer actors.
- **Adoption:** the extension is installable from the Marketplace and a new member reaches "actor registered" from the quickstart without hand-holding.

## 9. Immediate next actions

1. **Phase 1 kickoff (`LBA-REQ-033`, ADR-0023):** turn `cleanroom/ubuntu-labview/` into a single `lba init` provisioner for Ubuntu 24.04 Noble; wire the **NI apt install** + the **`LabVIEWCLI` headless activation-probe** into a committed, gated flow with an activation-receipt schema.
2. **Probe VI + receipt:** author the headless probe VI and the `activation-receipt@1` schema; a deterministic self-test replays a committed receipt (no VM in CI).
3. **Linux launch benchmark:** port the exact-12-FPS launch capture to the Linux golden VM as the first real cross-plane benchmark payload.

---
*This roadmap is intentionally revisable. It encodes decisions captured from the maintainer interview (2026-08) and the verified on-host LabVIEW-2026-CE-for-Linux facts; supersede freely as reality teaches us more.*
