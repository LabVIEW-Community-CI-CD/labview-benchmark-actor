# Benchmark Observatory

> GENERATED -- do not hand-edit. Regenerate with `node experiments/benchmark-observatory/generate-benchmark-observatory.mjs`; drift + determinism are gated by `benchmark-observatory`.

The observatory is the suite-wide map above the cross-plane grid: it folds **every** committed benchmark receipt into one **benchmark-type x plane** coverage matrix, keeps the determinism ledger (does a benchmark reproduce its identity across the planes it ran on?), and exposes the empty cells as a data-driven **frontier**. Identity (`resultHash`) must **agree** across planes; performance is expected to differ.

**Observatory verdict: OK** -- 4 benchmark type(s) x 5 plane(s), 7/20 cells measured (35%), 2 cross-plane-proven, 2 pending, 0 violation(s). 4 benchmark type(s) across 5 plane(s); 2 cross-plane-proven, 2 pending, 0 violations; 7/20 cells measured.

## Coverage matrix (benchmark type x plane)

| Benchmark \ Plane | `host`<br>linux/bare-metal | `lba-golden`<br>linux/vm | `linux-container`<br>linux/container | `vm:lba-ubuntu2404-labview2026-scratch`<br>linux/vm | `win-VITLT-SERGIO`<br>windows/physical | Planes |
| --- | --- | --- | --- | --- | --- | --- |
| lunit-test-icon-editor | . | OK 25cases | . | . | . | 1 |
| mass-compile-icon-editor-resource | OK 39s | OK 24s | . | . | OK 211s | 3 |
| ppl-build-icon-editor | . | . | OK 59s | . | . | 1 |
| vi-analyzer-example-project | OK 69tests | . | . | OK 69tests | . | 2 |

## Determinism ledger (cross-plane identity)

| Benchmark | Planes | Consensus identity | Cross-plane? |
| --- | --- | --- | --- |
| LUnit Test -- ni/labview-icon-editor suite | `lba-golden` | `a814e89d...` | pending (1 plane) |
| Mass Compile -- ni/labview-icon-editor resource/ | `host`, `lba-golden`, `win-VITLT-SERGIO` | `bf722123...` | PROVEN (3/3) |
| PPL Build -- ni/labview-icon-editor Editor Packed Library | `linux-container` | `96f353b7...` | pending (1 plane) |
| VI Analyzer -- LabVIEWCLIExampleProject | `host`, `vm:lba-ubuntu2404-labview2026-scratch` | `0419a449...` | PROVEN (2/2) |

## Frontier -- 13 unmeasured cell(s)

The next measurements that would extend the suite. Each is a (benchmark, plane) pair not yet run.

| Benchmark | Plane (unmeasured) |
| --- | --- |
| lunit-test-icon-editor | `host` |
| lunit-test-icon-editor | `linux-container` |
| lunit-test-icon-editor | `vm:lba-ubuntu2404-labview2026-scratch` |
| lunit-test-icon-editor | `win-VITLT-SERGIO` |
| mass-compile-icon-editor-resource | `linux-container` |
| mass-compile-icon-editor-resource | `vm:lba-ubuntu2404-labview2026-scratch` |
| ppl-build-icon-editor | `host` |
| ppl-build-icon-editor | `lba-golden` |
| ppl-build-icon-editor | `vm:lba-ubuntu2404-labview2026-scratch` |
| ppl-build-icon-editor | `win-VITLT-SERGIO` |
| vi-analyzer-example-project | `lba-golden` |
| vi-analyzer-example-project | `linux-container` |
| vi-analyzer-example-project | `win-VITLT-SERGIO` |

## Sources (committed benchmark receipts)

- `experiments/vi-analyzer/fixtures/cross-plane-comparison-receipt.json`
- `experiments/mass-compile/fixtures/mass-compile-benchmark-receipt.json`
- `experiments/benchmark-grid/fixtures/mass-compile-host.receipt.json`
- `experiments/benchmark-grid/fixtures/mass-compile-win.receipt.json`
- `experiments/ppl-build/fixtures/ppl-build-benchmark-receipt.json`
- `experiments/lunit-test/fixtures/lunit-test-benchmark-receipt.json`
