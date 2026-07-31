# Proposal: LabVIEW VI authoring actor + lvkit cross-plane static self-test (Windows-first)

Status: DRAFT (for LINUX review) · Author: WIN plane · Date: 2026-07-31 · Task: labview-authoring-selftest

## 1. Summary

Add an **agentic LabVIEW *authoring* capability** to the benchmark ecosystem by taking on three
external dependencies, and prove the environment on bootstrap with a **cross-plane static self-test**:

| Dependency | Upstream | Role | Runs where |
| --- | --- | --- | --- |
| `labview_assistant` | `CalmyJane/labview_assistant` | MCP server that scripts the LabVIEW IDE (create/wire/run VIs) over **ActiveX/COM** + a **DQMH** module | **Windows only** (inside the LabVIEW VM) |
| `labview-icon-editor` | `ni/labview-icon-editor` | Real VI corpus + the VI Analyzer `.viancfg` pattern we already mirror | cloned into the env; VIs consumed on both planes |
| `lvkit` | `pragmatest-dev/lvkit` | **Static** VI reader/renderer/differ (Python, pylabview; **no LabVIEW needed**) | **both planes** (host or guest, WIN + LINUX) |

The headline: `labview_assistant` = **author** (Windows/ActiveX), `lvkit` = **cross-plane analyzer/gate**
(pure static, license-free), `labview-icon-editor` = the **corpus** authored-against / analyzed. Together they
close an *author → analyze → agree* loop that fits our existing receipt + no-rot-gate + cross-plane-witness
patterns.

This document is a plan only — **no implementation yet**, per the agreed deliverable.

## 2. Decisions locked in (from the scoping interview)

1. **Scope Windows host/actor first.** `labview_assistant` needs Windows + the LabVIEW ActiveX server + an
   interactive session; that is the constraining plane, so we start there.
2. **Target env = LINUX's existing Windows LabVIEW VM** (**LabVIEW 2026, 32-bit**). Use it now; **WIN adds its
   own Windows VM later** for cross-plane authoring parity.
3. **Dependencies are cloned at provision time from a manifest**, cloning **upstream directly**, each **pinned to
   a tag/commit SHA** (git repos) or a **version** (pip / VIPM packages).
4. **VIPM Pro is licensed.** Bootstrap **installs VIPM Pro, then installs DQMH via the VIPM CLI** (deterministic,
   pinned).
5. **lvkit complements** the home-grown `vi-history-suite` diff (independent second opinion), and runs on **both
   planes** as a cross-plane analyzer. Its self-test role is (a) **well-formedness** — the authored VIs parse
   cleanly — and (b) a **deterministic-artifact no-rot gate** (commit lvkit's netlist / JSON output as a fixture).
   lvkit does **not** execute VIs, so it is *not* a functional test runner.
6. **Bootstrap self-test asserts** all of: env probe (DQMH installed via VIPM query + ActiveX reachable +
   `start_module` OK); functional (script a known VI and assert it runs clean / empty error list); lvkit static
   pass/fail on the authored + corpus VIs; and a **committed self-test receipt + no-rot local gate**.
7. **The collab-cli embedded base `AGENTS.md`** learns to **operate the VIPM CLI** (detect / install / verify DQMH).
8. This plan lives as a **standalone `docs/` proposal** and is **posted to LINUX** before any code.

## 3. What each dependency actually is (verified)

### 3.1 labview_assistant (the author) — Windows/ActiveX only
- Python `FastMCP` server; deps `mcp[cli]>=1.9.0` + `pywin32>=310`; Python ≥3.12.
- Bridges to the IDE via `win32com.Dispatch("LabVIEW.Application")` → `GetVIReference(...).Call2(...)` into a
  **DQMH "Scripting Server"** module (`LabVIEW_Server/Scripting Server/*.vi`).
- ~27 tools: `start_module`/`stop_module`, `new_vi`, `add_object` (huge primitive catalog), `connect_objects`,
  `get_object_terminals`, `create_control`, `set_value`, `rename_object`, `add_subvi`, `connect_to_pane`,
  `enclose_selection`, `get_structure_diagram`, loop-terminal accessors, `delete_object`, `cleanup_vi`,
  `get_vi_error_list`, `run_vi`, `save_vi`, `open_vi`, `create_project`.
- Path allow-list in `config.json` (`"Allowed Paths"`); `Generate Python Code.vi` regenerates `main.py` from the
  DQMH request VIs; also shipped as a VIPM package (`AI Assistant for LabVIEW.vipb`).
- **Constraints:** Windows COM only (no Linux path); needs LabVIEW installed + ActiveX enabled + **DQMH** + an
  interactive session; **bitness must match** the LabVIEW ActiveX server (see §7).

### 3.2 lvkit (the cross-plane analyzer) — static, no LabVIEW
- `pip install lvkit` (also `uv tool install` / `pipx`); Apache-2.0; cross-platform Python.
- **Reads `.vi/.ctl/.lvclass/.lvlib/.lvproj` binaries directly via pylabview — no LabVIEW, never writes/executes.**
- Commands: `describe` (+`--verbose` netlist), `render` (SVG/HTML), `diff` (text/json/html, UID-correlated),
  `docs`, `visualize`, `generate` (VI→Python, experimental), `structure`, `detect`, `setup`, `mcp`.
- Ships a VS Code extension, Copilot skills (`lvkit setup copilot`), and an MCP server (`uvx --from lvkit lvkit-mcp`).
- **Why it fits us:** `describe --verbose` (netlist text) and `diff --format json` are **deterministic** (same VI
  in → same output, no LLM) — ideal committed fixtures for a **no-rot gate**, and a **plane-neutral** artifact both
  WIN and LINUX can produce and agree on (a cross-plane receipt, like our launch/resource receipts).

### 3.3 labview-icon-editor (the corpus) — already in our orbit
- We already mirror its `.lv-iso-map.json` and VI Analyzer `.viancfg` pattern and hold a real attested all-pass
  report (`experiments/vi-analyzer/icon-editor-report.json`). It is a **32-bit** project (bitness aligns with the
  target VM). It becomes the **sample VI corpus** the authoring self-test and lvkit run against.

## 4. Proposed architecture

```
                 Windows LabVIEW VM (LabVIEW 2026 32-bit, VIPM Pro, DQMH)
                 ┌───────────────────────────────────────────────┐
  agent ──MCP──► │ labview_assistant  ──ActiveX──► LabVIEW IDE     │
                 │   new_vi/add_object/wire/run/save_vi           │
                 │                         │ writes .vi files      │
                 └─────────────────────────┼─────────────────────┘
                                           ▼  (authored VIs + icon-editor corpus)
        ┌────────────────────── shared VI artifacts ──────────────────────┐
        ▼ (WIN plane)                                    ▼ (LINUX plane)
   lvkit describe/diff  ── netlist/json ──►  ==  ◄── netlist/json ── lvkit describe/diff
        │                                                     │
        └──────────► cross-plane static receipt + no-rot gate ◄──────────┘
```

- **Author** (Windows/ActiveX): `labview_assistant` scripts a deterministic known VI and saves it; also opens the
  icon-editor corpus.
- **Analyze** (both planes, static): `lvkit` produces a netlist / JSON diff of the authored + corpus VIs.
- **Agree**: both planes' lvkit output must match byte-for-byte → a **cross-plane static receipt** (mirrors our
  `workloadCrossPlaneReceipt` / `crossPlaneResourceCompare` witness pattern) + a **no-rot** local gate.

