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

- **Nothing from the ring buffer leaves the VM.** The entire mprr ring buffer
  (short-packet index/timing **and** long-packet payload) stays VM-local. The
  coordination bus (LBA-REQ-007) carries **inter-actor communication only** —
  the GitHub-Discussion replacement — never run data, run/frame metadata, or
  images. This answers the ADR-0001 open item and supersedes the LINUX bus-lane
  frame-transport question: **no run/frame data on the bus at all**.
- **Reuse, don't reinvent.** labview-benchmark-actor **consumes mprr** as a
  canonical dependency (as `vi-history-suite` is mprr's first fixture repo); it
  does not re-implement the ring buffer, the TDMS transport, or the buffering
  policy. It maps a benchmark "frame" onto an mprr long-packet payload and its
  index onto a short-packet record.
- **Cleanroom isolation.** Because all run data stays VM-local, a benchmarking
  session is air-gapped: the bus is an inter-actor coordination channel only,
  not a data or image channel.

## Consequences

- **+** The bus stays small and data-agnostic — TCP/UDP carry inter-actor
  coordination only, so bus sizing is fully decoupled from run/image volume.
- **+** Reuses mprr's governed bounded-RAM ring buffer, degradation policy, and
  resilience proofs instead of a new store — one authoritative buffering model.
- **+** No cross-VM run comparison: each actor reviews its **own** previous
  runs locally; completed runs are concentrated to the operator's host
  out-of-band (not the bus) for a host-side ollama comparison layer
  (ADR-0006, LBA-REQ-010).
- **−** Adds an external dependency on **mprr** (frozen TDMS `1.0` + ADR-0024);
  it must be **version-pinned**, and an mprr schema move requires a successor
  ADR here before this contract can move.
- **−** Reviewing another VM's images is an out-of-band access to that VM's
  cleanroom store, **by design** — the bus will not fetch images.
- **Open:** exact mapping of a benchmark frame onto mprr's long-packet payload
  and the review-capture manifest fields — coordinate against mprr's
  fixture-profile / review-capture contract before implementation.

## Relationship to ADR-0003 (supersedes §5)

This decision **supersedes ADR-0003 §5** (frame `ref` transport by
content-addressed **FETCH** over a bulk TCP connection). Per the cleanroom
directive, **no run or frame data crosses the bus at all** — neither image
bytes nor metadata. The bus is the **inter-actor communication channel only**
(claim/handoff/ack/done/note — the GitHub-Discussion replacement). The viewer
reads a frame from the **same VM's** local mprr store.
ADR-0003 §5 and its `FETCH`/`FETCH_REPLY` bulk-blob channel should be removed
(LINUX lane), and any `RESULT`-carries-frame-metadata should drop the run-data
payload. The rest of ADR-0003 — length-prefixed-JSON framing, the `bus-msg@1`
envelope, leader-ordered late-join, and check-before-publish — is unaffected
and remains the coordination contract.
