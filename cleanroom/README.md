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
3. **Vagrant VMware Utility** — `winget install Hashicorp.VagrantVMwareUtility` (a local service the provider talks to).
4. **VMware provider plugin** — `vagrant plugin install vagrant-vmware-desktop`.

Verify the host is ready with `lbabus capabilities` — it reports `[yes] vmware` and `[yes] vagrant`.

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

## Bring it up

```powershell
cd cleanroom
$env:VIHS_CLEANROOM_BOX = "vihs/labview-cleanroom"   # your packaged box
vagrant up --provider vmware_desktop
```

`bootstrap.ps1` then installs the pinned toolchain, **builds `lbabus` from the synced source**, installs
it as a global tool, and runs `lbabus capabilities` + `lbabus selfcheck` (which fails closed if any pinned
tool is missing/below-pin). A green `selfcheck` proves the clean room is a valid coordination environment.

## Knobs (env)

| var | default | meaning |
|-----|---------|---------|
| `VIHS_CLEANROOM_BOX` | `vihs/labview-cleanroom` | operator-supplied base box (licensed LabVIEW) |
| `VIHS_CLEANROOM_MEM` | `8192` | guest RAM (MB) |
| `VIHS_CLEANROOM_CPUS` | `4` | guest vCPUs |

## Where this is going (RFC #15)

The clean room is the substrate for turning `lbabus` into a **cleanroom agent resource serializer** —
async agents on the same system lease capability-derived resources (the LabVIEW runtime, Docker, devices)
through `lbabus resource acquire/release` so they don't collide. See issue #15.
