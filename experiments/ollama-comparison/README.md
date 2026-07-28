# ollama-comparison (LBA-REQ-010 AC #3)

Deterministic core for the host-side **ollama comparison layer**: over a concentrated corpus (from
`experiments/host-concentration`), plan and drive run-over-run comparisons of an actor's **own** previous
runs to improve the analysis. Runs on the operator host, not inside an actor VM.

## Contract

- `buildComparisonPlan(corpus)` — for each actor, pair its runs consecutively (`previous -> next`) into a
  deterministic comparison plan. **Same-actor pairs only** (LBA-REQ-010 AC #1: no cross-VM comparison); an
  actor with a single run yields no comparison. Each item carries an actor-scoped prompt referencing the two
  runs' `metricsRef` / `framesRef`.
- `compareOverCorpus(corpus, driveFn)` — execute the plan through an **injected** ollama driver: a mock in
  the self-test, the [`ollama-drive`](../ollama-drive/README.md) relay (#22) in production. The driver sees
  **only** the run-derived prompt — never the coordination bus (ADR-0006 / ADR-0008).

## Verify

```
node experiments/ollama-comparison/verify-ollama-comparison.mjs [--json]
```

Runs the dependency-free self-test (no GPU / no live ollama) and writes `receipt.json`. Proves plan
determinism, same-actor pairing (no cross-VM), the output contract, and the comms-only invariant (the driver
only ever sees run-derived prompts). Re-validated by `experiments/verify-local-gates.mjs`.

## Live drive (maintainer)

`drive-ollama-live.mjs` drives the pipeline over a corpus through the **live** ollama HTTP API (needs a real
ollama + GPU; not a CI gate):

```
node experiments/ollama-comparison/drive-ollama-live.mjs [--model llama3.1:8b] [--out <path>]
```

It proves the host-side comparison layer produces a real run-over-run analysis on real hardware (e.g.
`llama3.1:8b` reads a cpu/ram/duration regression and explains it in a few seconds). The output is
non-deterministic **maintainer evidence**, never committed as a gate receipt.

## Scope

The deterministic planning + output contract are proven here (keeps LBA-REQ-010 Partial, alongside the
host-concentration core). The **live** host-side ollama drive over a real multi-VM concentrated corpus — the
concentrated corpus produced once the multi-VM topology (LBA-REQ-006) exports each VM's run data to the host
— is the maintainer/VM step (Partial -> Proven later).
