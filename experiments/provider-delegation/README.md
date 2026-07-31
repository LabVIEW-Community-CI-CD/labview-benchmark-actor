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

## Reuse map (composes, does not reinvent)

- Transport/framing: `bus-msg@1` + ADR-0003 length-prefixed frames (as in [ollama-drive](../ollama-drive)).
- Provider drive: the `ollama-drive` `/api/generate` contract; the `ollama-comparison` `driveFn(prompt)` seam.
- Domain brief: `lbabus agents --role <domain>` materializes the actor's operating brief on the VM.
- Distribution: `CLAIM`/`ACK`/`HANDOFF`/`DONE` + `lbabus net listen` receipts (as in
  [multi-vm-topology](../multi-vm-topology)).

## Next slices (operator-steerable)

- **Bus-side tasking**: a coordinator emits `CLAIM task=<domain>` with the task-spec in `payload`; the
  clean-room actor claims it, runs this harness, and returns `DONE` (this slice already ships the return leg).
- **More domains**: `coverage-lift` (propose tests for a named module — gate on measured coverage delta),
  `risky-test` (author tests needing real LabVIEW/ffmpeg on the VM), `evidence` (gather receipts).
- **Quality eval**: score provider output with the [ollama-comparison](../ollama-comparison) faithfulness
  harness before accepting a draft.
- **Wire into gates**: add `verify-provider-delegation.mjs` to `experiments/verify-local-gates.mjs`.
