# provider-delegation — AI providers on cleanrooms, delegated uplift + doc domains over the bus

A dependency-free harness that lets a **cleanroom actor run a local AI provider** (Ollama, the Copilot CLI,
Codex, or a deterministic mock) against a delegated **"uplift domain"** or **documentation-drafting** task,
gate the result deterministically, and **announce the receipt over the `lbabus` TCP/UDP bus** — so a host
observer collects each cleanroom's outcome. It composes existing infra (it invents no new transport or
protocol): the `bus-msg@1` envelope (ADR-0003), the `ollama-drive` HTTP contract, the `ollama-comparison`
`driveFn(prompt)` seam, and the `agents --role` domain brief.

This is the **LINUX-plane slice** of the approved idea *"use a provider like Copilot CLI, Codex, Ollama on
cleanrooms to delegate specific uplift domains and documentation drafting."* It pairs with the first-boot
**gate suite** (`cleanroom/ubuntu-labview` → `lba-gate-suite.service`): a clean-room boots, builds `lbabus`,
**self-certifies** (gate suite), then runs delegated uplift/doc tasks and **announces the receipts** on the
bus.

## Pieces

| File | Purpose |
|------|---------|
| [providerAdapters.mjs](providerAdapters.mjs) | The provider-**agnostic** seam: `async drive(prompt, opts) -> { provider, model, text, ms, ok, error }`. Adapters: `ollama` (POST `/api/generate`, the proven `ollama-drive` contract), `copilot-cli` + `codex` (shell the CLI, behind the seam), `mock` (deterministic, offline — the gate driver). |
| [delegateUplift.mjs](delegateUplift.mjs) | The delegation unit: validate a `lba-uplift-task@v1` spec → build a prompt → drive the provider → apply the **deterministic acceptance gate** → write a `lba-uplift-delegation-receipt@v1` receipt → optionally **announce** it as an ADR-0003 `DONE` frame over `lbabus net`. |
| [verify-provider-delegation.mjs](verify-provider-delegation.mjs) | Deterministic self-test (mock adapter, no GPU/network): task-spec validation, the provider seam, the acceptance gate (pass **and** fail), and the receipt schema. |
| [busFrame.mjs](busFrame.mjs) | Shared ADR-0003 framing (encode/decode/`sendFrame`) so the coordinator + worker speak the same `bus-msg@1` wire as `lbabus net`. |
| [coordinator.mjs](coordinator.mjs) | **Host** side of bus-side tasking: dispatch a `CLAIM` (task-spec in `payload`) to a worker, collect the `ACK` + `DONE` receipt. |
| [worker.mjs](worker.mjs) | **Cleanroom** side: listen for a `CLAIM`, `ACK` it, run the delegation (`runDelegation`), and return the `DONE` receipt. |
| [verify-claim-tasking.mjs](verify-claim-tasking.mjs) | Deterministic self-test of the dispatch → claim → return loop (loopback, mock, no GPU/network). |
| [verify-worker-pool.mjs](verify-worker-pool.mjs) | Deterministic self-test of the persistent **pool**: M concurrent claims bounded to N, queued + drained (loopback, mock). |
| [coverageLift.mjs](coverageLift.mjs) | The **coverage-lift** domain: prompt a test for a `target` module, run it under `NODE_V8_COVERAGE`, gate on the measured **function** coverage (dependency-free V8 parse, no c8). |
| [fixtures/sample-module.mjs](fixtures/sample-module.mjs) | The deterministic coverage-lift **target** (pure functions with branches). |
| [verify-coverage-lift.mjs](verify-coverage-lift.mjs) | Deterministic proof of the measured gate (thorough=pass, weak=fail, failing-test=fail). |
| [sample-task.doc-draft.json](sample-task.doc-draft.json) | An example `doc-draft` task (draft the gate-suite operator note). |
| [receipt.json](receipt.json) | The committed **deterministic** receipt (mock path). |

## Task-spec — `labview-benchmark-actor/lba-uplift-task@v1`

```jsonc
{
  "schema": "labview-benchmark-actor/lba-uplift-task@v1",
  "domain": "doc-draft",            // doc-draft | coverage-lift | risky-test | evidence
  "id": "T-...",                    // stable task id (-> receipt + bus task tag)
  "brief": "what to produce",       // becomes the provider prompt
  "requiredSections": ["Overview"], // acceptance: each must appear as a heading
  "minChars": 400,                  // acceptance: minimum output length
  "provider": "ollama",             // default provider (overridable via --provider)
  "model": "llama3.1:8b"            // default model (overridable via --model)
}
```

The **acceptance gate** is deterministic and structural (needs no model): `min-chars` + one `section:<name>`
check per required section. Provider output is non-deterministic, but the task-spec, the gate, and the
receipt are — so the harness is fully proven with the mock provider.

