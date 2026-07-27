# ADR-0003: Coordination bus wire format — length-prefixed JSON over TCP

- Status: Proposed
- Owner: LINUX
- Traces to: LBA-REQ-007 (inter-actor coordination bus); supports LBA-REQ-006 (multi-VM); the bus carries NO run/frame data or metadata — comms only (ADR-0005 / ADR-0006, LBA-REQ-009/010)
- Standards baseline: `repo-standards-review` v0.2.19

## Context

LBA-REQ-007 replaces the GitHub-Discussion collab bus with a local TCP+UDP bus
so benchmarking runs offline. The reliable, ordered plane (claims, handoffs,
acks, dones, results) is **TCP** and is specified here; presence and time-sync
are **UDP** and are specified in ADR-0004. The bus must mirror the proven collab
semantics (claim → ack → handoff → done, check-before-publish, one owner per
hotspot) while changing only the transport (AD-7), and it must let a
late-joining VM reconstruct current session state (LBA-REQ-007.2).

Successive operator directives (ADR-0005, then ADR-0006 / LBA-REQ-010) fix the
bus's scope: it carries **inter-actor communication only** — the
GitHub-Discussion replacement. **No run data, run/frame metadata, or images ever
cross it**; the entire **mprr** ring buffer stays VM-local, each actor reviews
only its **own** prior runs, and completed runs are concentrated to the operator
host **out-of-band** for a host-side ollama layer. §5 records that scope (it
supersedes earlier metadata-on-the-bus and content-addressed-FETCH drafts).

## Decision

**1. Framing — length-prefixed JSON over TCP.** Each message is a 4-byte
big-endian unsigned length prefix followed by exactly that many bytes of UTF-8
JSON (one envelope per frame). A per-connection maximum frame size (default
**1 MiB** — the bus carries only small inter-actor coordination messages, per §5)
fails closed on a corrupt or hostile length.

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
  `CLAIM | ACK | HANDOFF | DONE | PROGRESS | NOTE` (the GitHub-Discussion
  replacement set). There is no run-data or image-fetch verb (see §5); a
  run-complete signal is a bare `DONE`/`NOTE` notice with no run payload.
- The shape mirrors `vihs-collab-msg@v1`, so the coordination model is preserved
  across the transport change (AD-7).

**3. Ordering and late-join — an append-only session log at the leader.** The
session leader (AD-7, "one owner") assigns a global order to accepted
coordination messages and appends them to a session log. A joining VM opens TCP,
sends `HELLO`, and receives a state **snapshot** (current claims, handoff owner,
last `seq` per sender) followed by a live tail — reconstructing
session state deterministically (LBA-REQ-007.2). Per-connection TCP order plus
the leader's global sequence give a total order for coordination. The
`experiments/bus-prototype/` echo replays the **full** log on join; because the
snapshot already carries `globalSeqHead` and `lastSeqBySender`, a production
leader can instead **tail from the joiner's last offset** — a bounded future
optimization, not a correctness gap.

**4. Check-before-publish — optimistic concurrency on the log.** A publisher
stamps the log offset (or per-sender `seq`) it last observed; the leader rejects
or warns a write that raced past an intervening message — mirroring the current
bus "the other agent posted N comment(s) since your last message" guard. Claims
are advisory locks (`CLAIM` → `ACK`); a hotspot has one owner at a time.

**5. No run or frame data on the bus — comms only (ADR-0005 / ADR-0006,
LBA-REQ-007/009/010).** The bus is the **inter-actor communication channel
only** — the GitHub-Discussion replacement. It carries **no run data, no
run/frame metadata, and no images**. The entire **mprr** ring buffer (short- and
long-packet) stays VM-local (ADR-0005); each actor's viewer reviews only that
VM's **own** prior runs (ADR-0002), and completed runs reach the operator host
by an **out-of-band** concentration step for a host-side ollama layer — never
over the bus (ADR-0006 / LBA-REQ-010). There is therefore **no
`FETCH`/`FETCH_REPLY` verb, no bulk-blob connection, and no frame-metadata
payload**; a run-complete signal is at most a bare `DONE`/`NOTE` coordination
notice (e.g. `{ runId, status }`) with no run-result payload. There is no
cross-VM run correlation or comparison on the wire. This supersedes the earlier
content-addressed-FETCH and metadata-on-the-bus drafts.

**6. Degrade-safe (LBA-REQ-007.3).** A framing error (bad length, over-cap,
invalid JSON) drops that one frame and surfaces a diagnostic without
desynchronizing the stream. A dropped TCP peer is detected by connection close
and by the UDP presence timeout (ADR-0004) and surfaced to the session. UDP loss
(ADR-0004) never touches this TCP-ordered state.

**7. Bind scope (LBA-REQ-007 assumption, AD-6).** The listener binds to loopback
or the private Vagrant network only — never a public interface.

## Consequences

- **+** The bus is a single, small, totally-ordered inter-actor coordination
  channel; bus sizing is fully decoupled from run/image volume (all run data
  stays VM-local in mprr, ADR-0005) — no bulk plane and no head-of-line concern.
- **+** Late-join is snapshot + tail over coordination state only
  (LBA-REQ-007.2); there is never any run/image data to replay.
- **+** Human-auditable JSON keeps the collab bus's skim-and-parse property; no
  schema compiler is required.
- **+** No `github.com` at run time (LBA-REQ-007.4) and no run/frame data on the
  wire (LBA-REQ-009) — the bus is purely local inter-actor coordination.
- **−** The session leader is a coordination anchor (a single point); mitigated
  by making leader state equal to the replayable log, so a re-elected leader can
  rebuild from any peer's log copy.
- **`[Open]`** Leader election / failover (who anchors if the leader VM dies)
  is **not yet designed**. Session state is log-recoverable (proven by the
  prototype's snapshot + replay), so a re-elected leader can rebuild from any
  peer's log copy — but the election/failover mechanism itself remains the one
  genuine open item of this ADR.

## Validation (2026-07-27)

Grounded by a running prototype, not prose: `experiments/bus-prototype/`
(`busPrototype.mjs`, Node built-ins `net`+`dgram`) exercises this wire format
end-to-end and passes **12/12** assertions, **deterministic across 5 back-to-back
runs**, and **cross-platform** (LINUX node v22 + WIN node v24, same 12/12). It
proves: length-prefixed-JSON framing round-trips embedded control chars; oversize
rejected on encode and fail-closed on decode without stream desync; TCP total
order identical across peers; leader state derived from the append-log; late-join
snapshot + tail reconstruct; check-before-publish rejects a stale `lastSeenSeq`
and accepts a fresh one. See `experiments/bus-prototype/receipt.json`.
