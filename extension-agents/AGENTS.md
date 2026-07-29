# labview-benchmark-actor — Agent Instructions (extension users)

These are the agent instructions shipped **inside** the `labview-benchmark-actor` VS Code extension. They
are versioned on their **own** semver (see `agents.manifest.json`), independent of the extension build and of
the `collab-cli` (`lbabus`) coordination instructions. Materialize this file into your workspace with the
command **"LabVIEW Benchmark Actor: Write Agent Instructions"** so your coding agent picks it up.

You are an AI coding agent working in a workspace where the **labview-benchmark-actor** extension is
installed. This file tells you how to leverage it.

## What the extension provides

The extension surfaces the LabVIEW benchmark-actor's cross-plane benchmark data and coordination inside VS
Code:

- **Benchmark viewer** — renders a deterministic mprr ring-buffer series (the same series the screenshot
  harness captures), so you can inspect the benchmark result the actor produced rather than re-deriving it.
- **Host capabilities** — reports what the current host can actually run (LabVIEW runtime, Docker, etc.).
- **Coordination bus** — read and post notes on the cross-plane coordination bus (the WIN ⟷ LINUX channel).

## Commands (Command Palette)

| Command | When to use |
| --- | --- |
| `LabVIEW Benchmark Actor: Open Benchmark Viewer` | Show the rendered mprr benchmark series. |
| `LabVIEW Benchmark Actor: Show Host Capabilities` | Learn the host's real runtime before proposing benchmark work. |
| `LabVIEW Benchmark Actor: Poll Coordination Bus` | Read the latest cross-plane coordination messages. |
| `LabVIEW Benchmark Actor: Post Coordination Note` | Post a coordination note to the bus. |
| `LabVIEW Benchmark Actor: Write Agent Instructions` | Materialize this AGENTS.md into the workspace. |
| `LabVIEW Benchmark Actor: Check Agent Instructions` | Verify a workspace copy matches the shipped canonical. |

## How to work with the extension

1. Before proposing benchmark work, run **Show Host Capabilities** to learn the host's real runtime instead of
   assuming it.
2. Use the **Benchmark Viewer** to inspect the deterministic series; do not re-derive a result the actor has
   already produced.
3. Treat the **coordination bus** as the authoritative "what is next" channel. Its timestamps are the GitHub
   server `createdAt` — a single authoritative clock. Never reason from a message's embedded local `ts` (a
   sender's machine clock can drift); the tool surfaces a clock-skew note when it does.

## Conventions

- The benchmark series is **deterministic**: the same fixture yields the same series and the same screenshot
  hash. Reproduce, do not re-invent.
- Cross-plane results are compared by a content **digest** (a `resultHash` / `seriesHash`) that MUST match
  across planes. Do not treat a benchmark as agreed until the digests match on both planes.

## Windows notes

Windows-specific guidance for agents using this extension on a Windows host:

- **LabVIEW runtime & bitness.** Run **Show Host Capabilities** first — a Windows host often has *both* 32-bit
  and 64-bit LabVIEW installed. Match the bitness to the target VIs (for example, the icon-editor project is
  32-bit). When a LabVIEW CLI operation (such as VI Analyzer) cold-launches LabVIEW and fails with `-350000`
  ("failed to establish a connection with LabVIEW"), the VI Server TCP port does not match: the CLI defaults to
  port **3363**, so pass the matching `-LabVIEWPath <the intended bitness>` and `-PortNumber 3363` (or enable
  VI Server / align `server.tcp.port` in that LabVIEW's `.ini`).
- **Docker engine.** Windows containers require Docker Desktop's **Windows** engine (Hyper-V isolation); Linux
  containers require its **Linux** engine — you switch between them, they are not both active at once. On
  Hyper-V Windows containers, `docker run -p` port publishing can fail with `hnsCall ... 0x490`; reach the
  container directly at its NAT IP (`docker inspect`) instead.
- **Paths & line endings.** Prefer the extension commands over hard-coded paths. Windows uses `\`, but
  normalize to `/` before computing any cross-plane digest so a `resultHash`/`seriesHash` matches Linux. This
  file is stored with **LF**; the drift check canonicalizes CRLF→LF, so a Windows checkout never false-drifts.
  Watch for 8.3 short paths under `%TEMP%` when stripping path prefixes.
- **Remote / WSL.** The **Write / Check Agent Instructions** commands use the VS Code workspace filesystem API,
  so they work in WSL, Remote-SSH, and virtual workspaces, not just local disk.

---

Materialize with **"LabVIEW Benchmark Actor: Write Agent Instructions"**; verify with **"LabVIEW Benchmark
Actor: Check Agent Instructions"**. This file's version and integrity hash live in `agents.manifest.json`.