## Receipt — `labview-benchmark-actor/lba-uplift-delegation-receipt@v1`

`{ schema, generatedAt, task{domain,id,provider,model}, provider{ok,error,ms}, output{chars,artifact?},
acceptance{checks[{name,ok}],verdict}, verdict, announce? }` — `verdict` is `pass` iff the provider succeeded
**and** every acceptance check passed. Exit code mirrors the verdict.

## The `coverage-lift` domain (an objective, measured gate)

`doc-draft` gates on structure; **`coverage-lift` gates on a real measurement**. The provider proposes a
Node.js ESM test for a named `target` module; acceptance runs it under `NODE_V8_COVERAGE` and parses V8's own
coverage JSON (**dependency-free -- no c8**), then gates on the target's **function coverage ≥ `minCoverage`**
(an un-exercised module is ~0%, so reaching the floor is the lift). The receipt carries
`coverage { target, funcsPct, coveredFns, totalFns, minCoverage }`.

```jsonc
{ "schema": "labview-benchmark-actor/lba-uplift-task@v1", "domain": "coverage-lift",
  "id": "T-COV-1", "target": "experiments/provider-delegation/fixtures/sample-module.mjs",
  "brief": "Lift coverage of the sample module.", "minCoverage": 80,
  "provider": "ollama", "model": "llama3.1:8b" }
```

**Safety**: measuring executes the proposed test. The deterministic gate runs only trusted, hand-authored
tests; **untrusted provider-proposed tests should be measured inside the disposable cleanroom VM** (the
harness runs identically there), not on a trusted host (`--permission` can't be combined with V8 coverage, so
isolation is by disposable environment).

## Bus-side CLAIM tasking — a host coordinator dispatches, the cleanroom worker claims

The return leg above is fire-and-forget; this closes the loop with a **host coordinator** that dispatches a
task and a **cleanroom worker** that claims and runs it — all over `bus-msg@1` (wire-compatible with
`lbabus net`):

```
host coordinator                          cleanroom worker (VM)
  observer :7420  <────── ACK ───────────  CLAIM received, claimed
        │                                        │ runDelegation (local provider)
        └───── CLAIM uplift:<domain> ────►        │
               payload { taskSpec, replyTo }      ▼
  observer :7420  <────── DONE receipt ────  announce (verdict)
```

The `CLAIM` payload is a dispatch envelope `{ taskSpec, replyTo }` — `replyTo` is the address the worker
uses to reach the coordinator's observer (e.g. the NAT gateway `10.0.2.2` for a VirtualBox guest). The worker
`ACK`s the claim, runs the delegation locally, then announces the `DONE` receipt; the provider never touches
the bus (comms-only).

```sh
# deterministic (loopback, mock): dispatch -> claim -> DONE
node verify-claim-tasking.mjs

# worker on the cleanroom (drives the host Ollama over TCP), coordinator on the host:
#   VM:   OLLAMA_HOST_ADDR=10.0.2.2 OLLAMA_PORT=11533 node worker.mjs --listen 7440 --provider ollama
#   host: node coordinator.mjs --worker 127.0.0.1:7440 --task sample-task.doc-draft.json --reply 10.0.2.2 --observe 7420
```

The worker is a **persistent pool**: `--concurrency N` bounds it to N in-flight delegations; extra concurrent
claims queue FIFO and drain as slots free (the provider calls are I/O-bound, so N async slots is the pool).
`server.poolStats()` exposes `accepted/done/peak/running/queued`. Dispatch several claims at once (one
coordinator each) and the pool runs N, queues the rest:

```sh
node verify-worker-pool.mjs                                       # deterministic: M concurrent claims bounded to N
node worker.mjs --listen 7440 --concurrency 2 --provider ollama   # a persistent 2-slot pool
```

## Run it

```sh
# 1) deterministic gate (no GPU / no network) — the CI-safe proof
node verify-provider-delegation.mjs

# 2) delegate to the LIVE local Ollama, gate the draft, write a receipt + the drafted artifact
node delegateUplift.mjs --task sample-task.doc-draft.json --provider ollama --model llama3.1:8b \
  --out draft.live.md --receipt receipt.live.json

# 3) announce the receipt over the bus to a host observer (distributed CI over TCP)
lbabus net listen --tcp 7420 --count 1 --timeout 60 &          # observer
node delegateUplift.mjs --task sample-task.doc-draft.json --provider mock --announce 127.0.0.1:7420
```

On a clean-room the provider runs **locally** on the VM; only the small **receipt** crosses the bus (the
comms-only invariant — no bulk artifacts on the bus). Point a Copilot CLI / Codex clean-room at the same
task by swapping `--provider` (set `COPILOT_CLI` / `CODEX_CLI` to the binary); the envelope, task-spec, and
receipt are unchanged.

## Proven (this slice)

