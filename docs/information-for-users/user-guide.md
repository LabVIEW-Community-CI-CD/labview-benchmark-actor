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

## 4. Run across multiple VMs (optional)

1. Spawn the multi-VM topology (N Vagrant VMs), each with the extension
   activated and a unique identity (LBA-REQ-006).
2. VMs coordinate over a **local TCP/UDP bus** — no GitHub Discussion and no
   internet required (LBA-REQ-007):
   - reliable coordination (claims, handoffs, results) over **TCP**;
   - presence and time-sync over **UDP**.
3. Each VM runs benchmarks and publishes results into the shared session; a VM
   that joins late reconstructs the current session state.
4. Tear the topology down cleanly when finished.

## 5. Where to look next

- What the system must do: [../requirements/srs.md](../requirements/srs.md)
- How it is structured: [../architecture/overview.md](../architecture/overview.md)
- How it is validated: [../testing/test-plan.md](../testing/test-plan.md)
- Baseline, stamp, and move procedure: [../cm/cm-plan.md](../cm/cm-plan.md)
