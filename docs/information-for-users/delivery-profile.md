# Delivery Profile

> How this project delivers information to users. Aligns to **ISO/IEC/IEEE
> 26514:2022 §5** (delivery + presentation) and records the delivery decisions
> the [Audience and Task Model](./audience-and-task-model.md) drives.

## Delivery mechanisms

| Mechanism | What it delivers | Audience | Notes |
| --- | --- | --- | --- |
| **In-editor webviews** | Benchmark run / trend / frame correlator / resource / cross-plane / mesh-stress views | LabVIEW community member | Strict-CSP, nonce-scoped or script-free; no network, no eval. Opened via the [Command Reference](./command-reference.md) commands. |
| **Command Palette** | Every contributed command | member, maintainer | Titles prefixed **LabVIEW Benchmark Actor:**. |
| **Marketplace listing (README)** | Orientation + capabilities | first-time member, engineering leader | Marketplace-safe links only (repo-relative links 404 there and are gate-blocked). |
| **Repository docs (`docs/`)** | This information-for-users set + governed route docs | all | Repo-relative Markdown; a lychee link-check runs in CI. |
| **MCP server + language-model tools** | The actor's tools + panel-open tool | autonomous AI agent | The primary surface for agent operation; see [`AGENTS.md`](../../extension-agents/AGENTS.md). |
| **Embedded `AGENTS.md`** | Agent operating instructions, integrity-checked | agent, maintainer | Materialized / verified via the agent-instruction commands. |

## Presentation decisions

- **Task-first:** [Getting Started](./getting-started.md) leads with tasks, not
  architecture.
- **Compact reference:** the [Command Reference](./command-reference.md) and
  [Glossary](./glossary.md) stay scannable; depth lives in the User Guide + route
  docs.
- **Accessibility:** webviews use VS Code theme variables (honoring the user's
  theme/contrast) and semantic SVG `role="img"` / `aria-label`s; information is
  never conveyed by color alone (stress bars carry numeric labels, badges carry
  ✓/✗ glyphs).
- **Findability:** the [Navigation and Search](./navigation-and-search.md) hub
  indexes the set and every page cross-links its related surfaces.

## Out of scope (see the [Conformance Boundary](./conformance-boundary.md))

Printed manuals, translated deliverables, rich media, and voice/chatbot surfaces
are outside the current delivery model.
