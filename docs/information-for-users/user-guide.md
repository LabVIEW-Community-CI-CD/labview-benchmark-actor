# labview-benchmark-actor — User Guide

> Standards baseline: `repo-standards-review` v0.2.19. User information follows
> ISO/IEC/IEEE 26514:2022 (task-oriented, minimal, with clear entry routes).
>
> **Planning note:** this describes the *intended* user experience. It is a
> specification of the workflow, not a guide to shipped software — no
> implementation exists yet. Steps are written to become executable once the
> package graduates and is built.

## Who this is for

Operators who want to run **benchmarks** through the agentic infrastructure and
review results as coupled **metric + picture** evidence over time — on a
Codespace or a Vagrant golden VM, optionally across multiple VMs.

## 1. Install (choose one target)

**A. GitHub Codespace**
1. Open the workspace in a Codespace.
2. Install the `labview-benchmark-actor` `.vsix`.
3. On activation, resolve any prerequisite the first-run check reports
   (runtime, ports).

**B. Vagrant golden VM**
1. Provision the golden VM from the recorded base image.
2. Install the same `.vsix`.
3. Confirm the first-run activation signal.

The **same artifact** installs on both targets (LBA-REQ-002).

## 2. Run a benchmark

1. Start a benchmark run from the extension.
2. The agentic actor drives the run and records, on one run clock:
   - a **metric time-series**, and
   - a **time-indexed sequence of pictures** (frames).
3. When the run completes, open the **time-cursor viewer**.

## 3. Review with the time cursor (the core workflow)

The viewer shows the metric chart with a **vertical cursor line**:

- **Drag the cursor left↔right** to scrub through time. The selected time is
  shown numerically and stays within the run window.
- **Keyboard:** arrow keys step one sample; **Home/End** jump to the run's
  start/end.
- **Below the chart**, the **picture captured at the selected time** is shown,
  labeled with its index and timestamp. It updates in lockstep as you move the
  cursor (nearest frame at-or-before the selected time).
- If there is no frame near the selected time, the panel says so explicitly
  rather than showing a stale image.

This keeps the **metric** and the **visual evidence** synchronized at every
point in time (LBA-REQ-004/005).

## 3.1 Respond to a handoff request

When the agent needs you to perform a manual step in the reviewer VM (run a VI,
activate LabVIEW, click **Stop**), it appears as a notification with **Mark step
done** and **Skip** buttons. You can also answer from the Command Palette:

- **LabVIEW Benchmark Actor: Mark Handoff Step Done** — after completing the
  step (you may add an optional note).
- **LabVIEW Benchmark Actor: Skip Handoff Step** — to decline it.

Your answer is recorded as a machine-readable `op-done` beacon so the agent
resumes without re-asking (LBA-REQ-056).

## 4. Run across multiple VMs (optional)

1. Spawn the multi-VM topology (N Vagrant VMs), each with the extension
   activated and a unique identity (LBA-REQ-006).
2. VMs **coordinate** over a **local TCP/UDP bus** — no GitHub Discussion and no
   internet required (LBA-REQ-007). The bus carries **inter-actor communication
   only** (claims, handoffs, acks, dones); **no run data crosses it**. Run data
   (metrics + pictures) stays VM-local in each VM's mprr ring buffer.
3. Each VM runs benchmarks independently and reviews its **own** previous runs
   locally — there is **no cross-VM comparison**.
4. To compare across runs, the operator **concentrates** completed runs onto the
   host (out-of-band) and uses the **ollama comparison layer** over the
   concentrated corpus (LBA-REQ-010).
5. Tear the topology down cleanly when finished.

## 5. Programmatic access (MCP tools, optional)

The extension registers a **Model Context Protocol (MCP) server**, so an
MCP-capable client (such as an AI agent in your editor) can query the actor's
state through structured tools instead of the UI:

- **get_host_capabilities** — report the host's benchmark-relevant capacity
  (CPU, memory, platform).
- **get_benchmark_series** — read the current metric time-series that backs the
  time-cursor viewer.
- **poll_coordination_bus** — read recent inter-actor coordination messages
  (claims, handoffs, acks, dones) — **coordination only, no run data**.
- **post_coordination_note** — post a coordination note onto the bus.

The server runs **locally over stdio** and starts on demand; nothing is sent to
the internet. For the full tool contract (inputs, outputs, examples) see
[../mcp-tools.md](../mcp-tools.md).

## 6. Corroborate a release before you trust it

Before a shared component release (the extension `.vsix` or the `lbabus` CLI) is
trusted, the **Actor Corroboration Grid** checks that independent witnesses across
distinct environments agree on the release's deterministic anchors, and that the
release's provenance is attested and logged.

Two commands are available from the Command Palette:

- **LabVIEW Benchmark Actor: Run Corroboration Grid** — runs the end-to-end grid
  over the recorded witnesses and prints the release decision: whether the release
  is *machine-corroborated* (independent witnesses agree, the quorum passes, every
  attestation verifies, and the mesh re-derives the same verdict) and whether it is
  *released* (a human reviewer's sign-off also accompanies the verdict).
- **LabVIEW Benchmark Actor: Verify Release Provenance** — runs *verify-before-install*:
  it admits a release only when enough enrolled witnesses each carry an attestation
  that is included in the signed transparency log. A missing or tampered proof blocks
  the install. This is the same check the reviewer workstation runs before it installs
  the `.vsix`.

A release is corroborated only when **independent** witnesses (distinct enrolled
environments) **agree** on the OS-independent anchors, and it is **published** only
when a human reviewer has *also* signed off — the machine quorum and the human sign-off
are both required (LBA-REQ-023 / LBA-REQ-027).

**Public tamper-evidence (sigstore keyless + rekor).** Where an OIDC identity exists
(GitHub Actions), the release provenance is keyless-signed with cosign — a short-lived
certificate bound to the signing workflow, with the signature recorded in the public
sigstore transparency log (rekor). This is the external, publicly verifiable tier that
complements the repository's own signed transparency log (LBA-REQ-025 / LBA-REQ-031).

**For agents (MCP tools).** The grid is also exposed on the MCP surface, so an
MCP-capable agent can orchestrate corroboration directly: `run_quorum` /
`get_confidence` (the graded quorum), `verify_attestation` and `check_independence`
(provenance + independence), `verify_inclusion` / `verify_before_install`
(transparency-log inclusion), and `spin_up_witness` / `teardown` (witness provisioning
plans). Signing and recording stay operator/CI steps — no signing key is ever passed to
a tool (LBA-REQ-029).

## 7. Where to look next

- What the system must do: [../requirements/srs.md](../requirements/srs.md)
- How it is structured: [../architecture/overview.md](../architecture/overview.md)
- How it is validated: [../testing/test-plan.md](../testing/test-plan.md)
- Baseline, stamp, and move procedure: [../cm/cm-plan.md](../cm/cm-plan.md)
