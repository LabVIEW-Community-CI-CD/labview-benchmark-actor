# Multi-VM out-of-band corpus export (LBA-REQ-010 / T-010 leg 2)

Proves **T-010 leg 2**: "completed runs are concentrated to the operator's host by an explicit
**out-of-band step (not the bus)**." Builds directly on the proven two-golden-box topology
([../run-topology.ps1](../run-topology.ps1), LBA-REQ-006) and feeds the **shipped**
host-concentration core ([../../host-concentration/hostConcentration.mjs](../../host-concentration/hostConcentration.mjs), LBA-REQ-010).

This is a **WIN-topology + LINUX-core integration**: the multi-VM out-of-band transport is mine; the
concentration/isolation logic is LINUX's `concentrate()` / `reviewOwnRuns()`, imported verbatim (no
reimplementation).

## What is proven (see [receipt.json](receipt.json))

| Signal | Evidence |
| --- | --- |
| Each VM produces its OWN-run corpus | `actor-a`, `actor-b` each emit `{ actorId, runs:[{runId, completedAt, metricsRef, framesRef}] }` VM-local |
| Out-of-band transport (not the bus) | host fetches each corpus over **WinRM file-fetch** (`vagrant winrm … base64`), never over lbabus net — the coordination bus stays comms-only (ADR-0006/0008) |
| Per-actor isolation | `reviewOwnRuns(corpus, actor)` returns exactly that actor's runs, never another's (no cross-VM read); per-actor own-runs partition the corpus exactly |
| Run-data-only invariant | a bus-shaped corpus (carrying `senderId` / `ackOf`) is **rejected** by `concentrate()` |
| Determinism | re-concentrating the same inputs reproduces the same `corpusDigest` |

Run **DATA** stays VM-local (metrics + frames under `C:\actor-runs\`); only the concentrated **manifest**
(actorId + run refs) crosses to the host — faithful to the design (the bus never carries run data, and run
data reaches the host only by this explicit out-of-band step).

## Layout
- [export-corpus.ps1](export-corpus.ps1) — host driver: ensures the two VMs are up, runs the per-actor
  producer on each, fetches both corpora out-of-band over WinRM, then invokes the concentrator.
- [concentrate-corpora.mjs](concentrate-corpora.mjs) — imports the shipped `concentrate()` /
  `reviewOwnRuns()`, asserts isolation + bus-rejection + determinism, writes `receipt.json`
  (`schema: labview-benchmark-actor/multi-vm-corpus-export-receipt-v1`).
- [receipt.json](receipt.json) — machine-readable proof of the most recent run.

## Re-run
```powershell
# from experiments/multi-vm-topology/ (holds the Vagrantfile), with Vagrant + Node on PATH
vagrant up                                  # actor-a + actor-b
pwsh -NoProfile -File .\corpus-export\export-corpus.ps1
Get-Content .\corpus-export\receipt.json    # pass == true
```

## Relationship to LBA-REQ-010
`concentrate()` / `reviewOwnRuns()` (own-run review, no cross-VM) and the ollama-comparison plan are proven
by their own core self-tests. This experiment proves the remaining **real multi-VM out-of-band export**
that feeds them. The only 010 leg still open is the **live** host-side ollama drive over this concentrated
corpus (the GPU / maintainer step).
