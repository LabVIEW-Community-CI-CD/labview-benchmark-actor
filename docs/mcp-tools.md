# labview-benchmark-actor — MCP tools

> GENERATED from the MCP tool registry (`src/mcp/benchmarkActorMcpServer.ts`). Do not hand-edit;
> regenerate with `node scripts/mcpToolDoc.mjs --write docs/mcp-tools.md`. Drift is gated by `npm test`.

The extension contributes a Model Context Protocol server (provider `labviewBenchmarkActor`, server `labview-benchmark-actor`, protocol `2025-06-18`) exposing the following tools to Copilot agent mode. The server is a dependency-free stdio JSON-RPC process launched by the extension; the tools that shell `lbabus` degrade gracefully when the CLI is absent.

## `get_host_capabilities`

Report what the current host can actually run for LabVIEW benchmarking (LabVIEW runtime + bitness, Docker engine, etc.) via the lbabus capabilities probe. Run this before proposing benchmark work.

**Arguments:**

_(no arguments)_

## `get_benchmark_series`

Return the deterministic mprr ring-buffer benchmark metric series the extension's viewer renders, as ordered {t,v} points plus a stable content hash (seriesHash). Reproduce this series; do not re-derive it.

**Arguments:**

_(no arguments)_

## `poll_coordination_bus`

Read the latest cross-plane (WIN <-> LINUX) coordination-bus messages from the live-only lbabus net bus (net poll of the local receive-log). The bus is the authoritative "what is next" channel.

**Arguments:**

- `tail` (integer, optional, range 1..100) — How many of the most recent messages to read (default 10).

## `post_coordination_note`

Post a NOTE to the cross-plane coordination bus over the live-only lbabus net bus (net send).

**Arguments:**

- `message` (string, required) — ASCII coordination note body.

---

## Corroboration grid tools (folded)

The same single server also folds in the Actor Corroboration Grid tools (ADR-0020 / LBA-REQ-029), so an agent can orchestrate release corroboration directly. Signing and recording stay operator/CI steps.

### `spin_up_witness`

Return the provisioning plan for a corroboration-grid witness of a given plane (CODESPACE|VBOX|WIN). Live execution is the operator step.

**Arguments:**

- `plane` (string, required) —

### `run_quorum`

Run the corroboration quorum (ADR-0015) over a set of witness bundles and return the graded-majority verdict.

**Arguments:**

- `bundles` (array, required) —
- `threshold` (number, optional) —

### `get_confidence`

Return just the quorum verdict + graded confidence for a set of witness bundles.

**Arguments:**

- `bundles` (array, required) —
- `threshold` (number, optional) —

### `verify_attestation`

Verify-before-consume (ADR-0016): given attested witnesses + an enrolled allowlist, decide whether the release is consumable.

**Arguments:**

- `witnesses` (array, required) —
- `allowlist` (object, optional) —

### `check_independence`

Assess witness independence (ADR-0017): whether the witnesses span distinct enrolled environments with recorded identities.

**Arguments:**

- `witnesses` (array, required) —
- `enrollment` (object, optional) —

### `assemble_witness`

Assemble a witness bundle (ADR-0014) from its gate/screenshot/capability receipts, failing closed on a missing anchor.

**Arguments:**

- `plane` (string, required) —
- `gate` (object, required) —
- `screenshot` (object, required) —
- `capability` (object, optional) —
- `os` (string, optional) —
- `ubuntu` (string, optional) —

### `verify_inclusion`

Transparency-log inclusion (ADR-0022): verify a witness attestation is included in the Ed25519-signed Merkle transparency log, reconstructing the signed root from the inclusion proof.

**Arguments:**

- `attestation` (object, required) —
- `inclusion` (object, required) —
- `signedTreeHead` (object, required) —
- `logPublicKeyPem` (string, optional) —

### `verify_before_install`

Verify-before-install (ADR-0022, LBA-REQ-031): given a release-provenance bundle, decide whether the release is installable -- at least quorumMin witnesses each enrolled-signed AND included in the signed transparency log.

**Arguments:**

- `provenance` (object, required) —

### `teardown`

Return the teardown plan for a corroboration-grid witness of a given plane. Live execution is the operator step.

**Arguments:**

- `plane` (string, required) —
- `id` (string, optional) —
