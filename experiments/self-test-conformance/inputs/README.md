# Canonical shared self-test-conformance inputs

These three files are the **byte-identical shared inputs** both planes bind for
the mprr self-test transport-conformance run. The WIN plane authors + commits
them here; the LINUX golden-VM binds these exact committed bytes (no divergent
hand-authoring) so the conformance comparison is grounded in one pinned corpus.

## Files (committed, byte-identical across planes)

| File | Schema | Role |
| --- | --- | --- |
| `ground-truth-ledger.json` | `mprr-self-test-ground-truth-ledger-v1` | Timing/event authority. Comparator reads `timingAuthority.tickIntervalMilliseconds` (=10). |
| `surface-metadata.json` | `mprr-self-test-surface-v1` | Surface descriptor. `groundTruthLedgerPath` is **relative** (`ground-truth-ledger.json`) so the bytes are portable. |
| `operator-events.jsonl` | `windows-host-operator-event-v1` | The 3 operator events the recorder replays (cursor-sample@100, click@120, keyboard@150). |

## Generated per-run (NOT committed)

`image-derived-timing.json`, `fixture-manifest.json`, and `capture-bus.jsonl`
are produced by each capture/recorder run on the golden VM (the image-derived
timing is the only Windows-bound leg). The comparator consumes the committed
three inputs above plus the golden-VM-generated three.

## Provenance

Shapes are the contract-(a) TEST fixture from mprr
`tests/unit/runReviewCaptureSelfTestTransportConformanceScript.test.ts`, which
yields `authoritativeOutcome: authoritative`.

## Dependency

`surface-metadata.json` uses a **relative** `groundTruthLedgerPath`. This
requires the mprr comparator to resolve it against the surface-metadata
directory before its equality check — landed in mprr MR
`fix/absolute-path-portability-determinism`
(https://gitlab.com/svelderrainruiz/mprr/-/merge_requests/137). Before that MR
lands, the comparator's absolute-path equality would reject a relative
reference. The same MR also adds `portableActionDigestSha256` (an
output-dir-independent cross-plane determinism key) to the synthetic replay
proof.
