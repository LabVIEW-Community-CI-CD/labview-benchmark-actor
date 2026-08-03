# ADR-0060: The append-only consistency proof — the mesh transparency log provably only grows (LBA-REQ-079)

- Status: Accepted
- Date: 2026-08-03
- Deciders: roadmap Phase 3 (the actor mesh — "append-only, tamper-evident transparency") + operator ("think bigger" + "become prescriptive") + agent
- Relates to: LBA-REQ-079 (realized here), LBA-REQ-078 / ADR-0059 (the transparency log whose append-only claim this closes), LBA-REQ-031 / ADR-0022 (the acg-transparency engine reused — `consistencyProof` / `verifyConsistency` / `signTreeHead`), LBA-REQ-077 / ADR-0058 (the attestations that are the log leaves)

## Context

ADR-0059 records the mesh-actor attestations into a signed Merkle transparency log and proves each attestation is
INCLUDED (an inclusion proof against a signed tree head), and it describes the log as "append-only, tamper-evident."
But inclusion alone does not prove the log only GROWS: a malicious or buggy log operator could publish a new tree
head that silently drops or rewrites an earlier entry, and each individual inclusion proof against that new head
would still verify. The RFC-6962 answer is a CONSISTENCY PROOF between two signed tree heads — the second provably
extends the first with no earlier entry removed or altered — and the acg-transparency engine already implements it
(`consistencyProof` / `verifyConsistency`). Closing ADR-0059's append-only claim means exercising that proof on the
real mesh log.

## Decision

- **Govern the append-only guarantee as LBA-REQ-079** with a pure, rg-free verifier
  (`experiments/mesh-fulfillment/meshLogHistory.mjs`) + a committed enrolled log-history key
  (`mesh-log-history-key.json`, public key only) + a committed history (`mesh-run-log-history.json`) + a selftest
  (7/7) + an append-only step in `.github/workflows/mesh-run.yml` + the gate `mesh-log-append-only`.
- **A `logged-collection-history@1`** binds an EARLIER signed tree head (the log at `firstSize`) + the CURRENT
  signed tree head (the full log) + the RFC-6962 consistency proof between them, all over the real attestation entry
  leaves (reusing the ADR-0022 `signTreeHead` / `consistencyProof`). `validateHistory` requires both tree heads to
  verify against the enrolled log key and share the log identity, the log to have STRICTLY GROWN
  (`firstSize < secondSize`), the consistency proof to prove append-only extension (`verifyConsistency`), and — the
  grounding — the current tree head to be the real attestation set AND to match the committed LBA-REQ-078 log by its
  Merkle root + size. It fails closed on an unsigned/wrong-key tree head, a non-growing or shrinking log, a
  consistency proof that does not verify (a rewritten or forked log), a current head that does not match the
  committed log, or a tampered digest.
- **The gate** `mesh-log-append-only` proves, offline + deterministically: the selftest (7/7); the committed history
  re-verifies (both signed tree heads + the consistency proof) via the CLI; the log strictly grew; the current tree
  head is the committed LBA-REQ-078 log (same Merkle root + size); and `mesh-run.yml` runs the append-only step. The
  enrolled log PUBLIC key is committed; the private key is not.

## Consequences

- **The mesh transparency log is now provably append-only** — a consistency proof binds the current tree head to an
  earlier one and proves no logged attestation was removed or rewritten as the log grew (here, the log growing from
  one to two attestations as the second actor's receipt was appended). ADR-0059's "append-only, tamper-evident"
  claim is now backed by a verified proof, not just asserted.
- **The mesh transparency subsystem is complete** — inclusion (LBA-REQ-078) proves an attestation IS in the log;
  consistency (this ADR) proves the log only grows. Together they are the full RFC-6962 transparency guarantee,
  applied to the mesh, reusing the same acg-transparency engine as release provenance. Auditing a later tree head
  needs only a consistency proof against a head one already trusts.
- **The history is grounded in the real log** — the current tree head is bound to the committed LBA-REQ-078 log by
  its Merkle root (the content identity of the log), so this is THIS mesh log's append-only history, not an abstract
  demonstration. (In the committed-fixture model the signing private key is ephemeral per increment; the root
  binding is the cryptographic link, and in a live log one long-lived enrolled key signs successive heads.)
- The gate is DETERMINISTIC + offline (no network / log operator / private key at gate time; it verifies a committed
  consistency proof between committed signed tree heads), consistent with the rg-free / tool-free CI constraint.
  Authored under the singular-requirement directive (one `shall`).
