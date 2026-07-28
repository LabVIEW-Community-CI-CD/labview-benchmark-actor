# host-concentration (LBA-REQ-010)

Deterministic core for the **host-concentration** step: each actor's OWN completed-run corpus is
concentrated onto the operator's host **out-of-band** (never over the coordination bus), preserving
strict per-actor isolation, to feed the host-side **ollama comparison layer**.

## Contract

- `concentrate(corpora)` merges per-actor `{ actorId, runs }` corpora into one host corpus. Every run
  retains its source `actorId` (isolation), runs are ordered deterministically, and the corpus carries a
  content digest. A **bus-shaped** input (a coordination message carrying `vihs-collab-msg` / `ackOf` /
  `senderId`) is rejected — the bus is never a run-data channel (ADR-0006 / ADR-0008).
- `reviewOwnRuns(corpus, actorId)` returns exactly that actor's runs (LBA-REQ-010 AC #1: no cross-VM
  comparison at the actor level; comparison is host-side only).

## Verify

```
node experiments/host-concentration/verify-host-concentration.mjs [--json]
```

Runs the dependency-free self-test (no GPU / no live ollama) and writes `receipt.json`. Proves
deterministic concentration, per-actor isolation (own-run review with no cross-VM leakage), the
comms-only invariant (bus-shaped input rejected), and the ollama-comparison input contract. Re-validated
by `experiments/verify-local-gates.mjs`.

## Scope

The deterministic **core** is proven here (moves LBA-REQ-010 from Planned to Partial). The live
host-side ollama comparison over a real multi-VM concentrated corpus is the maintainer/VM step
(see ADR-0006).
