# Multi-VM out-of-band corpus export (LBA-REQ-010 / T-010 leg 2)

Proves **T-010 leg 2**: "completed runs are concentrated to the operator's host by an explicit
**out-of-band step (not the bus)**." Builds directly on the proven two-golden-box topology
([../run-topology.ps1](../run-topology.ps1), LBA-REQ-006) and feeds LINUX's **shipped** corpus-manifest
ingestion boundary ([../../host-concentration/ingestCorpusManifest.mjs](../../host-concentration/ingestCorpusManifest.mjs), LBA-REQ-010).

This is a **WIN-topology + LINUX-boundary integration**: the real multi-VM out-of-band transport is mine;
the ingestion/concentration/dereference/comparison logic is LINUX's `concentrateManifest()`,
`dereferenceMetrics()`, `reviewOwnRuns()`, `buildComparisonPlan()` and `compareOverCorpus()`, imported
verbatim (no reimplementation). The manifest this produces is the **REAL multi-VM concentrated corpus** that
LINUX's `sample-corpus-manifest.json` / `complete-corpus` fixtures stand in for, and it is **drive-ready**
for the live ollama drive ([../../ollama-comparison/drive-real-corpus.mjs](../../ollama-comparison/drive-real-corpus.mjs)).

## What is proven (see [receipt.json](receipt.json))

| Signal | Evidence |
| --- | --- |
| Each VM produces its OWN-run corpus | `actor-a` (a REGRESSION across its two runs) and `actor-b` (an IMPROVEMENT) each emit `{ actorId, runs:[{runId, completedAt, metrics, frame}] }` VM-local, metrics in the shipped `{ cpuMeanPct, ramMeanMiB, durationMs, framesRendered }` shape |
| Out-of-band transport (not the bus) | host fetches each bundle over **WinRM file-fetch** (`vagrant winrm … base64`), never over lbabus net — the coordination bus stays comms-only (ADR-0006/0008) |
| Flows through the shipped boundary | host materializes `exported-corpus/<actorId>/<runId>/metrics.json` + `exported-corpus/manifest.json` (`corpus-manifest@v1`, relative metricsRefs) and ingests it through `concentrateManifest()` — no hand editing |
| Per-actor isolation | `reviewOwnRuns(corpus, actor)` returns exactly that actor's runs, never another's (no cross-VM read); per-actor own-runs partition the corpus exactly |
| Out-of-band metric dereference | `dereferenceMetrics(corpus, exported-corpus/)` reads each run's VM-local metrics file (a path in the manifest) into a real `cpuMean=…pct, ramMeanMiB=…, durationMs=…` summary |
| Same-actor comparison plan | `buildComparisonPlan()` pairs each actor's own runs only; prompts embed the REAL dereferenced values; a mock drive yields one same-actor verdict per comparison |
| Run-data-only invariant | a bus-shaped corpus (carrying `senderId` / `ackOf`) is **rejected** by `concentrateManifest()` |
| Determinism | re-ingesting the same manifest reproduces the same `corpusDigest` |
| Drive-ready (committed corpus) | `receipt.driveReady == true` + `receipt.driveCommand` points the maintainer at `drive-real-corpus.mjs --manifest exported-corpus/manifest.json`; the manifest + metrics are **committed** so the live GPU drive runs without these VMs |

Run **DATA** stays VM-local (metrics + frames under `C:\actor-runs\`); only the per-actor bundle crosses to
the host over the out-of-band WinRM fetch, where it is re-materialized into the `corpus-manifest@v1` the
ingestion boundary consumes — faithful to the design (the bus never carries run data, and run data reaches
the host only by this explicit out-of-band step). The `exported-corpus/` manifest + metrics are **committed**
(a fresh run regenerates them) so the live GPU drive (leg 3) can run on a host **without** these Windows VMs.

## Layout
- [export-corpus.ps1](export-corpus.ps1) — host driver: ensures the two VMs are up, runs the per-actor
  producer on each (VM-local metrics in the shipped shape + a frame), fetches both bundles out-of-band over
  WinRM, materializes the committed `exported-corpus/<actorId>/<runId>/metrics.json` layout + `exported-corpus/manifest.json`
  (`corpus-manifest@v1`, BOM-free, relative metricsRefs), then invokes the concentrator.
- [concentrate-corpora.mjs](concentrate-corpora.mjs) — ingests the manifest through the shipped
  `concentrateManifest()` + `dereferenceMetrics()` boundary and `buildComparisonPlan()` /
  `compareOverCorpus()`; asserts schema, isolation + partition, bus-rejection, determinism, real
  dereferenced values, and a same-actor plan; writes `receipt.json`
  (`schema: labview-benchmark-actor/multi-vm-corpus-export-receipt-v1`).
- [receipt.json](receipt.json) — machine-readable proof of the most recent run (gated by
  `multi-vm-corpus-export-receipt-green` in `../../verify-local-gates.mjs`).

## Re-run
```powershell
# from experiments/multi-vm-topology/ (holds the Vagrantfile), with Vagrant + Node on PATH
vagrant up                                  # actor-a + actor-b
pwsh -NoProfile -File .\corpus-export\export-corpus.ps1
Get-Content .\corpus-export\receipt.json    # pass == true, driveReady == true
```

## Live drive (maintainer / GPU step)
After a run, the emitted manifest is drive-ready — point the live ollama drive at it on a GPU host:
```bash
node experiments/ollama-comparison/drive-real-corpus.mjs \
  --manifest experiments/multi-vm-topology/corpus-export/exported-corpus/manifest.json --model llama3.1:8b
```

## Relationship to LBA-REQ-010
The cores (`concentrate()` / `reviewOwnRuns()`), the ingestion boundary (`concentrateManifest()` /
`dereferenceMetrics()`), and the ollama-comparison plan are proven by their own deterministic self-tests
over fixtures. This experiment proves the remaining **real multi-VM out-of-band export** that produces the
concentrated corpus those fixtures stand in for, flowing through the exact same boundary. The only 010 leg
still open is the **live** host-side ollama verdict over this real concentrated corpus (the GPU / maintainer
step) — the manifest is drive-ready for it.
