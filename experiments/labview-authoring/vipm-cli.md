# VIPM CLI — grounded outline for the collab-cli base AGENTS.md (§8 of the authoring proposal)

Status: **SCRATCH SPEC / OUTLINE** — not the shipped base `AGENTS.md`. This captures the **VM-verified** VIPM CLI
so the eventual base-AGENTS.md section is *grounded, not guessed* (the split seam). It is **promoted into the
collab-cli embedded base `AGENTS.md` at P2** once LINUX confirms the **DQMH-specific** `.vipc` apply on the VM.
Until then, **no VIPM commands are committed to the shipped base AGENTS.md.**

Source: LINUX ANSWER on the coordination bus (2026-07-31T08:13Z), empirically run on the `actor-win11-decouple`
VM (LabVIEW 2026 32-bit).

## VIPM edition split (important)

| Plane | Edition | Constraints |
| --- | --- | --- |
| LINUX decouple **guest** (authoring env) | **VIPM 2026.3.0 Community** | Refuses to run **outside a public git repo** → invoke `vipm` with **CWD inside a public-repo checkout**; **text-only** (no `--json`, which is Pro-only) |
| **WIN host** (this machine) | **VIPM Pro** | No public-repo restriction; `--json` available |

`vipm.exe` on the guest PATH at `C:\Program Files\JKI\VI Package Manager\support\vipm.exe`.

LabVIEW targeting is via the **global** options `--labview-version <YYYY>` (4-digit year) + `--labview-bitness <32|64>`.

## The three operations the AGENTS.md section will document

- **detect** — is VIPM present + which edition/version:

  ```
  vipm version            # e.g. "2026.3.0 Community Edition"
  ```

- **install DQMH from the pinned `.vipc`** — deterministic, resolves + pins transitively (DQMH + JKI State Machine
  + any transitive), `-y` skips the file-install confirm prompt (needed for automation):

  ```
  vipm install <path\to\dqmh.vipc> --labview-version 2026 --labview-bitness 32 -y
  ```

  On the **Community** guest, run this with **CWD inside a public-repo checkout** (e.g. a clone of
  `labview-benchmark-actor`) or it errors "requires a public Git repository". The WIN Pro host has no such
  restriction. *(The DQMH-specific apply is pending LINUX's confirmation of a real `dqmh.vipc` run.)*

- **verify DQMH installed** — env check, fail closed on missing:

  ```
  vipm --labview-version 2026 --labview-bitness 32 list --installed   # or: vipm info <pkg>
  ```

  Proven clean baseline returns `Installed packages: (none)` with rc=0.

## Determinism boundary (unchanged)

The **authoritative cross-plane gate artifact remains the deterministic lvkit netlist** — `vipm` is used **only**
for the DQMH-installed **env check** (parse `list --installed` text + rc). The env-probe should **tolerate both**
editions: **text** on the Community guest, **`--json`** on the WIN Pro host. No LLM-facing dependency tool text
feeds the gate path.

## Promotion checklist (P2)

- [ ] LINUX confirms the **DQMH-specific** `.vipc` apply verb on the VM (real `dqmh.vipc`).
- [ ] Fold these verified verbs (detect / install-via-.vipc / verify) into the collab-cli **embedded base
      `AGENTS.md`** §8, with the edition split + public-repo-CWD + text/json notes.
- [ ] Keep the "authoritative artifact = lvkit netlist; vipm only for env check" boundary explicit.
