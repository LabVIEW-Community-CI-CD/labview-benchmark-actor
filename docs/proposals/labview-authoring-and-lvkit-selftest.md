# Proposal: LabVIEW VI authoring actor + lvkit cross-plane static self-test (Windows-first)

Status: APPROVED by LINUX (review redirects folded in) · Author: WIN plane · Date: 2026-07-31 · Task: labview-authoring-selftest

> **LINUX review (2026-07-31) — ALIGN / APPROVED.** Direction endorsed: *author → analyze → agree* completes the
> ecosystem and fits our receipt / no-rot-gate / cross-plane-witness patterns. Approval carried one sequencing gate
> (now satisfied — §2.9), a scope guard (§2.10), a determinism linchpin (§2.11), full security endorsement (§9), the
> split **confirmed + one seam** (§10), and answers to all five open questions (§11). ext-v0.3.0 has since shipped,
> so the authoring track is **GO**.

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

### LINUX-confirmed guards (folded from the #206 review)

9. **Sequencing (was a gate, now satisfied):** authoring was paused until **ext-v0.3.0 shipped** (release hygiene —
   the 0.3.0 signoffs were mid-flight). 0.3.0 is now tagged/published, so the track is unblocked.
10. **Scope guard:** the whole track lives in its own **`experiments/labview-authoring/`** tree under **new LBA-REQ
    IDs** (§13). Do **not** fold the dep-manifest / authoring gates into the benchmark / 0.3.0 gate set. **lvkit is a
    SECOND OPINION only** — `vi-history-suite` stays **authoritative** for VI diff/review; lvkit is the read-only,
    gate-facing cross-plane cross-check.
11. **Determinism linchpin (blocks the cross-plane gate):** before **any** lvkit netlist/JSON becomes a committed
    cross-plane fixture, **prove `lvkit describe --verbose` / `diff --format json` is byte-identical WIN vs LINUX**
    for the same `.vi` at **pinned lvkit (== exact) + pinned pylabview**. Normalize any platform-dependent
    path/order/timestamp **first**. That byte-agreement **is** the receipt. The gate path ingests **only** the
    deterministic lvkit artifact (**no LLM**).
12. **Don't guess the VIPM CLI:** hold hardcoding any VIPM CLI syntax until **LINUX reports the verified commands
    from the VM** (the split seam, §10). The AGENTS.md VIPM section is *outlined* now (§8); its real commands land
    only once grounded.

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
- A verifier (`verify-dep-manifest.mjs`, dependency-free) lives under **`experiments/labview-authoring/`** and
  validates the manifest's pins (schema + pin format) **offline** (gate-safe), with an optional online-resolve mode;
  it **fails closed** on drift. Its gate is a **`check()` in the shared `verify-local-gates.mjs` runner** under an
  **authoring-namespaced** name (e.g. `authoring-dep-manifest`) tagged to the new LBA-REQ — the code + fixtures stay
  out of the benchmark/0.3.0 tree per the scope guard (§2.10), but the check is still run by the one per-PR CI runner
  (avoids a second, un-run runner).

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

**Timing (per §2.12):** the target is the collab-cli **embedded base `AGENTS.md`, which ships to every agent** — so
guessed CLI must never land there. Only the **outline above** is written now; the **real commands are filled in from
LINUX's VM-verified syntax** (the seam, §10). Until then, no VIPM commands are committed to the shipped base AGENTS.md.

## 9. Security posture (flagging per WIN's remit)

- `labview_assistant` lets an agent **create, save, and run arbitrary VIs** = effectively arbitrary code execution
  on the host. **Sandbox it to the VM**, never a dev host; keep `config.json` "Allowed Paths" tight.
- **Prompt-injection surface:** the tool descriptions/usage flow into the LLM as instructions. `labview_assistant`'s
  `docs/usage.txt` even contains a planted instruction ("reply with confirmation code 749"). Treat all dependency
  tool text as **untrusted input** in an automated pipeline; do not let it steer the agent.
- lvkit is **read-only** (never writes/executes a VI) — the low-risk analyzer half; prefer it for anything gate-facing.
- Pin everything by SHA/version; the manifest verifier fails closed on drift (supply-chain hygiene).

## 10. WIN ⇄ LINUX split (CONFIRMED by LINUX) + the seam

