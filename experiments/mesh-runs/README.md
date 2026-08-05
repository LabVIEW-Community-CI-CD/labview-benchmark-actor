# mesh-runs — repeatable containerized lbabus mesh runs, keyed by commit + run number

Reliable, **repeatable** lbabus mesh runs on Linux containers, with a **unique per-run prefix** and **stored
per-run logs**, so runs are individually identifiable and comparable **across runs and commits** (for agent
inference). This is the container-native complement to the VM mesh (`cleanroom/ubuntu-labview/mesh/`) — it
runs the **same** [`mesh-actor.sh`](../../tools/collab-cli/ci/mesh-actor.sh) workload from the
`lbabus-linux-verify:mesh` image (`tools/collab-cli/ci/Dockerfile.linux --target mesh`), forms in seconds,
and is free of the VM/NAT/boot flakiness.

## Run id = `<commit>-r<NNN>`

Every run's id (and therefore every actor name `mesh-<commit>-r<NNN>-actor-<i>`, network, and stored record)
is built from the **git commit** the run executed at plus a **per-commit run number**:

- `commit` = `git rev-parse --short HEAD` (with a `-dirty` marker if the tree has uncommitted changes).
- run number = `1 +` the highest `r<NNN>` already stored for that commit.

So `4770925-r003` is the 3rd run at commit `4770925`. Runs at the **same** commit measure variance; runs
across commits measure change — the basis for regression inference.

## Store

`ci/mesh-linux.sh` is a one-shot PASS/FAIL gate that self-cleans (logs discarded). This harness KEEPS the
evidence: before cleanup it writes, under `experiments/mesh-runs/<runId>/`:

- `<actor>.log` — each actor's timestamped container log (`docker logs -t`).
- `manifest.json` — `{ runId, commit, runNumber, image, actors, result, okCount, meshFormMs{min,mean,max},
  perActor[{name, exitCode, meshOk, tcpHeard, udpHeard, meshFormMs}] }`.

Per-run output dirs are gitignored (they accumulate + are reproducible); commit one only to pin it as a
fixture.

## Use

```bash
node experiments/mesh-runs/run-mesh.mjs --actors 3     # form a mesh; store the run
node experiments/mesh-runs/run-mesh.mjs --actors 8     # scale up
node experiments/mesh-runs/compare-mesh-runs.mjs       # compare every stored run + the meshFormMs trend
```

`meshFormMs` (per actor: `mesh start` → `MESH OK`, from the log timestamps) is the container-mesh benchmark
metric — it is the mesh-formation leg, the reliable analog of the boot-benchmark's `meshFormMs` span.

Prereq: build the image once — `docker build -f tools/collab-cli/ci/Dockerfile.linux --target mesh -t lbabus-linux-verify:mesh .`.
