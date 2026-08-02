# ADR-0029: Capability-aware task routing across the distributed instance pool

- Status: Accepted
- Date: 2026-08-02
- Deciders: operator directive (2026-08, "LabVIEW runs on capable instances, non-LabVIEW parts on codespaces") + agent
- Relates to: LBA-REQ-041, ADR-0028 (distributed N-instance workload), ADR-0023 (mesh actors), docs/roadmap.md (North Star cross-plane mesh)

## Context

The distributed executor (ADR-0028) spreads a workload across a heterogeneous
pool, but it assumed every instance could run every task. That is false for the
real cross-plane workload: **LabVIEW lives only on capable instances** — this host
(and, later, LabVIEW VMs) — while codespaces are node-only. A VI task
(`LabVIEWCLI RunVI` / VI Analyzer) sent to a codespace would simply fail. The
operator directed that LabVIEW runs on capable instances and the non-LabVIEW parts
run on codespaces.

## Decision

- **Instances advertise capabilities:** the host advertises `labview` iff
  LabVIEWCLI is installed, plus `node`; a codespace advertises `node` only.
- **Tasks declare required capabilities:** a LabVIEW task requires `labview`; a
  node task requires `node`.
- **`routeByCapability`** groups tasks by their required-capability signature and
  capacity-weight-splits each group (reusing the ADR-0028 partition) across only
  the instances that advertise those capabilities — **throwing if no instance can
  satisfy a required capability** (fail-closed on an impossible routing).
- **Ripgrep-only** on every instance, as in ADR-0028.
- **Fail-closed gate** (`capability-aware-routing`): the committed real receipt
  must validate — every task ran on a capability-matching instance, the re-route
  from the recorded capabilities + weights reproduces the shards, the shards are
  disjoint + cover every task + distinct-instance + ripgrep-only, and every task
  passed.

This is requirement **LBA-REQ-041**.

## Consequences

- The fleet does real cross-plane work correctly: LabVIEW tasks never land on an
  instance that cannot run them, and non-LabVIEW work still spreads across the
  whole pool.
- Proven **live**: a real `LabVIEWCLI RunVI` activation probe routed to the
  LabVIEW-capable host while 43 node self-tests spread across the host + two
  codespaces — all passed concurrently, receipt gated.
- This is the routing substrate for the North Star cross-plane benchmark mesh:
  the next step is a **second LabVIEW-capable instance** (a Windows or Linux VM)
  so LabVIEW tasks themselves distribute across planes for real cross-plane
  comparison.
