# ADR-0006: Run concentration to the operator host + ollama comparison layer (no cross-VM comparison)

- Status: Proposed
- Owner: WIN
- Traces to: LBA-REQ-010; relates to LBA-REQ-004/005 (viewer over own runs),
  LBA-REQ-007 (bus is comms-only), ADR-0005 (VM-local storage). Extended by
  ADR-0008 (interactive host-Ollama drive + mirrored build-coordination).
- Standards baseline: `repo-standards-review` v0.2.19

## Context

Actors run benchmarks in isolated VM cleanrooms; the whole run result (metrics +
frames) stays VM-local in mprr's ring buffer (ADR-0005), and the coordination
bus carries only inter-actor communication (LBA-REQ-007). Runs still need
analysis and comparison — but per the operator directive:

- **Agents do not compare runs across VMs.** Each actor reviews only its **own**
  previous runs.
- **The operator concentrates runs onto their host machine** to improve an
  **ollama** layer that compares previous runs.

## Decision

- **No cross-VM comparison.** An actor's time-cursor viewer (ADR-0002) operates
  over that actor's **own** local run history (its mprr store). No VM reads
  another VM's runs, and no run data flows over the bus.
- **Out-of-band concentration.** Completed runs are collected from each VM
  cleanroom to the **operator's host** by an explicit concentration step
  (e.g. exporting / mounting each VM's mprr review-capture store) — **never**
  over the coordination bus.
- **Host-side ollama comparison layer.** On the concentrated host, an
  ollama-based layer compares previous runs (metrics and frames) to improve the
  comparison/analysis. This continues the existing ollama direction; it runs on
  the operator's machine over the concentrated corpus, not inside any actor VM.
- **The bus stays comms-only.** LBA-REQ-007's TCP/UDP bus remains purely
  inter-actor coordination (claim/handoff/ack/done/note); it is never a run-data
  or concentration channel.

## Consequences

- **+** Clean separation of concerns: **coordination** travels the bus;
  **run data** stays VM-local and is concentrated out-of-band. Neither leaks
  into the other.
- **+** The ollama layer improves against a single concentrated corpus on one
  machine, with no VM needing another VM's data — cleanroom integrity holds.
- **+** Time-sync (ADR-0004) is only a coordination concern (ordering/presence),
  **not** a run-comparison prerequisite, since runs are never compared across
  VMs on the wire.
- **−** Concentration is an explicit operator step (out-of-band transport), not
  automatic over the bus — a deliberate trade for cleanroom isolation.
- **Open:** the concentration mechanism (shared storage vs export/import of the
  mprr review-capture store) and the ollama comparison layer's I/O contract
  (inputs, outputs, how "improvement" is measured) — follow-up ADRs.
