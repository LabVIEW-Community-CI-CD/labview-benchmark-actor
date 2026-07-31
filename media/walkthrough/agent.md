# Drive it from Copilot agent mode

This extension exposes **language-model tools**, so a **Copilot agent** can drive it straight from a prompt — no menu hunting.

Open Copilot Chat in **Agent** mode and try:

> Use the LabVIEW Benchmark Actor tools: summarize the captured benchmark numbers, then open the benchmark trend and the cross-plane resource agreement panels and explain what each one shows.

The agent will call:

- **`lba-benchmark-summary`** — returns the real numbers (launchMs, the trend verdict, the cross-plane delta, the RAM/CPU/disk deltas), and
- **`lba-open-benchmark-panel`** — opens any panel (`run`, `trend`, `frameCorrelator`, `crossPlaneTrend`, `resourceProfile`, `crossPlaneResource`).

You can also `#`-reference them in a prompt as `#lbaBenchmarkSummary` and `#lbaBenchmarkPanel`.