- **Deterministic gate**: `verify-provider-delegation.mjs` → PASS, 13 assertions (task-spec + mock seam +
  acceptance pass/fail + fail-closed provider error + receipt schema).
- **Live Ollama** (`llama3.1:8b`): the `doc-draft` task produced a coherent 1129-char document with all four
  required sections in ~9.4 s → `verdict=pass`.
- **Bus announce**: the receipt travelled over `lbabus net` as a `DONE task:uplift:doc-draft` frame and was
  received by a real `lbabus net listen` (`received 1 message(s)`).
- **On the actual cleanroom VM, over TCP + UDP** ([vm-run-evidence.json](vm-run-evidence.json)): the harness
  ran on `lba-ubuntu2404-labview2026-scratch` (guest `10.0.2.15`, Node 18) and drove the **host's** Ollama
  over TCP (`10.0.2.2:11533`) → a 1900-char draft, `verdict=pass` → announced the receipt over TCP to a host
  `lbabus net listen` (`DONE task:uplift:doc-draft`, received). Separately the VM beaconed presence over UDP
  (`lbabus net beacon`) → a host `lbabus net listen --udp` (`received 1 message from 1 distinct sender`). The
  provider ran off the VM's network; only the receipt/beacon crossed the bus (comms-only).
- **Bus-side CLAIM tasking, deterministic**: `verify-claim-tasking.mjs` → PASS, 7 assertions (dispatch →
  worker `ACK` → `DONE` receipt over `bus-msg@1`; verdict `pass` for a good task, `fail` for an unmeetable one).
- **Bus-side CLAIM tasking, cross-machine** ([claim-tasking-vm-evidence.json](claim-tasking-vm-evidence.json)):
  the host coordinator dispatched a `CLAIM` to the **VM worker** (`lba-ubuntu-scratch`) over a NAT forward; the
  VM claimed it (`ACK`), ran the delegation against the host Ollama over TCP, and returned `DONE verdict=pass`
  to the host observer — coordinator `claimed=yes verdict=pass`.
- **Worker pool, deterministic**: `verify-worker-pool.mjs` → PASS, 7 assertions — 5 concurrent claims bounded
  to a pool of 2 (peak in-flight provider calls = 2), all returned `DONE`, the pool drained, and it stayed up
  for a further claim (persistent).
- **Worker pool, cross-machine** ([worker-pool-vm-evidence.json](worker-pool-vm-evidence.json)): 3 concurrent
  `CLAIM`s from the host to the VM pool (`--concurrency 2`) — the pool ran 2 and queued the 3rd (`queued=1`
  then `queued=2`, draining to 0); all three returned `verdict=pass`.
- **coverage-lift, deterministic**: `verify-coverage-lift.mjs` → PASS, 8 assertions — a thorough proposed test
  reaches 100% function coverage of the target → `verdict=pass`; a weak test runs but only 40% → `fail`; a
  failing test is rejected (`proposed-test-runs=false`).
- **coverage-lift, live Ollama** ([coverage-lift-evidence.json](coverage-lift-evidence.json)): `llama3.1:8b`
  proposed a test (inspected safe: imports `./target.mjs`, asserts, `exit 0`); the gate measured **100%
  function** coverage of the target → `verdict=pass`.
- **Gated by the authoritative suite**: all four `verify-*.mjs` run as subprocesses under
  `experiments/verify-local-gates.mjs` (76/76 checks pass on the dependency-free gate).

## Reuse map (composes, does not reinvent)

- Transport/framing: `bus-msg@1` + ADR-0003 length-prefixed frames (as in [ollama-drive](../ollama-drive)).
- Provider drive: the `ollama-drive` `/api/generate` contract; the `ollama-comparison` `driveFn(prompt)` seam.
- Domain brief: `lbabus agents --role <domain>` materializes the actor's operating brief on the VM.
- Distribution: `CLAIM`/`ACK`/`HANDOFF`/`DONE` + `lbabus net listen` receipts (as in
  [multi-vm-topology](../multi-vm-topology)).

## Next slices (operator-steerable)

- **Bus-side tasking + worker pool** — ✔ shipped (`coordinator.mjs` + `worker.mjs --concurrency N`, proven
  loopback + cross-machine; see above). Next: multiple coordinators + a claim registry across many cleanrooms.
- **More domains**: `coverage-lift` — ✔ shipped (an objective **measured** gate; `coverageLift.mjs`, proven
  deterministic + live Ollama). Next: `risky-test` (author tests needing real LabVIEW/ffmpeg on the VM),
  `evidence` (gather receipts).
- **Quality eval**: score provider output with the [ollama-comparison](../ollama-comparison) faithfulness
  harness before accepting a draft.
- **Wire into gates**: add `verify-provider-delegation.mjs` to `experiments/verify-local-gates.mjs`.