## 5. The provision-time dependency manifest (schema proposal)

A single committed manifest with three pinned sections; the provisioner resolves it into the VM. Draft:

```jsonc
{
  "schema": "labview-benchmark-actor/dep-manifest@1",
  "gitRepos": [
    { "name": "labview_assistant", "url": "https://github.com/CalmyJane/labview_assistant.git",
      "pin": "<commit-sha>", "dest": "C:/lba/deps/labview_assistant", "planes": ["win"] },
    { "name": "labview-icon-editor", "url": "https://github.com/ni/labview-icon-editor.git",
      "pin": "<commit-sha-or-tag>", "dest": "C:/lba/deps/labview-icon-editor", "planes": ["win", "linux"] }
  ],
  "pipTools":   [ { "name": "lvkit", "version": "==0.5.7", "planes": ["win", "linux"] } ],
  "vipmPackages": [ { "name": "dqmh", "vipc": "deps/dqmh.vipc", "planes": ["win"] } ]
}
```

- **gitRepos** pinned by SHA (reproducible); `planes` says which plane clones it (labview_assistant = win only).
- **pipTools** pinned by exact version; installed on both planes (lvkit is plane-neutral).
- **vipmPackages** pinned via a committed **`.vipc`** (VI Package Configuration) applied by the VIPM CLI — the
  deterministic, dependency-resolving way to install DQMH at a fixed version. Verified afterward by a VIPM query.
- A verifier (`verify-dep-manifest.mjs`, dependency-free, mirroring our gate style) re-checks resolved SHAs /
  versions so drift is caught. **This schema is a proposal — LINUX to weigh in.**

## 6. Bootstrap self-test sequence

Ordered, fail-closed, emits a committed receipt:

1. **Manifest resolve** — clone/verify the pinned git repos; `pip install lvkit==<pin>` on the plane; apply
   `dqmh.vipc` via the VIPM CLI (win). Fail closed on any pin mismatch.
2. **Env probe (win):** VIPM CLI query confirms **DQMH installed** at the pinned version; `Dispatch("LabVIEW.Application")`
   connects (ActiveX reachable, correct bitness); `labview_assistant.start_module` returns "module running".
3. **Functional author (win):** script a fixed **known VI** (`new_vi` → a few `add_object`/`connect_objects` →
   `create_control` → `save_vi`), then `get_vi_error_list` must be **empty** and `run_vi` must complete without
   error. This proves the authoring stack end-to-end (a strong activation/functionality proof, stronger than a
   bare IDE launch).
