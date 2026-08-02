# Cross-Plane Benchmark Grid

> GENERATED -- do not hand-edit. Regenerate with `node experiments/benchmark-grid/generate-benchmark-grid.mjs`; drift + determinism are gated by `cross-plane-benchmark-grid`.

The golden VM exists to run objective, reproducible LabVIEW benchmarks and compare them **across planes** (OS x hardware x LabVIEW version). Each benchmark records a **machine-independent identity** (`resultHash`) -- proof LabVIEW reproduces across planes -- and a **performance** metric (the actual benchmark). Identity must **agree** across planes; performance is expected to differ.

**Grid verdict: OK** -- 2 benchmark(s), 2 cross-plane-proven, 0 determinism violation(s), 4 plane(s). 2 of 2 benchmark(s) cross-plane-proven across 4 plane(s); no determinism violations.

## Cross-plane identity (determinism)

| Benchmark | Planes | Consensus identity | Agree? |
| --- | --- | --- | --- |
| VI Analyzer -- LabVIEWCLIExampleProject | `host`, `vm:lba-ubuntu2404-labview2026-scratch` | `0419a449...` | yes (2/2) |
| Mass Compile -- ni/labview-icon-editor resource/ | `host`, `lba-golden`, `win-VITLT-SERGIO` | `bf722123...` | yes (3/3) |

## Performance (per plane)

| Benchmark | Plane | Metric | Value |
| --- | --- | --- | --- |
| VI Analyzer -- LabVIEWCLIExampleProject | `host` | passedTests | 69 tests |
| VI Analyzer -- LabVIEWCLIExampleProject | `vm:lba-ubuntu2404-labview2026-scratch` | passedTests | 69 tests |
| Mass Compile -- ni/labview-icon-editor resource/ | `host` | compileSeconds | 39 s |
| Mass Compile -- ni/labview-icon-editor resource/ | `lba-golden` | compileSeconds | 24 s |
| Mass Compile -- ni/labview-icon-editor resource/ | `win-VITLT-SERGIO` | compileSeconds | 211 s |

## Sources (committed benchmark receipts)

- `experiments/vi-analyzer/fixtures/cross-plane-comparison-receipt.json`
- `experiments/mass-compile/fixtures/mass-compile-benchmark-receipt.json`
- `experiments/benchmark-grid/fixtures/mass-compile-host.receipt.json`
- `experiments/benchmark-grid/fixtures/mass-compile-win.receipt.json`