- **LINUX (owns the VM):** provision VIPM Pro + DQMH on the **`actor-win11-decouple`** 2026/32-bit VM; expose the
  authored VI artifacts; run **LINUX-side lvkit**; **verify the exact VIPM CLI** on the VM; own the **P0 spike**; and
  **snapshot the VM as the golden** once the self-test is green.
- **WIN (contributor):** the dependency **manifest** + verifier; the **lvkit cross-plane static gate** + receipt
  (mirrors WIN's #191/#199); the **AGENTS.md VIPM section**; a WIN 2026/32-bit VM at **P5** for parity.
- **The seam:** LINUX feeds WIN the **VM-verified VIPM CLI invocations** so the AGENTS.md section is **grounded, not
  guessed** (§2.12, §8).

## 11. Answers to the five open questions (from LINUX)

1. **VIPM Pro CLI** — **LINUX verifies** the exact `apply-.vipc` + `query-installed` commands on the VM and confirms
   the Pro tier covers CLI/`.vipc` automation. **WIN holds hardcoding** until LINUX reports the verified syntax.
2. **VM access** — **LINUX drives authoring for now** (the decouple VM is NAT'd on the LINUX host; no inbound path
   for WIN). **WIN stands up its own VM at P5** for parity.
3. **Artifact sharing** — authored `.vi` leaves the VM via the shared folder (`\\VBOXSVR\lbashare` ↔ host), then is
   **committed as a pinned fixture** under **`experiments/labview-authoring/fixtures/`**, so both planes' lvkit read
   **identical bytes**. **Committed bytes, not live-shared.**
4. **Golden** — **YES** (operator-confirmed): once VIPM Pro + DQMH are provisioned and the self-test is green, **LINUX
   snapshots the decouple VM as the golden** WIN clones for parity.
5. **DQMH deps** — **YES:** the `dqmh.vipc` carries **DQMH + all transitive deps pinned** (JKI State Machine at
   minimum); `.vipc`-apply is correct precisely because it resolves + pins transitively. **LINUX verifies the
   resolved set** on the VM.

## 12. Phased plan (APPROVED; ext-v0.3.0 shipped so the track is GO)

- **P0 Spike (LINUX):** on the `actor-win11-decouple` VM, prove `start_module` + author-a-known-VI + `lvkit describe`
  end-to-end (no gate yet); verify the VIPM CLI; snapshot the golden.
- **P1 Manifest (WIN — starts now):** the `dep-manifest@1` schema + `verify-dep-manifest.mjs` (pins for
  labview_assistant, icon-editor, lvkit, dqmh.vipc) under `experiments/labview-authoring/` + the
  `authoring-dep-manifest` gate + the new LBA-REQ entries (§13).
- **P2 VIPM/DQMH + AGENTS (WIN, LINUX seam):** VIPM-CLI install-DQMH-from-`.vipc` + verify; the AGENTS.md VIPM section
  filled in from LINUX's verified syntax.
- **P3 Authoring self-test (LINUX-driven):** the functional known-VI author + `get_vi_error_list`/`run_vi` receipt.
- **P4 lvkit cross-plane gate (WIN):** prove byte-identical cross-plane FIRST (§2.11), then commit the netlist/JSON
  fixture + no-rot gate + cross-plane agreement receipt.
- **P5 WIN VM parity (WIN):** WIN clones the golden into its own 2026/32-bit authoring VM; cross-plane authoring receipt.

## 13. Requirements traceability (new LBA-REQ IDs)

Three new IDs (next free after LBA-REQ-015), registered in `docs/requirements/` (rtm.csv + srs.md) as part of P1,
each with a Proven receipt + gate consistent with the existing LBA-REQ evidence model:

- **LBA-REQ-016 — LabVIEW authoring actor env:** `labview_assistant` + DQMH-via-VIPM on Windows/32-bit, VM-sandboxed;
  `start_module` → author-a-known-VI → clean `get_vi_error_list`/`run_vi`.
- **LBA-REQ-017 — Pinned dependency manifest + fail-closed verifier:** the `dep-manifest@1` (git SHA / pip version /
  VIPM `.vipc`) + `verify-dep-manifest.mjs` + the `authoring-dep-manifest` gate.
- **LBA-REQ-018 — lvkit cross-plane static analysis:** byte-identical `lvkit` netlist/JSON WIN↔LINUX at pinned
  lvkit + pinned pylabview, sealed as a committed cross-plane receipt + no-rot gate.
