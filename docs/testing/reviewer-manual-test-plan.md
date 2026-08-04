# Expert reviewer manual test plan — `labview-benchmark-actor` extension + AGENTS.md

Tracking: #108 · Coordination: WIN ↔ LINUX bus (Discussion #1).

This is the checklist an **expert human reviewer** follows to manually validate the
`labview-benchmark-actor` VS Code extension and its embedded AGENTS.md, running inside a
Windows 11 reviewer VM. It covers every command the extension contributes plus a subjective
"dogfood" pass over the AGENTS.md guidance and an end-to-end LabVIEW run.

Record a result for each case in the **Result** field (`PASS` / `FAIL` + notes), then complete
the sign-off block at the end.

---

## 1. Environment

| Requirement | Needed for | How it arrives |
| --- | --- | --- |
| Windows 11 guest (VMware or VirtualBox) | all | reviewer's own box, `vagrant up --provider <vmware_desktop\|virtualbox>` |
| VS Code (`code` on PATH) | all | provisioning |
| `labview-benchmark-actor` extension (`.vsix`) | all | provisioning installs it from the `ext-v*` GitHub Release |
| `lbabus` CLI on PATH | Capabilities, Poll Bus, Post Note | provisioning |
| GitHub auth for `lbabus` (bus reach) | Poll Bus, Post Note | reviewer supplies (see BYO docs) |
| Licensed LabVIEW (reviewer's own) | End-to-end run (TC-09) | reviewer's own box, per BYO docs |

Notes:
- The extension shells out to `lbabus` (command name `lbabus`) for **Show Host Capabilities**,
  **Poll Bus**, and **Post Note**; those three need the CLI on PATH, and the two bus commands
  additionally need GitHub auth so the CLI can reach Discussion #1.
- **Open Benchmark Viewer**, and all three **AGENTS.md** commands, are self-contained in the
  `.vsix` (no CLI, no LabVIEW, no network) and can be reviewed on any box.
- All extension output lands in the **Output → "LabVIEW Benchmark Actor"** channel; keep it open.

## 2. Dependency matrix (what each case needs)

| Case | Feature | CLI | GitHub auth | LabVIEW |
| --- | --- | :-: | :-: | :-: |
| TC-00 | Install / activation | – | – | – |
| TC-01 | Write Agent Instructions | – | – | – |
| TC-02 | Show Agent Instructions | – | – | – |
| TC-03 | Check Agent Instructions | – | – | – |
| TC-04 | Poll Coordination Bus | yes | yes | – |
| TC-05 | Post Coordination Note | yes | yes | – |
| TC-06 | Open Benchmark Viewer | – | – | – |
| TC-07 | Show Host Capabilities | yes | – | – |
| TC-08 | Dogfood AGENTS.md guidance | – | – | – |
| TC-09 | End-to-end LabVIEW run | yes | opt. | yes |
| TC-10 | MCP server (programmatic) | – | – | – |
| TC-11 | Agent-chat tool invocation | – | – | – |

---

## 3. Test cases

Open the Command Palette with **Ctrl+Shift+P** and type "LabVIEW Benchmark Actor" to find every
command. Open a folder (**File → Open Folder**) before the AGENTS.md cases — they act on the
workspace root.

### TC-00 — Install and activation
- **Pre:** VM provisioned; VS Code installed.
- **Steps:**
  1. Open VS Code. Open **Extensions** (Ctrl+Shift+X) and confirm `labview-benchmark-actor`
     (publisher `svelderrainruiz`) is installed and enabled.
  2. Open the Command Palette and confirm all seven commands appear under the
     "LabVIEW Benchmark Actor:" prefix.
- **Expected:** the extension is listed and enabled; all seven commands are present.
- **Result:** _____

### TC-01 — Write Agent Instructions
- **Pre:** a folder is open with **no** `AGENTS.md` at its root.
- **Steps:**
  1. Run **LabVIEW Benchmark Actor: Write Agent Instructions**.
  2. Confirm `AGENTS.md` is created at the workspace root.
  3. Run the command again (now the file exists) and, in the modal, choose **Show Diff**.
  4. Run it a third time and choose **Overwrite**.
- **Expected:**
  - First run: an info toast "Wrote AGENTS.md (v…)"; the file exists and begins with a single
    provenance stamp line followed by the canonical body.
  - Second run: a modal offers **Overwrite / Show Diff / Cancel**; **Show Diff** opens a diff of
    the workspace file against the extension canonical.
  - Third run: **Overwrite** rewrites the file and re-shows the info toast.
- **Result:** _____

### TC-02 — Show Agent Instructions
- **Steps:**
  1. Run **LabVIEW Benchmark Actor: Show Agent Instructions**.
- **Expected:** a **read-only** editor opens showing the shipped canonical `AGENTS.md`
  (rendered as Markdown), with the version in the title; it does not modify the workspace.
- **Result:** _____

### TC-03 — Check Agent Instructions (match, drift, rewrite)
- **Pre:** a folder is open; run TC-01 first so an `AGENTS.md` exists.
- **Steps:**
  1. With an unmodified `AGENTS.md`, run **Check Agent Instructions**.
  2. Edit `AGENTS.md` (add a line), save, and run **Check Agent Instructions** again;
     choose **Show Diff**.
  3. Run it once more and choose **Rewrite**.
  4. (Optional) Close the folder and run the command with no folder open.
- **Expected:**
  - Unmodified: info toast "AGENTS.md matches the shipped extension canonical (v…)".
  - After editing: a warning "AGENTS.md has DRIFTED…" with **Show Diff / Rewrite**; **Show Diff**
    opens the diff.
  - **Rewrite** restores the canonical and toasts "Rewrote AGENTS.md…"; a re-check then matches.
  - No folder open: a warning telling you to open a folder / run Write first.
- **Result:** _____

### TC-04 — Poll Coordination Bus
- **Pre:** `lbabus` on PATH; GitHub auth configured.
- **Steps:**
  1. Run **LabVIEW Benchmark Actor: Poll Coordination Bus**.
- **Expected:** the **"LabVIEW Benchmark Actor"** output channel shows the last ~10 bus messages
  (the command runs `lbabus net poll --tail 10`); no error. If the CLI is missing, the channel
  shows a clear error (record it).
- **Result:** _____

### TC-05 — Post Coordination Note
- **Pre:** `lbabus` on PATH; GitHub auth configured. Use a clearly-marked test note.
- **Steps:**
  1. Run **LabVIEW Benchmark Actor: Post Coordination Note**.
  2. At the prompt, enter an ASCII note, e.g. `NOTE reviewer VM smoke test`.
- **Expected:** the note is announced (`lbabus net send --type NOTE`); the output channel confirms it;
  polling (TC-04) then shows the note. Empty input cancels with no send.
- **Result:** _____

### TC-06 — Open Benchmark Viewer
- **Steps:**
  1. Run **LabVIEW Benchmark Actor: Open Benchmark Viewer**.
- **Expected:** a "Benchmark Viewer" webview panel opens and renders the bundled MPRR series
  (chart/series visible, no blank panel, no script errors). Self-contained; needs no CLI/LabVIEW.
- **Result:** _____

### TC-07 — Show Host Capabilities
- **Pre:** `lbabus` on PATH.
- **Steps:**
  1. Run **LabVIEW Benchmark Actor: Show Host Capabilities**.
- **Expected:** the output channel prints the host capability report (`lbabus capabilities`)
  within ~15s; values look correct for the VM (OS, tooling). If the CLI is missing, a clear error.
- **Result:** _____

### TC-08 — Dogfood the embedded AGENTS.md (subjective)
- **Steps:**
  1. Read the AGENTS.md surfaced by **Show Agent Instructions** (TC-02).
  2. As an expert, judge: is the guidance **accurate** for this repo/toolchain, **clear**,
     **actionable**, and free of stale or misleading instructions? Try to follow one instruction
     end-to-end and confirm it works as written.
- **Expected:** the guidance is accurate, clear, and actionable. Record any inaccuracy, ambiguity,
  missing step, or improvement as a note (these feed AGENTS.md revisions).
- **Result:** _____

### TC-09 — End-to-end LabVIEW benchmark run
- **Pre:** the reviewer's box has **licensed LabVIEW** (per the BYO docs).
- **Steps:**
  1. Follow the BYO/run docs to execute a real benchmark run on the guest.
  2. Open the **Benchmark Viewer** (TC-06) and confirm it reflects the real run's series.
- **Expected:** the benchmark runs to completion on real LabVIEW; the viewer shows the real
  series; results are plausible. Record timings and any failures.
- **Result:** _____

### TC-10 — MCP server (programmatic capability)
- **Pre:** an **MCP-capable client** (e.g. the editor's AI agent) that can discover the
  extension-provided MCP server. No CLI or LabVIEW needed.
- **Steps:**
  1. With the extension active, have the MCP client list available MCP servers/tools.
  2. Confirm the **`labviewBenchmarkActor`** server is present and exposes the four tools:
     `get_host_capabilities`, `get_benchmark_series`, `poll_coordination_bus`,
     `post_coordination_note`.
  3. Invoke **`get_benchmark_series`** and confirm it returns the bundled MPRR series
     (the same data the viewer renders in TC-06).
- **Expected:** the server is discoverable and starts locally over stdio; the four tools are
  listed; `get_benchmark_series` returns a structured series with no error. Nothing is sent to the
  internet. See [../mcp-tools.md](../mcp-tools.md) for the full tool contract.
- **Result:** _____

### TC-11 — Agent-chat tool invocation (agent-facing surface)
- **Pre:** the extension is installed and active; the editor's AI chat is available in **Agent**
  mode. No CLI or LabVIEW needed. This case exercises the extension's agent-facing tools (its
  Language Model tools and the bundled MCP grid tools) the way a real agent uses them.
- **Automated drive (VirtualBox reviewer VM):** from the host, run
  `reviewer-workstation/drive-agent-chat.sh --vm <name> --prompt "Open the resource profile benchmark panel" --out <dir>`.
  It starts a fresh chat, types and submits the prompt, and captures PNG evidence at each step
  (`01`..`06`) into `<dir>`. Inspect the frames to judge PASS/FAIL. This is the authoritative
  procedure that caught the `check_independence` MCP schema defect described below.
- **Steps (manual equivalent):**
  1. Start a fresh chat (Command Palette -> **Chat: New Chat**), Agent mode.
  2. Enter the prompt: `Open the resource profile benchmark panel`.
  3. Submit and wait for the agent to invoke the extension's benchmark-panel tool.
- **Expected:** the agent validates its tool set with **no** "tool parameters array type must have
  items" or other tool-validation error, invokes the extension's tool, and the **Benchmark
  Resource Profile** panel opens and renders (CPU/RAM/disk correlation). Every published MCP tool
  schema is well-formed.
- **Gotcha — MCP schema changes do not hot-reload:** VS Code **caches MCP tool schemas** and keeps
  MCP servers alive **across window reloads**. After reinstalling a `.vsix` that changes any MCP
  tool schema, run **MCP: Reset Cached Tools** *and* fully restart VS Code (kill + relaunch, not
  just **Developer: Reload Window**) before re-testing, or the stale schema persists and the tool
  keeps failing validation. The offline guard in
  `experiments/acg-mcp/grid-tools.selftest.mjs` (gate `acg-mcp`) catches malformed tool schemas at
  build time so this defect cannot ship again.
- **Result:** _____

---

## 4. Reviewer sign-off

| Field | Value |
| --- | --- |
| Reviewer | _____ |
| Date (UTC) | _____ |
| VM provider | `vmware_desktop` / `virtualbox` |
| Windows version | _____ |
| Extension version (`ext-v…`) | _____ |
| LabVIEW version (if TC-09) | _____ |
| Overall result | PASS / PASS-with-notes / FAIL |

Summary / notes:

- _____

File issues for any `FAIL` or `PASS-with-notes` item and link them here.
