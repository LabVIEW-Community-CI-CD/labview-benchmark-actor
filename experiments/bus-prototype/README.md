# Experiment: comms-only coordination bus prototype (Phase-2 de-risk)

De-risks the **net-new, least-proven** piece of the labview-benchmark-actor spec:
the TCP/UDP inter-actor coordination bus. mprr (the storage/timeline model)
has **no** inter-actor bus — it coordinates via a VirtualBox shared folder + TDMS
files — so ADR-0003/0004 are the only unproven transport in the design. This
experiment stands the bus up on `127.0.0.1` with Node built-ins only (`net`,
`dgram`) and asserts the exact contracts the ADRs claim.

## Run

```
node busPrototype.mjs
```

Exit `0` = all assertions passed, `1` = a failure. A machine-readable receipt is
printed between `---RECEIPT-JSON-START---`/`---RECEIPT-JSON-END---` and retained
in [receipt.json](receipt.json).

## What it grounds

- **ADR-0003** — length-prefixed JSON over TCP (4-byte big-endian length + UTF-8
  JSON), the `labview-benchmark-actor/bus-msg@1` envelope, leader-ordered
  append-log late-join (`HELLO` -> `SNAPSHOT` + replay tail), and
  check-before-publish (optimistic concurrency on the log head via `lastSeenSeq`).
- **ADR-0004** — UDP presence/liveness beacon (advisory; loss must not corrupt
  the TCP-ordered state) and dropped-peer detection.
- **LBA-REQ-006/007 + T-007** — the acceptance behavior of the coordination bus.

Comms-only per the cleanroom model (ADR-0005/0006, LBA-REQ-007/009/010): the bus
carries coordination messages only (`CLAIM/ACK/HANDOFF/DONE/PROGRESS/NOTE`),
never run data, frame metadata, or images.

## Assertions (12, deterministic — 5/5 repeat runs 12/12)

1. framing round-trips a payload with embedded newline/tab/quotes/backslash
2. oversize frame rejected on encode (> 1 MiB cap)
3. oversize length rejected on decode (fail closed + surfaced)
4. TCP total order is identical across peers (`globalSeq` 1..4)
5. leader derives session state (claims/handoff owner) from the log
6. a late joiner reconstructs state via snapshot + replayed tail
7. check-before-publish rejects a stale `lastSeenSeq`
8. ...and accepts a fresh publish (next `globalSeq`)
9. UDP presence beacons flow
10. total UDP loss does not corrupt TCP-ordered state (LBA-REQ-007.3)
11. presence timeout flags the peers that went silent (not the still-beating one)
12. a dropped TCP peer is detected and surfaced

## Notes / holes surfaced

- Beacon cadence here is 40 ms (spec default is 1 Hz) purely to keep the
  self-test fast; `MISS_K = 3`.
- The append-log late-join replays the **full** log for determinism; a
  production leader would tail from the joiner's last offset (snapshot already
  carries `globalSeqHead`/`lastSeqBySender` for that).
- Leader election/failover is still an open item (ADR-0003) — out of scope here;
  state is recoverable from the replayable log, election is the remaining piece.