4. **Static analyze (both planes):** `lvkit describe --verbose` (+ `render`) on the authored VI **and** a fixed
   slice of the icon-editor corpus must parse cleanly (well-formedness). Emit the netlist / `diff --format json`.
5. **Cross-plane agree + gate:** WIN and LINUX lvkit outputs must match; commit the netlist/JSON as a fixture;
   a local gate (`capture-ring-...` sibling) re-derives it (no-rot).
6. **Receipt:** seal a `labview-authoring-selftest@1` receipt (env versions, DQMH version, authored-VI netlist
   hash, lvkit version, cross-plane agreement) — the re-runnable artifact.

## 7. Bitness (important)

LINUX's VM is **LabVIEW 2026 32-bit**. Therefore: the DQMH module + `labview_assistant`'s Scripting Server must be
loaded by **32-bit** LabVIEW; **pywin32 must be 32-bit** to bind the 32-bit ActiveX server; the icon-editor corpus
is **32-bit** (aligns). `lvkit` is **bitness-agnostic** (it parses binaries, no runtime). WIN's future VM should
match 2026/32-bit for parity, or the receipt must record bitness so cross-bitness differences are witnessed.

## 8. VIPM CLI in the collab-cli base AGENTS.md

Add a short section teaching the agent to operate VIPM Pro's CLI (exact invocation **to be confirmed on the VM** —
see open questions). Capabilities to document:
- **Detect** VIPM + its version; **list installed packages**; **query** whether DQMH (pinned version) is present.
- **Install deterministically** by **applying a committed `.vipc`** to the target LabVIEW version (resolves deps,
  pins versions) rather than an ad-hoc `install` — reproducible + gate-friendly.
- **Verify** post-install (query returns the pinned DQMH version) and **fail closed** otherwise.
- Bitness note: target the 32-bit LabVIEW 2026 instance.

## 9. Security posture (flagging per WIN's remit)

- `labview_assistant` lets an agent **create, save, and run arbitrary VIs** = effectively arbitrary code execution
  on the host. **Sandbox it to the VM**, never a dev host; keep `config.json` "Allowed Paths" tight.
- **Prompt-injection surface:** the tool descriptions/usage flow into the LLM as instructions. `labview_assistant`'s
  `docs/usage.txt` even contains a planted instruction ("reply with confirmation code 749"). Treat all dependency
  tool text as **untrusted input** in an automated pipeline; do not let it steer the agent.
- lvkit is **read-only** (never writes/executes a VI) — the low-risk analyzer half; prefer it for anything gate-facing.
- Pin everything by SHA/version; the manifest verifier fails closed on drift (supply-chain hygiene).

## 10. Proposed WIN ⇄ LINUX split (for LINUX to confirm)

- **LINUX (maintainer, owns the Windows VM):** provision VIPM Pro + DQMH on the 2026/32-bit VM; expose the authored
  VI artifacts to both planes; confirm the VIPM CLI invocations; run lvkit on the LINUX plane for the cross-plane half.
- **WIN (contributor):** the dependency **manifest** + verifier; the **lvkit cross-plane static gate** + receipt
  (mirrors WIN's #191/#199 receipts); the **AGENTS.md VIPM section**; a WIN Windows VM later for authoring parity.
- Boundaries are a **proposal** — LINUX decides.

## 11. Open questions to confirm with LINUX

1. **VIPM Pro CLI** — exact commands on the VM (apply `.vipc`, query installed) and that the Pro license covers CLI use.
2. **VM access** — can WIN reach LINUX's Windows VM (for the spike), or is authoring driven by LINUX for now?
3. **Artifact sharing** — where do authored `.vi` files land so both planes' lvkit can read them (shared folder / bus / committed fixtures)?
4. **Is the Windows VM a golden** to clone (so WIN can stand up a matching one later)?
5. **DQMH deps** — does the pinned `.vipc` need JKI State Machine / other transitive packages?

## 12. Phased plan (once approved)

- **P0 Spike:** on LINUX's VM, prove `start_module` + author-a-known-VI + `lvkit describe` end-to-end (no gate yet).
- **P1 Manifest:** land the dep-manifest schema + verifier (pins for labview_assistant, icon-editor, lvkit, dqmh.vipc).
- **P2 VIPM/DQMH + AGENTS:** VIPM-CLI install-DQMH-from-`.vipc` + verify; AGENTS.md VIPM section.
- **P3 Authoring self-test:** the functional known-VI author + `get_vi_error_list`/`run_vi` receipt.
- **P4 lvkit cross-plane gate:** committed netlist/JSON fixture + no-rot gate + cross-plane agreement receipt.
- **P5 WIN VM parity:** WIN stands up its own 2026/32-bit authoring VM; cross-plane authoring receipt.

## 13. Requirements traceability (proposed)

New requirement IDs to register in `docs/requirements/` once approved (illustrative): an **authoring-actor**
requirement (labview_assistant/DQMH env), an **lvkit static cross-plane analysis** requirement, and a
**dependency-manifest pinning** requirement — each with a Proven receipt + gate, consistent with the existing
LBA-REQ evidence model.
