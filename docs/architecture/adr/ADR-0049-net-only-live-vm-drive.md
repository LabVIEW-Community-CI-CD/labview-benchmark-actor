# ADR-0049: Net-only live VM-agent drive — govern the released-CLI closed loop as a committed receipt (LBA-REQ-068)

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator directive (2026-08-03: govern the repeatedly-proven net-only live VM drive as a durable, CI-enforced increment) + agent
- Relates to: LBA-REQ-068 (realized here), LBA-REQ-059 / ADR-0039 (the host<->VM-agent closed-loop read-back MECHANISM this builds on), LBA-REQ-067 / ADR-0047 (removed the CLI Discussion transport — the net-only guarantee), the collab-cli 0.15.0 release (`collab-cli-v0.15.0`, the released net-only binary), ADR-0040 (live-only net coordination), ADR-0003 / ADR-0004 (net wire format `bus-msg@1` + TCP transport)

## Context

LBA-REQ-059 / ADR-0039 proved the host<->VM-agent closed loop over `lbabus net` — the host drives the reviewer
VM's Copilot agent (keyboard injection) and AWAITS the agent's reply frame CORRELATED by task id
(`await-agent-reply`, fail-closed) — but it was proven while the CLI still SHIPPED a GitHub-Discussion
transport (the VM ran `lbabus` 0.13.0). Since then the off-Discussions migration completed (PRs #334–#346),
`collab-cli 0.15.0` was released **net-only** (`collab-cli-v0.15.0`, an immutable GitHub Release), and the host
drove the reviewer VM to INSTALL that released binary and report back over `net` — repeatedly: the net-only
install, a benchmark re-drive (launch-to-ready 2604.2 ms / 5 samples PASS), and the WIN-plane 0.15.0 release
sign-off (`version=0.15.0`, `post → unknown command`, PASS). That capability is proven but **ungoverned**: the
receipts live in `/tmp`, so nothing re-verifies it in CI and nothing pins it to the released binary.

## Decision

- **Govern the net-only live VM drive as LBA-REQ-068** with a committed, fail-closed receipt
  (`reviewer-workstation/net-only-live-drive-receipt.json`, schema `net-only-live-drive-receipt@1`) + a pure,
  rg-free verifier (`net-only-live-drive.mjs`: schema + digest + build + validate) + a selftest
  (`net-only-live-drive.selftest.mjs`, 7/7) + the gate **`net-only-live-drive`**.
- The receipt SEALS the real drives from the reviewer VM (senderId `WIN`) over `net` + the released-CLI net-only
  proof: `collab-cli-v0.15.0` rejects the retired `init`/`post`/`poll`/`wait`/`delta` commands (observed on the
  VM as `unknown command`, exit 1). The verifier re-derives the digest + verdict DETERMINISTICALLY at gate time
  (no VM / network), and fails closed on a drive that did not close the loop over `net` (a non-`WIN` sender, a
  disallowed type, an unmatched reply), an incomplete net-only proof (a retired command not recorded rejected,
  or no `collab-cli-v*` release tag), a forged verdict, or a tampered digest.
- **Scope — distinct from its neighbours.** LBA-REQ-059 governs the read-back CORRELATION mechanism + the
  semantic net verdict types; LBA-REQ-067 governs the CLI Discussion-transport REMOVAL. LBA-REQ-068 governs the
  LIVE DRIVE of the RELEASED net-only binary end-to-end on the VM, committed as durable evidence — tying the
  release (`collab-cli-v0.15.0`) to the drive capability.

## Consequences

- **The net-only live-drive capability is CI-enforced + reproducible off any GitHub-Discussion dependency**, and
  the binary it exercises is the RELEASED one, so "the released CLI drives end-to-end on the VM" stays true.
- **Re-capture is scripted:** `drive-agent-closed-loop.sh` + `await-agent-reply.mjs` produce a
  `closed-loop-readback@1` reply-receipt per drive; `buildReceipt` seals a `net-only-live-drive` receipt from a
  batch of such drives. Refreshing to a FUTURE release = re-run the drives against the new binary + rebuild the
  receipt with the new `releaseTag` (the digest re-derives, the gate re-verifies).
- **Comms-only holds (ADR-0003):** each VM reply is a one-line status only, never run data.
- The gate is DETERMINISTIC + offline (no VM / LabVIEW / network at gate time), consistent with the rg-free /
  tool-free CI constraint. Authored under the singular-requirement directive (one `shall`).
