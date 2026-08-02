# ADR-0011: AI-provider uplift is delegated to cleanroom actors over the coordination bus

- Status: Accepted
- Date: 2026-08-01
- Deciders: LINUX + WIN planes (operator-directed)
- Relates to: LBA-REQ-018, ADR-0003 (coordination-bus wire format), ADR-0006 (run concentration + ollama), `experiments/provider-delegation/`

## Context

The operator approved *"use a provider like Copilot CLI, Codex, or Ollama on cleanrooms to delegate specific
uplift domains and documentation drafting."* The benchmark actor already owns a coordination bus (ADR-0003
`bus-msg@1` envelope over `lbabus` TCP/UDP), an `ollama-drive` HTTP contract, and an `ollama-comparison`
`driveFn(prompt)` seam, and it distributes capability across cleanroom actors (LBA-REQ-006). The open question
is *where* AI providers run: on the host pushing work down to cleanrooms, or inside the cleanroom actors with
the host observing gated outcomes.

## Decision

Delegate uplift and documentation-drafting tasks to AI providers running **inside cleanroom actors**, gate the
result **deterministically**, and announce the receipt over the **existing** coordination bus:

- A provider-agnostic adapter seam (`providerAdapters.mjs`, `drive(prompt) -> { provider, model, text, ms, ok }`)
  fronts `ollama` / `copilot-cli` / `codex` / a deterministic `mock`, so no requirement is tied to one provider.
- The delegation unit (`delegateUplift.mjs`) validates an `lba-uplift-task@v1` spec, builds the prompt from the
  `agents --role` domain brief, drives the provider, applies a deterministic acceptance gate, writes an
  `lba-uplift-delegation-receipt@v1`, and optionally announces it as an ADR-0003 `DONE` frame.
- A registry/router dispatches a `CLAIM` only to a live, capability-matched worker; a persistent worker pool
  bounds concurrency; each uplift domain (coverage-lift, evidence, risky-test, VIPM credential + routing) gates
  its result fail-closed.
- The harness **invents no new transport or protocol**: it composes the ADR-0003 envelope, the `ollama-drive`
  contract, and the `ollama-comparison` seam.

## Consequences

- Uplift work runs where the licensed tooling and capability differentiation live (the cleanroom); the host only
  observes gated receipts over the bus, so no provider runs on the host and no run data crosses the bus beyond
  the receipt envelope.
- Provider-agnosticism keeps LBA-REQ-018 stable as providers change.
- The whole harness is deterministically self-testable offline through the mock adapter (no GPU / no network),
  so it gates in `verify-local-gates`.

## Alternatives considered

- **Run providers on the host and push results to cleanrooms.** Rejected: the licensed LabVIEW/VIPM tooling and
  the cleanroom capability differentiation live in the cleanrooms; hosting providers centrally loses that.
- **Invent a dedicated provider-tasking protocol.** Rejected: the ADR-0003 bus plus the `ollama-drive` contract
  already carry CLAIM/ACK/DONE and provider I/O; a new protocol would duplicate proven infrastructure.
