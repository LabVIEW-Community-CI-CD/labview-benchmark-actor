# VMware clean room (Vagrant)

A reproducible "clean room" VM where an operator drops in their **licensed LabVIEW** and the
**collab-cli coordination toolchain is bootstrapped automatically** (built from source, not downloaded).
Provider is **VMware** (`vmware_desktop`), not VirtualBox, per project direction. Tracks #4; the
resource-serializer direction that consumes it is RFC #15.

## Why VMware + a self-supplied box

There is **no public LabVIEW box** — LabVIEW is licensed, so the operator supplies the base image. The
clean room carries LabVIEW in the base box; this Vagrantfile bootstraps everything *around* it (the
pinned `rg`/`git`/`gh`/`glab`/`dotnet` toolchain + a freshly built `lbabus`).

## One-time host prerequisites

1. **VMware Workstation** (this host has it — `vmrun` under `C:\Program Files (x86)\VMware\VMware Workstation`).
2. **Vagrant** (`winget install Hashicorp.Vagrant` — 2.4.9 verified here).
3. **VMware provider plugin** — `vagrant plugin install vagrant-vmware-desktop` (3.0.5 installed here).
4. **Vagrant VMware Utility** — NOT in winget; download the signed MSI from HashiCorp and install elevated
   (it registers a local service + certs the provider talks to). Verify the checksum first:
   ```powershell
   $v="1.0.24"; $b="https://releases.hashicorp.com/vagrant-vmware-utility/$v"
   iwr "$b/vagrant-vmware-utility_${v}_windows_amd64.msi" -OutFile "$env:TEMP\vvu.msi"
   # verify against $b/vagrant-vmware-utility_${v}_SHA256SUMS, then:
   Start-Process msiexec -ArgumentList '/i',"$env:TEMP\vvu.msi",'/qn' -Verb RunAs -Wait
   ```
   (1.0.24 installed + SHA-256-verified here; service `VagrantVMware` runs and `vagrant validate` passes.)

Verify the host is ready with `lbabus capabilities` (reports `[yes] vagrant` / `[yes] vmware`) and, from
this folder, `vagrant validate` (→ `Vagrantfile validated successfully.`).

## Package a base box from an existing VMware VM

The base box should already have licensed LabVIEW installed. To build one from an existing VMware VM
(e.g. `C:\VM\VIHS`):

```powershell
# from a copy of the VM you want as the clean-room base
vagrant package --base "VIHS" --output vihs-labview-cleanroom.box   # VMware: use the box workflow in the plugin docs
vagrant box add vihs/labview-cleanroom vihs-labview-cleanroom.box
```

(See the vagrant-vmware-desktop docs for the exact packaging flow; VMware boxes are packaged from a
prepared `.vmx`.) Override the box name with `VIHS_CLEANROOM_BOX`.

**For a self-contained box** (no host repo / SMB / credential prompt at `vagrant up`), bake the collab-cli
source into the guest before packaging so the provisioner builds from it: copy `tools/collab-cli` to
`C:\cleanroom-src\tools\collab-cli` in the prepared VM, then `vagrant package`. Proven end to end: with the
source only at `C:\cleanroom-src` (SMB path removed), `vagrant provision` builds `lbabus` + `selfcheck: PASS`
with no host dependency. Build-on-bootstrap is preserved -- the box just carries its own pinned source.

## Bring it up

```powershell
cd cleanroom
$env:VIHS_CLEANROOM_BOX = "vihs/labview-cleanroom"   # your packaged box
vagrant up --provider vmware_desktop
```

`bootstrap.ps1` then installs the pinned toolchain, **builds `lbabus` from the synced source**, installs
it as a global tool, and runs `lbabus capabilities` + `lbabus selfcheck` (which fails closed if any pinned
tool is missing/below-pin). A green `selfcheck` proves the clean room is a valid coordination environment.

### Provisioner notes (verified)

The provisioner is **winget-free by design**: `winget` is an MSIX app-execution alias that is *not*
resolvable in the non-interactive WinRM provisioner session, so the toolchain installs via the official
`dotnet-install` script (.NET SDK) + direct release archives (`rg`/`gh`/`glab`); `git` ships in the base
box. `bootstrap.ps1` is kept **pure ASCII** because Vagrant uploads it and PowerShell 5.1 reads a BOM-less
file as ANSI, so a non-ASCII byte (e.g. an em-dash) corrupts and breaks the parse. Verified end to end via
`vagrant provision`: toolchain installed, `lbabus` built, `selfcheck: PASS` (rg/git/gh/glab/dotnet all
above-pin), and `AGENTS.md` materialized in the guest home.

For an **unattended / self-contained** boot (no host repo, no SMB credential prompt) set
`VIHS_CLEANROOM_NO_SYNC=1` to disable the synced folder; the provisioner then builds from a **box-baked**
source at `C:\cleanroom-src\tools\collab-cli` (bake it in before `vagrant package` -- see "Package a base
box" above), falling back to the SMB synced folder (`C:\vagrant-src`) on a dev host that syncs its tree.

## Knobs (env)

| var | default | meaning |
|-----|---------|---------|
| `VIHS_CLEANROOM_BOX` | `vihs/labview-cleanroom` | operator-supplied base box (licensed LabVIEW) |
| `VIHS_CLEANROOM_MEM` | `8192` | guest RAM (MB) |
| `VIHS_CLEANROOM_CPUS` | `4` | guest vCPUs |
| `VIHS_CLEANROOM_NO_SYNC` | (unset) | when set, disable the SMB synced folder (unattended boot, no host credential prompt); pre-stage source at `C:\vagrant-src` |

## LINUX / VirtualBox parity (`Vagrantfile.virtualbox`)

The LINUX plane runs the *same* clean room on **VirtualBox** instead of VMware (a Linux host has no
VMware here — `lbabus capabilities` reports `vmware [no]`). `Vagrantfile.virtualbox` reuses this
folder's **`bootstrap.ps1` verbatim**; only the provider block (`virtualbox`) and the synced-folder
type (`virtualbox` Guest-Additions instead of `smb`) differ. Validated on Vagrant 2.4.9 + VirtualBox
7.2.6 (`vagrant validate` → *Vagrantfile validated successfully*).

```sh
cd cleanroom
VAGRANT_VAGRANTFILE=Vagrantfile.virtualbox VIHS_CLEANROOM_BOX=vihs/labview-cleanroom \
  vagrant up --provider virtualbox
```

This is the parity model from RFC #15: **shared provider-agnostic provisioning, a per-plane provider
block** — so `lbabus capabilities` can pick the provider (`vmware [yes]` → `vmware_desktop`, else
`virtualbox`).

## Where this is going (RFC #15)

The clean room is the substrate for turning `lbabus` into a **cleanroom agent resource serializer** —
async agents on the same system lease capability-derived resources (the LabVIEW runtime, Docker, devices)
through `lbabus resource acquire/release` so they don't collide. See issue #15.
