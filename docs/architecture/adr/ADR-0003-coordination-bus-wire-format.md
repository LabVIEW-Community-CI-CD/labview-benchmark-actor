# ADR-0003: Coordination bus wire format — length-prefixed JSON over TCP

- Status: Proposed
- Owner: LINUX
- Traces to: LBA-REQ-007 (TCP/UDP coordination bus); supports LBA-REQ-006 (multi-VM) and the ADR-0001 frame-`ref` transport used by LBA-REQ-005
- Standards baseline: `repo-standards-review` v0.2.19

## Context

LBA-REQ-007 replaces the GitHub-Discussion collab bus with a local TCP+UDP bus
so benchmarking runs offline. The reliable, ordered plane (claims, handoffs,
acks, dones, results) is **TCP** and is specified here; presence and time-sync
are **UDP** and are specified in ADR-0004. The bus must mirror the proven collab
semantics (claim → ack → handoff → done, check-before-publish, one owner per
hotspot) while changing only the transport (AD-7), and it must let a
late-joining VM reconstruct current session state (LBA-REQ-007.2).

ADR-0001 defines the run-result with a content-addressed frame `ref` and
explicitly defers **one** transport concern to this ADR: how a frame `ref`
crosses VMs — **inline** in the envelope or **fetched** over the bus.

## Decision

**1. Framing — length-prefixed JSON over TCP.** Each message is a 4-byte
big-endian unsigned length prefix followed by exactly that many bytes of UTF-8
JSON (one envelope per frame). A per-connection maximum frame size (default
**1 MiB** on the coordination channel) fails closed on a corrupt or hostile
length.

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
  `CLAIM | ACK | HANDOFF | DONE | PROGRESS | RESULT | NOTE`, plus the fetch verbs
  in decision 5.
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

**5. Frame `ref` transport — content-addressed FETCH, not inline (answers the
ADR-0001 open item).** The run-result and the `RESULT` coordination message carry
frame **metadata only** — `{ index, t, ref, w, h }`, with `ref` a **content hash**
(sha256). Image bytes are never inlined in the coordination stream. A peer (or
the viewer, LBA-REQ-005) fetches bytes on demand with a content-addressed verb:
`FETCH { hash }` → `FETCH_REPLY { hash, len }` followed by the raw bytes (same
4-byte length-prefixed framing). To keep a large image from head-of-line-blocking
coordination, blob transfer runs on a **separate bulk TCP connection** per peer
(default cap **64 MiB** per blob); the coordination channel stays small and
responsive. Content addressing gives dedup (a hash is fetched and cached once)
and cheap late-join: replay metadata, and fetch a blob lazily only when the
viewer actually scrubs to it — keeping "large images off the hot path" (ADR-0001).

**6. Degrade-safe (LBA-REQ-007.3).** A framing error (bad length, over-cap,
invalid JSON) drops that one frame and surfaces a diagnostic without
desynchronizing the stream. A dropped TCP peer is detected by connection close
and by the UDP presence timeout (ADR-0004) and surfaced to the session. UDP loss
(ADR-0004) never touches this TCP-ordered state.

**7. Bind scope (LBA-REQ-007 assumption, AD-6).** The listener binds to loopback
or the private Vagrant network only — never a public interface.

## Consequences

- **+** The coordination stream stays small and totally ordered; large images
  are off the hot path (aligns with ADR-0001) and are deduplicated by hash.
- **+** Late-join is snapshot + tail, with no full-history image download
  (LBA-REQ-007.2).
- **+** Human-auditable JSON keeps the collab bus's skim-and-parse property; no
  schema compiler is required.
- **+** No `github.com` at run time (LBA-REQ-007.4) — the transport is fully
  local.
- **−** The session leader is a coordination anchor (a single point); mitigated
  by making leader state equal to the replayable log, so a re-elected leader can
  rebuild from any peer's log copy.
- **−** A separate bulk channel adds a second socket per peer; justified by
  avoiding head-of-line blocking of coordination by image transfer.
- **Open:** leader election / failover (who anchors if the leader VM dies) — a
  follow-up; the log-replay design makes state recoverable, so election is the
  remaining piece.
- **Open:** whether a very large `RESULT` run-result is itself content-addressed
  and fetched (the same inline-vs-fetch tradeoff one level up) — lean fetch for
  parity.
