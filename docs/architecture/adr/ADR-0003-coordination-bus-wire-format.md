# ADR-0003: Coordination bus wire format — length-prefixed JSON over TCP

- Status: Proposed
- Owner: LINUX
- Traces to: LBA-REQ-007 (TCP/UDP coordination bus); supports LBA-REQ-006 (multi-VM); constrained by ADR-0005 / LBA-REQ-009 (image bytes never cross the bus — the bus is metadata-only)
- Standards baseline: `repo-standards-review` v0.2.19

## Context

LBA-REQ-007 replaces the GitHub-Discussion collab bus with a local TCP+UDP bus
so benchmarking runs offline. The reliable, ordered plane (claims, handoffs,
acks, dones, results) is **TCP** and is specified here; presence and time-sync
are **UDP** and are specified in ADR-0004. The bus must mirror the proven collab
semantics (claim → ack → handoff → done, check-before-publish, one owner per
hotspot) while changing only the transport (AD-7), and it must let a
late-joining VM reconstruct current session state (LBA-REQ-007.2).

ADR-0001 defines the run-result with a frame `ref`. A human **cleanroom**
directive — landed as ADR-0005 / LBA-REQ-009 — resolves how that `ref` relates
to the bus: **image bytes are never transported** (neither inline nor fetched).
Each VM stores its pictures locally in the **mprr** ring buffer and the bus
carries frame **metadata only**. §5 below is written to that directive; it
revises an earlier content-addressed-FETCH design that ADR-0005 supersedes.

## Decision

**1. Framing — length-prefixed JSON over TCP.** Each message is a 4-byte
big-endian unsigned length prefix followed by exactly that many bytes of UTF-8
JSON (one envelope per frame). A per-connection maximum frame size (default
**1 MiB** — the bus is a single coordination channel carrying metadata only, per
§5) fails closed on a corrupt or hostile length.

- Rationale: a length prefix is binary-safe and streaming-friendly — the reader
  awaits an exact byte count, with no delimiter scanning and no escaping —
  unlike newline-delimited JSON, which breaks on any embedded newline and needs
  escaping. JSON (rather than protobuf/msgpack) preserves the human-auditable
  "readable message **and** machine-parseable" property of the current collab
  bus and needs no schema compiler for a loopback / private-network bus.

**2. Envelope `labview-benchmark-actor/bus-msg@1`.**
`{ schema, sessionId, senderId, seq, ts: { wall, run }, type, task?, payload?, ackOf? }`.

- `senderId` is the participant identity (LBA-REQ-006), derived the same way as
  the current bus per-machine team name (a reused module under the LBA-REQ-001
  extraction boundary).
- `seq` is a monotonic per-sender sequence number; `type` is one of
  `CLAIM | ACK | HANDOFF | DONE | PROGRESS | RESULT | NOTE`. There is no
  image-fetch verb (see §5 — images never cross the bus).
- The shape mirrors `vihs-collab-msg@v1`, so the coordination model is preserved
  across the transport change (AD-7).

**3. Ordering and late-join — an append-only session log at the leader.** The
session leader (AD-7, "one owner") assigns a global order to accepted
coordination messages and appends them to a session log. A joining VM opens TCP,
sends `HELLO`, and receives a state **snapshot** (current claims, handoff owner,
last `seq` per sender, run-result heads) followed by a live tail — reconstructing
session state deterministically (LBA-REQ-007.2). Per-connection TCP order plus
the leader's global sequence give a total order for coordination.

**4. Check-before-publish — optimistic concurrency on the log.** A publisher
stamps the log offset (or per-sender `seq`) it last observed; the leader rejects
or warns a write that raced past an intervening message — mirroring the current
bus "the other agent posted N comment(s) since your last message" guard. Claims
are advisory locks (`CLAIM` → `ACK`); a hotspot has one owner at a time.

**5. Frame `ref` transport — metadata-only bus; frames resolve VM-locally
(ADR-0005 / LBA-REQ-009).** Per the cleanroom directive, **image bytes are never
carried on the bus** — neither inline nor fetched. The run-result and the
`RESULT` coordination message carry frame **metadata only** —
`{ index, t, ref, w, h }` plus run/session ids — where `ref` is a **local
pointer** into the origin VM's **mprr** review-capture store (long-packet
payload indexed by the short-packet stream; mprr ADR-0024), resolved by the
viewer **on that same VM** (LBA-REQ-005). Other VMs use the index/timestamp
metadata to correlate and compare frames across the session (aligned by the
ADR-0004 time-sync), never the bytes. This **supersedes** the earlier
content-addressed-FETCH design: there is **no `FETCH`/`FETCH_REPLY` verb and no
bulk-blob TCP connection**. Reviewing another VM's images is out-of-band access
to that VM's cleanroom store, by design (ADR-0005).

**6. Degrade-safe (LBA-REQ-007.3).** A framing error (bad length, over-cap,
invalid JSON) drops that one frame and surfaces a diagnostic without
desynchronizing the stream. A dropped TCP peer is detected by connection close
and by the UDP presence timeout (ADR-0004) and surfaced to the session. UDP loss
(ADR-0004) never touches this TCP-ordered state.

**7. Bind scope (LBA-REQ-007 assumption, AD-6).** The listener binds to loopback
or the private Vagrant network only — never a public interface.

## Consequences

- **+** The bus is a single, small, totally-ordered coordination + metadata
  channel; bus sizing is fully decoupled from image volume (images stay VM-local
  in mprr, ADR-0005) — no bulk plane and no head-of-line-blocking concern.
- **+** Late-join is snapshot + tail over metadata only (LBA-REQ-007.2); there
  is never any image transfer to replay.
- **+** Human-auditable JSON keeps the collab bus's skim-and-parse property; no
  schema compiler is required.
- **+** No `github.com` at run time (LBA-REQ-007.4), and no image bytes on the
  wire (LBA-REQ-009) — the coordination plane is fully local and payload-agnostic.
- **−** The session leader is a coordination anchor (a single point); mitigated
  by making leader state equal to the replayable log, so a re-elected leader can
  rebuild from any peer's log copy.
- **Open:** leader election / failover (who anchors if the leader VM dies) — a
  follow-up; the log-replay design makes state recoverable, so election is the
  remaining piece.
- **Open:** if a `RESULT` run-result with a very dense metric series approaches
  the coordination cap, page or summarize it on the bus (a metrics-size concern
  only — images are already off the bus via ADR-0005).
