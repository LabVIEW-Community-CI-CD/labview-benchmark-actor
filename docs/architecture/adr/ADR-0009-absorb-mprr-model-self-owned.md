# ADR-0009: Absorb the mprr ring-buffer and self-test timing model as self-owned (retire the external `svelderrainruiz/mprr` dependency)

- Status: Accepted
- Owner: WIN
- Traces to: LBA-REQ-003, LBA-REQ-005, LBA-REQ-009
- Supersedes: the "External canonical dependency / reference" framing in
  [ADR-0005](ADR-0005-image-storage-mprr-ringbuffer-cleanroom.md) and
  [ADR-0007](ADR-0007-image-derived-timing-binary-strip.md), and the matching note in
  `docs/requirements/srs.md` / `README.md`
- Standards baseline: `repo-standards-review` v0.2.19

## Context

Earlier ADRs and the SRS framed **mprr** (`svelderrainruiz/mprr`, `develop`) as an
**external canonical dependency**: the authority for the bounded-RAM dual-packet ring
buffer (mprr ADR-0024), the frozen TDMS-compatible `1.0` replay transport, and the
self-test image-derived-timing binary strip (ADR-0007). That framing implied
labview-benchmark-actor tracked an outside repository and pinned its schema.

Under operator direction ("absorb mprr … so any of you can leverage deterministic
screenshots to compare both results"), the essential IP was already brought in-repo as
**faithful, dependency-free ESM mirrors** under `experiments/mprr-ring/`:

- `mprrRing.mjs` — the Windows zero-copy rolling-block short-packet ring
  (`labview-benchmark-actor/mprr-short-ring@v1`), preallocated buffer + split-copy on
  wrap, 100 ns `timingTicks64` authority (MPRR-REQ-094 / 104–119).
- `mprrDualPacket.mjs` — dual-packet correlation + degradation model.
- `mprrPacketHarness.mjs` — packet-harness rate profiles (MPRR-REQ-115–119).
- `mprrViewerSeries.mjs` — projection into the shipped viewer series.

The self-test image-fidelity leg (ADR-0007) likewise decodes the `mprr-binary-strip-v1`
strip by pixel intensity in pure Node. All of this is exercised in-repo and gated by
`experiments/verify-local-gates.mjs` (ring, packet-harness, dual-packet, viewer-series).

`mprr` is therefore no longer an outside contract this package consumes — it is a
**local model** whose name is retained for continuity.

## Decision

**labview-benchmark-actor owns the mprr ring-buffer and self-test timing model in-repo.**
The external `svelderrainruiz/mprr` pointer is retired from the normative dependency
framing (README, SRS, ADR-0005, ADR-0007, DOCS).

1. **Keep the `mprr` name** as the local model/name; retain existing schema identifiers
   (`labview-benchmark-actor/mprr-short-ring@v1`, `mprr-binary-strip-v1`,
   `mprr-self-test-*`) unchanged — they are the absorbed model's own IDs, not a pointer
   outward.
2. **Preserve historical lineage as "why", not as a tracked external contract.** mprr
   ADR-0024 (dual-packet policy), the frozen TDMS-compatible `1.0` transport, and the
   `MPRR-REQ-*` numbers are cited as design provenance in the absorbed sources.
3. **De-brand the absorbed material** of `vi-history-suite` (VIHS) branding: the
   developer-convenience env var `VIHS_MPRR_ROOT` → `LBA_MPRR_ROOT` (and
   `VIHS_CONFORMANCE_OUT` → `LBA_CONFORMANCE_OUT`), each with a back-compatible fallback
   to the old name. A local mprr checkout is only a developer convenience for the two
   Windows-only de-risk experiments (`ocr-primitive-proof`, `self-test-conformance`), not
   a build- or run-time dependency of the extension.
4. **The coordination-bus wire schema is out of scope.** `vihs-collab-msg@v1` and the
   `VIHS_COLLAB_*` config are a separate, live protocol contract (ADR-0003, LBA-REQ-013)
   pinned by CI fixtures and both running planes; they are intentionally **unchanged**.

## Consequences

- **Self-contained.** The extension carries no external mprr build/run dependency; the
  ring and timing model are testable purely in-repo and their cross-plane determinism
  keys are computed from in-repo code.
- **No schema churn.** Retaining the `mprr` names keeps every existing fixture, receipt,
  and gate valid; this ADR is a framing/ownership change, not a rename.
- **Lineage retained.** The mprr provenance (ADR-0024, TDMS `1.0`, MPRR-REQ-*) remains as
  cited design history so the "why" is not lost.
- **Bounded de-brand.** Only absorbed mprr material is de-branded; the bus protocol
  contract is deliberately untouched, so no cross-plane protocol coordination or version
  bump is triggered by this change.
- **Follow-up:** the version-pinned `tools/collab-cli/docs/DOCS.md` note that lists `mprr`
  as an external local source reference is corrected here; it re-embeds on the next
  `collab-cli` docs release.
