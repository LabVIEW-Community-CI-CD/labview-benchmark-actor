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

[`lv-iso-map.json`](lv-iso-map.json) mirrors labview-icon-editor's `.lv-iso-map.json`: a version key →
per-OS/arch **offline ISO URL + NIPM package id**. **`x86` is 32-bit LabVIEW.** LabVIEW 2026 32-bit is the
`2026q1` → `windows` → `x86` entry (`ni-labview-2026-community-x86_26.1.0_offline.iso`, package
`LabVIEW_COM_PKG 26.0100`).

[`install-labview.ps1`](install-labview.ps1) consumes the map: resolve the version/arch → obtain the ISO (a
prior `LV_ISO_PATH` for an offline/licensed ISO, else download per the map) → `Mount-DiskImage` → add the ISO's
**nipkg feed** and `nipkg install --accept-eulas --yes <package_id>` (fallback: the ISO's `Install.exe
--passive --accept-eulas --prevent-reboot`) → verify `LabVIEWCLI` / the install dir → dismount. **Nothing
licensed is committed** — only the map + the installer; the ISO is fetched from NI at build time on the Windows
host.

## Build (WIN, Windows host)

Switch Docker Desktop to **Windows containers**, then build from the **repo root** (context must include the
shared `bootstrap.ps1` + `tools/collab-cli`):

```powershell
# Offline/licensed ISO (recommended — avoids a multi-GB download layer): stage the ISO and pass it through.
docker build -f cleanroom/docker-windows/Dockerfile.windows `
  --build-arg LV_VERSION=2026q1 --build-arg LV_ARCH=x86 `
  -t vihs/labview-cleanroom-win .

# Then prove the clean room + LabVIEW:
docker run --rm vihs/labview-cleanroom-win   # -> lbabus capabilities (expect labview-cli=yes)
```

Provision the ISO one of two ways:
- **Offline (preferred):** `COPY` the ISO into the context (or a build mount) and set `LV_ISO_PATH` so
  `install-labview.ps1` skips the download. Keep the ISO out of git (it is large + licensed).
- **Download:** let `install-labview.ps1` fetch the ISO from the map URL (slow, multi-GB layer).

### Isolation note
`Mount-DiskImage` works under the **process-isolation** engine. Under **Hyper-V isolation**, mounting a disk
image may be restricted — extract the ISO with 7-Zip and point the installer at the extracted feed instead
(a follow-up `-ExtractedIso` path can be added to `install-labview.ps1` once WIN confirms the host isolation
mode).

## What WIN validates

1. The Windows base image + `bootstrap.ps1` reuse (git via MinGit, dotnet/rg/gh/glab, `lbabus` build) succeed in
   a container the same way they do in the Vagrant box.
2. `install-labview.ps1` installs LabVIEW 2026 **32-bit** headless from the real ISO (confirm the exact
   `nipkg`/`Install.exe` silent flags + activation/licensing posture for a container).
3. `lbabus capabilities` reports `labview-cli=yes` in the built image — the mirror reaches LabVIEW parity with
   the Vagrant licensed box.

The pinned tool versions, gate order, and `bootstrap.ps1` stay in lockstep with the Vagrant lane so the two
clean rooms remain true mirrors.
