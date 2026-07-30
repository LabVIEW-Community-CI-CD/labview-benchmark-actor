# Changelog

All notable changes to the **LabVIEW Benchmark Actor** extension are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Marketplace listing polish: extension icon, gallery banner, keywords, and `Visualization` / `Testing`
  categories.
- Marketplace publish: the `extension-release` workflow now publishes the built `.vsix` to the VS Code
  Marketplace (fork-safe, PAT-gated, fail-open) after the bidirectional WIN&harr;LINUX agreement gate.
- Durable packaging guard (#123): `scripts/check-package-allowlist.mjs` asserts `vsce ls` ships only the
  runtime allow-set (`LICENSE`, `README.md`, `CHANGELOG.md`, `package.json`, `media/**`, `out/**`) and that
  the `.vsix` stays under a 1 MB ceiling in `extension-release`; the local gates additionally assert the heavy
  non-runtime trees (the reviewer VM disk, `node_modules`, `experiments`, `tools`, `docs`, ...) stay
  `.vscodeignore`d — so the 14 GB reviewer-workstation leak class can never regress.

## [0.1.1]

### Added
- **Benchmark viewer** (`LabVIEW Benchmark Actor: Open Benchmark Viewer`) — renders the deterministic
  mprr ring-buffer metric series with a draggable time cursor, in a strict-CSP nonce-scoped webview.
- **Host capabilities** (`Show Host Capabilities`) and the **coordination bus** (`Poll Coordination Bus`,
  `Post Coordination Note`), backed by the `lbabus` CLI.
- **Extension-embedded agent instructions** — `Write` / `Show` / `Check Agent Instructions` materialize and
  drift-check a version-pinned `AGENTS.md` (sha256 over the canonical body).
- Prerequisite remediation surfaced when the `lbabus` coordination CLI is not installed.

### Notes
- The extension depends only on `vscode` + Node built-ins — no `vi-history-suite`-private module on its
  graph (LBA-REQ-001).
