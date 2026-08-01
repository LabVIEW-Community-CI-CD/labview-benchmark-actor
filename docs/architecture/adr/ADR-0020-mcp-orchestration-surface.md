# ADR-0020: MCP orchestration surface for the corroboration grid

- Status: Accepted
- Date: 2026-08-01
- Deciders: LINUX plane (operator-directed)
- Relates to: LBA-REQ-029, ADR-0014 (Actor Corroboration Grid umbrella), ADR-0012 (MCP server agent-tool surface)

## Context

The umbrella ([ADR-0014](ADR-0014-actor-corroboration-grid.md)) wants agents to drive the grid. The repo already
exposes actor tools to agents through a Model Context Protocol server (ADR-0012); the grid extends that surface
rather than adding a second server.

## Decision

- **Extend the ADR-0012 MCP surface** with corroboration-grid tools: `spin_up_witness`, `run_quorum`,
  `get_confidence`, `verify_attestation`, and `teardown`.
- **Design the tool surface now** (this ADR); **implement it in a later phase** alongside the quorum and
  provenance engines.

This is requirement **LBA-REQ-029**.

## Consequences

- An agent can spin up witnesses, run the quorum, read the confidence, and verify attestations through one
  discoverable tool surface.
- Reuses the existing MCP server contract (JSON-RPC over stdio) rather than a new protocol.

## Alternatives considered

- **A dedicated cleanroom MCP server.** Rejected: fragments the agent tool surface; ADR-0012 already defines one.
- **No agent surface (CLI only).** Rejected: the operator wants agent orchestration of the grid.
