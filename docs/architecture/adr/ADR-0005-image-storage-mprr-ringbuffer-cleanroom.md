# ADR-0005: Image/frame storage — mprr ring buffer in the VM cleanroom (no image transport over the bus)

- Status: Proposed
- Owner: WIN
- Traces to: LBA-REQ-003, LBA-REQ-005; constrains LBA-REQ-007
- Standards baseline: `repo-standards-review` v0.2.19
- External canonical reference: **mprr** (`svelderrainruiz/mprr`, `develop`) —
  ADR-0024 dual-packet-stream buffering policy; frozen TDMS-compatible `1.0`
  replay contract; VM review-capture.

## Context

The viewer must show the picture captured at a selected time (LBA-REQ-005),
across multiple VMs (LBA-REQ-006) coordinating over a TCP/UDP bus
(LBA-REQ-007). Transporting **image bytes** over that bus would bloat it,
couple transport throughput to payload size, and duplicate a capability that
already exists: **mprr** provides a governed, bounded-RAM **ring buffer** for
VM review-capture — a dual-packet stream (ADR-0024): a **short-packet** stream
(timing/index, `16 MiB` / `32768` packets) and a **long-packet** stream (large
payloads, `256 MiB` / `512` packets), over a frozen TDMS-compatible `1.0`
transport, with a governed degradation policy (preserve short-packet continuity
before long-packet completeness).

## Decision

Each VM is a **cleanroom**. Captured pictures are recorded **locally** into
mprr's **long-packet ring buffer** (payload); their **index/timestamp**
metadata goes to the **short-packet** stream. The run-result frame `ref`
(ADR-0001) is a **local pointer** into that VM's mprr review-capture store and
is resolved by the viewer **on the same VM**.

- **Image bytes never leave the VM over TCP/UDP.** The coordination bus
  (LBA-REQ-007) carries only **short-packet metadata** — frame index,
  run-relative timestamp, run/session ids — enough to correlate and compare
  across VMs, never the images. This is the answer to the ADR-0001 open
  question and to the LINUX bus-lane frame-`ref`-transport question:
  **metadata-only on the bus**.
- **Reuse, don't reinvent.** labview-benchmark-actor **consumes mprr** as a
  canonical dependency (as `vi-history-suite` is mprr's first fixture repo); it
  does not re-implement the ring buffer, the TDMS transport, or the buffering
  policy. It maps a benchmark "frame" onto an mprr long-packet payload and its
  index onto a short-packet record.
- **Cleanroom isolation.** Because images stay VM-local, a benchmarking session
  is air-gapped: the bus is a coordination/index channel, not an image channel.

## Consequences

- **+** The bus stays small and payload-agnostic — TCP/UDP carry coordination
  and index metadata only, so bus sizing is decoupled from image volume.
- **+** Reuses mprr's governed bounded-RAM ring buffer, degradation policy, and
  resilience proofs instead of a new store — one authoritative buffering model.
- **+** Cross-VM comparison uses short-packet index/timing aligned by the UDP
  time-sync (ADR-0004), without moving image bytes.
- **−** Adds an external dependency on **mprr** (frozen TDMS `1.0` + ADR-0024);
  it must be **version-pinned**, and an mprr schema move requires a successor
  ADR here before this contract can move.
- **−** Reviewing another VM's images is an out-of-band access to that VM's
  cleanroom store, **by design** — the bus will not fetch images.
- **Open:** exact mapping of a benchmark frame onto mprr's long-packet payload
  and the review-capture manifest fields — coordinate against mprr's
  fixture-profile / review-capture contract before implementation.
