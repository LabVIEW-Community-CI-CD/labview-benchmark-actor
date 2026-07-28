# Docker Windows-container clean-room mirror (LabVIEW 2026 32-bit)

A **Docker Windows-container** mirror of the Vagrant clean room ([../Vagrantfile](../Vagrantfile),
[../Vagrantfile.virtualbox](../Vagrantfile.virtualbox)). **Windows hosts only** — it needs the Windows-container
engine (Docker Desktop switched to Windows containers, or a Windows Server host) and cannot build on a Linux
Docker engine. This is the docker leg of the operator's *"clean-room mirror between Vagrant and Docker Windows
containers on Windows-specific systems"*, and it **expands** the container to **install LabVIEW 2026 32-bit from
an NI ISO map**, modeled on [ni/labview-icon-editor](https://github.com/ni/labview-icon-editor)'s
`.lv-iso-map.json`.

> Authored on the LINUX plane (which cannot run Windows containers). **WIN builds + validates** this lane on a
> Windows host with the Windows-container engine and access to the LabVIEW ISO.

## Mirror contract (Vagrant ⇄ Docker Windows container)

| Concern | Vagrant lane (`../Vagrantfile*`) | Docker Windows-container lane (here) |
|---|---|---|
| Host | Windows/mac/Linux w/ VMware or VirtualBox | **Windows only** + Windows-container engine |
| Toolchain (dotnet/rg/gh/glab) + build lbabus | `../bootstrap.ps1` | **same `../bootstrap.ps1`, reused verbatim** |
| LabVIEW | pre-baked into the licensed **base box** | **installed into the image** from the NI ISO map |
| Clean-room proof | `lbabus capabilities` + `selfcheck` | **same** `lbabus capabilities` + `selfcheck` |
| Isolation | VM | container |

The **only** intentional divergence is *how LabVIEW arrives*: the Vagrant base box ships it; this lane builds it
in via the ISO map. Everything else (the pinned toolchain, building lbabus from source, the capability/selfcheck
proof) is the **same `bootstrap.ps1`** — the mirror's whole point.

## The ISO map (labview-icon-editor pattern)

[`lv-iso-map.json`](lv-iso-map.json) mirrors labview-icon-editor's `.lv-iso-map.json`, then **corrected against
the real LabVIEW 2026 offline ISO + nipkg 26.5.0 (WIN-plane live validation)**: a version key → per-OS/arch
**offline ISO URL + the real nipkg meta-package name**. **`x86` is 32-bit LabVIEW.** LabVIEW 2026 32-bit is the
`2026q1` → `windows` → `x86` entry: ISO `ni-labview-2026-community-x86_26.1.2_offline.iso`, package
**`ni-labview-2026-community-x86`** (there is **no** `LabVIEW_COM_PKG` package on the ISO, and the installer
resolves the meta-package **by name** so it is version-tolerant across 26.1.x). LabVIEWCLI is a **separate NI
product** (`ni-labview-command-line-interface-x86`, its own `cli_iso_name`), so a `labview-cli=yes` clean room
installs **both**.

[`install-labview.ps1`](install-labview.ps1) consumes the map: resolve the version/arch → resolve the offline
**feed** (primary: a host-extracted `LV_EXTRACTED_FEED`; fallback: `Mount-DiskImage` of `LV_ISO_PATH`, process-
isolation only) → **bootstrap NIPM** from the feed's `Install.exe` (the ISO ships **no** standalone `nipkg.exe`)
→ `nipkg feed-add --system --name lv-cleanroom-offline <feed>` → `nipkg update` → `nipkg install
--accept-eulas --yes --include-recommended ni-labview-2026-community-x86` → repeat feed-add + install for the
separate CLI package → verify `LabVIEWCLI` / the install dir. **Nothing licensed is committed** — only the map +
the installer; the feed is staged from NI at build time on the Windows host.

> **nipkg flag corrections (WIN, nipkg 26.5.0):** `--system` is valid on `feed-add` **only** (not on
> `install`/`update`); the install flag is **`--include-recommended`** (not `--include-recommends`).

## Build (WIN, Windows host)

Switch Docker Desktop to **Windows containers**, then **host-extract the NI offline feed(s)** into the build
context (Hyper-V isolation cannot `Mount-DiskImage` in-container — see below), and build from the **repo root**
(context must include the shared `bootstrap.ps1` + `tools/collab-cli`):

```powershell
# 1. Host-extract the offline feeds into the build context (licensed/community artifacts; gitignored):
7z x ni-labview-2026-community-x86_26.1.2_offline.iso      -ocleanroom/docker-windows/.lv-feed
7z x ni-labview-command-line-interface-x86_26.1.0_offline.iso -ocleanroom/docker-windows/.lv-cli-feed

# 2. Build (the Dockerfile COPYs the staged feeds and points install-labview.ps1 at them):
docker build -f cleanroom/docker-windows/Dockerfile.windows `
  --build-arg LV_VERSION=2026q1 --build-arg LV_ARCH=x86 `
  -t vihs/labview-cleanroom-win .

# 3. Prove the clean room + LabVIEW:
docker run --rm vihs/labview-cleanroom-win   # -> lbabus capabilities (expect labview-cli=yes)
```

The staged `.lv-feed` / `.lv-cli-feed` dirs are large + licensed — they are **gitignored**, never committed.

### Isolation note (Hyper-V — the Win11-client default)
**The host-extracted feed is MANDATORY under Hyper-V isolation, not optional.** WIN confirmed live that
in-container `Mount-DiskImage` throws **"A virtual disk support provider for the specified file was not found"**
under Hyper-V isolation. So the recommended flow is: **HOST-side** extract the ISO feed into the build context;
**in-container** `nipkg feed-add --system --name lv-cleanroom-offline <extracted-feed>` → `nipkg update` →
`nipkg install --accept-eulas --yes --include-recommended ni-labview-2026-community-x86`. `install-labview.ps1`
keeps `Mount-DiskImage` (`LV_ISO_PATH`) **only** as a process-isolation fallback (e.g. Windows Server hosts),
and fails closed with a clear pointer to `LV_EXTRACTED_FEED` if the mount provider is absent.

## What WIN validated (PR #62 live, real ISO)

WIN validated the mirror against the **real** LabVIEW 2026 offline ISO
(`ni-labview-2026-community-x86_26.1.2_offline.iso`, 3.86 GB) + nipkg 26.5.0 and drove the corrections now
applied here:

1. **NIPM bootstrap** — the ISO ships `bin\Install.exe` + `feeds\` + `pool\*.nipkg` but **no** standalone
   `nipkg.exe`, so NIPM is bootstrapped from `Install.exe` before any feed-add/install.
2. **Real package name** — the installable meta-package is **`ni-labview-2026-community-x86`** (v26.1.2.49158),
   not `LabVIEW_COM_PKG`; the installer resolves it by name (version-tolerant across 26.1.x).
3. **Corrected nipkg flags** — `--system` is `feed-add`-only; install uses `--include-recommended`.
4. **Separate CLI product** — `LabVIEWCLI.exe` ships as `ni-labview-command-line-interface-x86` (its own ISO),
   installed via its own feed for `labview-cli=yes` parity.
5. **Hyper-V isolation** — in-container `Mount-DiskImage` fails, so the **host-extracted feed is the primary
   (mandatory) path**; `Mount-DiskImage` is a process-isolation-only fallback.

Still in WIN's live lane: the full servercore container build proving `bootstrap.ps1` reuse + the extracted-feed
LabVIEW install end `lbabus capabilities` reporting `labview-cli=yes`. The pinned tool versions, gate order, and
`bootstrap.ps1` stay in lockstep with the Vagrant lane so the two clean rooms remain true mirrors.
