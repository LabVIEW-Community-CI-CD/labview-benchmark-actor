# ADR-0019: Mesh integration for the corroboration grid

- Status: Accepted
- Date: 2026-08-01
- Deciders: LINUX plane (operator-directed)
- Relates to: LBA-REQ-028, ADR-0014 (Actor Corroboration Grid umbrella), ADR-0003 (coordination-bus wire format)

## Context

The umbrella ([ADR-0014](ADR-0014-actor-corroboration-grid.md)) wants witness verdicts collected without a new
transport. The repo already carries verdicts over the lbabus bus: the gate-suite beacons its verdict when
`LBA_GATE_BEACON_HOSTS` is set, and the cleanroom mesh topology already connects nodes.

## Decision

- **Witnesses join the lbabus mesh** and **beacon their corroboration verdict** over it (reusing the gate-suite
  verdict beacon and the mesh topology), so a UDP observer collects each witness's outcome.
- **A mesh ledger records the beaconed verdicts**, feeding the provenance store (ADR-0016).
- No new transport: the mesh reuses the ADR-0003 coordination-bus wire format.

This is requirement **LBA-REQ-028**.

## Consequences

- The grid's verdicts are observable in real time over the existing bus, not only in after-the-fact receipts.
- Distributed collection composes with the existing multi-node mesh.

## Alternatives considered

- **Collect verdicts only via committed receipts.** Rejected: loses the live, distributed view the bus already
  affords.
- **Add a dedicated verdict transport.** Rejected: violates the bus-carries-comms-only doctrine (LBA-REQ-007).
