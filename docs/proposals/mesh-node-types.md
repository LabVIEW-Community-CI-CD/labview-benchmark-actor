# Spec: Mesh Node Types & Strict Serialization (`bus-msg@1`)

Status: DRAFT (for operator + WIN review) · Author: LINUX plane · Date: 2026-07-31 · Task: ephemeral-mesh
Companion to: [ephemeral-mesh.md](ephemeral-mesh.md). Extends LBA-REQ-006 / LBA-REQ-007; builds on ADR-0003
(bus wire), ADR-0004 (UDP presence).

> **Open decision (needs operator sign-off):** §4 (v2, self-reviewed) defines *strict serialization* as a
> sink's **serialized ingest log** (a dense `ingestSeq`), keyed by `(sessionId, senderId, seq)` and closed by
> a terminal `DONE`. Default level = **serialized**; **strict-reproducible** is opt-in (§4.2). Confirm the
> default level. Nothing is implemented yet — this is the design gate before code.

## 1. Purpose

Give every mesh actor a **boot-time node type** — `source`, `sink`, or `both` — and define the **strict
serialization** guarantee for the source→sink coordination stream. The node type is **orthogonal** to the
existing `mesh-actors.csv` lifecycle `role` (`golden | mesh`): `role` says *how the VM came to exist*,
`node_type` says *what it does on the bus*.

This promotes the pattern the repo already proves ad hoc — `experiments/multi-vm-topology/` hardcodes a
**collector** (a sink) and a **sender** (a source); `tools/collab-cli/ci/mesh-actor.sh` is the symmetric
**both** — into a first-class, declared property a disposable clone can boot into.

## 2. The three node types

| Type | Bus behavior | Binds listeners? | Emits frames? | Existing analog |
| --- | --- | --- | --- | --- |
| `source` | **emit-only** producer: sends `bus-msg@1` frames (CLAIM/PROGRESS/HANDOFF/DONE) + UDP presence | no (TCP) | yes | multi-vm **sender** |
| `sink` | **collect-only** consumer: binds the reliable TCP + presence UDP listeners, ingests + serializes what sources send; the concentration point | yes | no (coordination) | multi-vm **collector** |
| `both` | **full peer**: simultaneously a source and a sink | yes | yes | `mesh-actor.sh` today |

- A **source** never has to collect; a **sink** never has to produce; a **both** does the sink's ordered
  ingest *and* runs its own source stream. The two halves of a `both` node are independent (§5).
- **Comms-only stays law** (LBA-REQ-007, ADR-0005): these frames are *coordination*, never run-data. Run
  data remains VM-local (LBA-REQ-009); cross-plane comparison is still by host concentration
  (LBA-REQ-010/014). A "sink" concentrates **coordination**, not benchmark payloads.

## 3. Boot declaration (how a node becomes a type)

1. **Identity record** — `/etc/lba-mesh-actor` gains `NODE_TYPE=source|sink|both` (default **`both`** =
   back-compat with today's symmetric mesh). `lba-mesh.service` / `mesh-actor.sh` read it and start only the
   half/halves the type calls for.
2. **Topology spec** — `mesh-actors.csv` gains a `node_type` column next to `role`, so a mesh is declared as
   *N sources + M sinks + K peers*. The Windows analog (`mesh-actor.ps1`) honors the same field (parity).
3. **Ephemeral clone** — the orchestrator injects `NODE_TYPE` at boot (same seam that already injects the
   identity + IP), so a throwaway clone **boots directly into its type** — no post-hoc reconfiguration, no
   reboot. This is the "cattle" property applied to roles.

## 4. Strict serialization — the guarantee (PROPOSED v2, self-reviewed)

The wire is *already* strictly framed: ADR-0003 §1 is a 4-byte big-endian length prefix + exactly that many
bytes of UTF-8 JSON, **one envelope per frame**, fail-closed on a bad length (`BusWire`, `Net.cs`). The
envelope already carries `sessionId`, a monotonic **`seq`**, and a `ts.run` clock. So "strict serialization"
is a guarantee *above the wire*: **a sink merges the frames it receives from one or more sources into a single
ordered log, preserving each source stream's internal order.** That log — not raw arrival order — is the
canonical sequence.

### 4.1 The model — a sink's serialized ingest log

1. **Stream key = `(sessionId, senderId)`.** Each source stamps a per-stream monotonic **`seq`** starting at 1,
   **contiguous**. A restart / reconnect / ephemeral re-clone opens a **new `sessionId`** (a fresh seq space),
   so a re-clone is never mistaken for a regression. (`sessionId` + `seq` already exist in `bus-msg@1`.)
2. **Single serialized delivery stage.** However many TCP connections a sink accepts, every received frame is
   enqueued into **one** ordered queue drained by **one** consumer, which assigns each frame a sink-local,
   dense, monotonic **`ingestSeq` (1..M)**. That log *is* the serialization output.
3. **Per-stream order is strict + reproducible.** Within a `(sessionId, senderId)` stream, frames appear in the
   log in strictly ascending `seq`. (Over a single TCP connection TCP already delivers them in order; the
   `seq` contract *catches* reconnect / duplicate / multi-connection anomalies and makes the order
   **attestable** offline.)
4. **Cross-source interleave is a valid linearization — honestly NOT run-reproducible.** When several sources
   feed one sink, their streams interleave by **authoritative arrival at the sink** (never the sender wall
   clock — the clock-skew rule, `ci/cases/linux-clock-skew-surfaced.json`). The interleave is a function of
   *what arrived when*; a re-run may interleave differently. The default mode does **not** claim a reproducible
   cross-source order (see §4.2).
5. **Explicit end-of-stream.** A source ends each stream with a terminal **`DONE`** frame carrying its final
   `seq` (= the count). A sink asserts it saw exactly `1..N` **and** the `DONE(N)` — so a *truncated* stream
   (`1..3` when `5` were meant) fails instead of passing silently.
6. **Fail closed.** A `seq` gap, duplicate, regression, a missing terminal `DONE`, or an **ingest-queue
   overflow** (the queue is **bounded**; TCP backpressures a slow sink) → `inOrder:false` → the receipt fails.
7. **Idempotent replay.** A re-delivered frame (same `sessionId` + `senderId` + `seq`) is de-duplicated — it
   does not consume a new `ingestSeq`.
8. **Presence is out of band.** UDP presence beacons (ADR-0004, advisory liveness) are **not** in the
   serialized log — they answer "who is alive", not "in what order did work happen".

**Why this shape:** it is *local* (each sink is self-contained — no global coordinator or contention),
*honest* (per-stream order is reproducible; the cross-source interleave is not over-claimed), and it reuses
the primitives already in the bus (`sessionId`, `seq`, `ts.run`, authoritative-time) — matching the project's
deterministic-record ethos (mprr monotonic ordering) without inventing a distributed sequencer.

### 4.2 Two levels — and why "global order" is not a separate mechanism

- **Serialized (default).** Every sink produces its own ingest log (§4.1): per-stream order is strict +
  reproducible; the cross-source interleave is a valid linearization (not run-reproducible).
- **Strictly-reproducible (opt-in).** For a reproducible *cross-source* order, admit **one active source at a
  time** via a token (single-writer window). The interleave then equals the token order — reproducible — at
  the cost of source concurrency. Enable it only where a byte-identical global order is required.
- **Global total order = a single-sink topology.** No separate "sequencer" is needed: declare **one** sink and
  *its* ingest log **is** the mesh-wide order (combine with the opt-in mode for a reproducible global order).
  This collapses the old "global order" and "single-writer" alternatives into *topology + a mode*.
- **Rejected:** *wire-framing only* — too weak (no cross-frame / cross-stream order, no offline attestation).

### 4.3 Offline attestation (the gate)

The sink records enough that a **dependency-free validator recomputes** the property with no live mesh: given
the frames `{ sessionId, senderId, seq, ingestSeq }` + the terminal `DONE(N)` per stream, assert (a) each
`(sessionId, senderId)` substream is contiguous `1..N`, (b) its frames appear in **increasing `ingestSeq`**,
(c) `ingestSeq` is **dense `1..M`** with no duplicate, and (d) a terminal `DONE(N)` closed each stream. Any
miss → fail. Strict serialization is thus a **fails-closed, re-runnable gate**, like every other receipt.

## 5. Type × serialization interplay

- **source** — emits a contiguous `seq` per `(sessionId)` stream, ended by a terminal `DONE(N)`; may retry a
  frame (idempotent by `sessionId` + `seq`).
- **sink** — the serialized ingest of §4; **terminal** (a leaf — it does not relay/forward, so there is no
  seq-translation); emits the `orderedReceipt` (§6).
- **both** — sinks inbound streams under §4 **and** runs its own source stream; the `seq` space it *emits* is
  independent of the streams it *sinks*. A `both↔both` pair (today's symmetric mesh) is just two nodes each
  simultaneously sourcing and (strictly) sinking.
- **Trust boundary.** `senderId` / `sessionId` are self-declared and trusted **within the private-intnet
  sandbox** of known actors (ADR-0004/0005 private binding). Strict serialization is an integrity + ordering
  contract, **not** a security boundary against a hostile in-sandbox node.

## 6. Receipt extension (`ephemeral-mesh@1`)

- `meshMode` gains `"typed"`; each `nodes[]` entry gains `nodeType: source|sink|both`; the run records
  `serializationMode: "serialized" | "strict-reproducible"`.
- A **sink** node records an `orderedReceipt`:
  ```
  orderedReceipt: {
    ingestSeqDense: true, totalFrames: M,
    perStream: [ { sessionId, senderId, firstSeq, lastSeq, count,
                   contiguous: true, inIngestOrder: true, terminalDone: true } ],
    orderKey: "(sessionId,senderId,seq) within a stream; cross-source by sink ingestSeq (arrival)",
    strictSerialization: true
  }
  ```
- `asserts` gain `strictSerialization: true` and `nodeTypesHonored: true`. The offline validator
  (`ephemeralMesh.mjs`) grows a `typed` branch performing the §4.3 recomputation and **fails closed**.

## 7. Fail-closed rules

- Unknown `NODE_TYPE` → node refuses to start.
- A sink observing a `seq` gap / duplicate / regression, a **missing terminal `DONE(N)`** (truncation), or a
  **bounded ingest-queue overflow** → `inOrder:false` → receipt fails.
- Non-dense `ingestSeq` (a hole or duplicate in the sink's own log) → fail.
- A declared `source` that binds a listener, or a `sink` that emits coordination frames → contract violation
  → fail (types are enforced, not advisory).

## 8. Implementation seam (for the *next* iteration, after sign-off)

- **P2a** — `NODE_TYPE` in `/etc/lba-mesh-actor` + `mesh-actor.sh` / `mesh-actor.ps1` branch on it (start
  listeners for `sink|both`, the send/beacon loop for `source|both`).
- **P2b** — the sink's serialized ingest: a single delivery stage assigns a dense `ingestSeq`, keys streams by
  `(sessionId, senderId)`, checks contiguity + the terminal `DONE`, and emits the `orderedReceipt`. (First as
  sink-side post-processing of `lbabus net listen` output; a native `lbabus net listen --ordered` that assigns
  `ingestSeq` in-process can follow. The opt-in strict-reproducible token mode is a later add.)
- **P2c** — the ephemeral orchestrator boots a **source → sink** pair and seals the in-order receipt;
  `both↔both` remains the symmetric case (the current 2-node scaffold).

## 9. Cross-plane (WIN)

Same `NODE_TYPE` field, same serialization contract on the Windows plane (`mesh-actor.ps1`), same receipt —
so a `source` on one plane and a `sink` on the other is a valid, gate-able cross-plane mesh (feeds P4).
