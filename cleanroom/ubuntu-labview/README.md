# Ubuntu 24.04 + LabVIEW 2026 Community — from-scratch VM (VirtualBox / VMware parity)

A **reproducible, from-scratch** recipe that builds an **Ubuntu 24.04 LTS + LabVIEW 2026 Community** VM on
either hypervisor **from nothing but the stock public Ubuntu ISO**. We distribute **no VM image** — the
**agent** downloads the stock Ubuntu ISO from the vendor (releases.ubuntu.com) after **explicit user
approval** + `SHA256SUMS` verification, then creates + provisions the VM locally; the user's ONLY job is
activating LabVIEW. "VM creation from scratch" is the shipped feature.

This recipe produces the **golden VM** (one image). Replicating it into a *mesh of many instances* is a
separate downstream stage driven by **Vagrant** — see [Downstream — meshing](#downstream--meshing-vagrant).
The builder here and Vagrant compose; they do not compete.

- **VirtualBox** = the LINUX-plane reference (`build-virtualbox.sh` here).
- **VMware** = the WIN-plane mirror (WIN authors `build-vmware.*`; same guest spec + the same
  `provision-guest.sh` — only the hypervisor-creation step differs).
- **Activation is the operator's step.** The recipe installs LabVIEW Community *unactivated*; the operator
  signs in with an NI account to activate (once per VM). WIN flags "ready for activation" when the VMware
  VM boots green.

## Ground truth — the operator's working VM

The reference these scripts reproduce is the operator's activated VirtualBox VM
`lba-ubuntu2404-labview2026`. Its captured hardware profile (the spec the builders match):

| Property            | Value                                                        |
| ------------------- | ----------------------------------------------------------- |
| Guest OS            | Ubuntu 24.04 LTS (Noble Numbat), 64-bit (`Ubuntu24_LTS_64`) |
| LabVIEW             | 2026 Community                                              |
| Firmware / chipset  | BIOS / PIIX3                                                 |
| RAM / vCPU          | 12288 MB / 6                                                |
| VRAM / gfx          | 128 MB / `vmsvga`                                            |
| System disk         | SATA (IntelAhci) VDI, dynamic                               |
| Optical             | IDE (PIIX4) — install ISO, ejected after install            |
| Network             | NIC1 NAT                                                     |
| Snapshot workflow   | `labview2026-installed-preactivation` → `labview2026-activated-ready` |

## Prerequisites (both planes)

1. The hypervisor: **VirtualBox** (LINUX) or **VMware Workstation** (WIN).
2. The **stock Ubuntu 24.04 ISO** — the **agent** downloads it from the vendor (releases.ubuntu.com) after
   **explicit user approval** and verifies it against the vendor `SHA256SUMS`; it's the only "image", and
   it's the vendor's, not ours. No approval => the agent does not download.
3. The NI feed URL + LabVIEW package name (operator-confirmed — see [LabVIEW install](#labview-install)).

## VirtualBox (LINUX plane)

```bash
cd cleanroom/ubuntu-labview

# 1) Preview the exact VBoxManage commands (safe — creates nothing):
./build-virtualbox.sh

# 2) Build for real from the stock ISO (unattended Ubuntu install + Guest Additions):
ISO=/path/to/ubuntu-24.04-desktop-amd64.iso ./build-virtualbox.sh --run
```

The builder is **safe by default** (dry-run) and **refuses to touch an existing VM** of the same name
(so it can never clobber `lba-ubuntu2404-labview2026`). The guest defaults to the **`actor`** identity
(user `actor`, hostname `actor`, passwordless sudo via `provision-guest.sh`) for cross-plane parity with
the Windows cleanroom. Override the spec via env vars —
`VM_NAME DISK_GB MEM_MB CPUS VRAM_MB OSTYPE_ID BASEFOLDER GUEST_USER GUEST_FULLNAME GUEST_HOSTNAME GUEST_PASSWORD`.
Verify the OS-type id on your host with `VBoxManage list ostypes | grep -i ubuntu`.

## VMware (WIN plane) — the mirror

WIN builds the **same guest** with VMware's own from-scratch path — **only the creation step differs**;
the guest spec + `provision-guest.sh` are identical, which is the whole parity contract. Recommended path:

1. `vmrun` / VMware Workstation "New VM" → **Ubuntu 64-bit**, firmware **BIOS**, **12288 MB / 6 vCPU /
   128 MB display**, a single **NVMe or SCSI** system disk (VMware's default; the AHCI/NVMe controller
   choice is the one benign VMware-vs-VBox divergence), NAT networking, attach the **stock Ubuntu 24.04
   ISO** to the virtual optical drive.
2. Use VMware's **Easy Install / autoinstall** (or a manual Ubuntu install) to install Ubuntu 24.04 +
   `open-vm-tools` (VMware's Guest-Additions equivalent — the per-provider guest-tools seam).
3. In the guest, run the **identical** `provision-guest.sh` to install LabVIEW 2026 Community (unactivated).
4. Snapshot `labview2026-installed-preactivation`, then **flag the operator** "ready for activation".

WIN: land this as `cleanroom/ubuntu-labview/build-vmware.ps1` (or `.sh`) so both build paths live side by
side. The provider-specific delta is the VM-creation step + the guest-tools package
(`virtualbox-guest-utils` vs `open-vm-tools`) — everything downstream is shared.

## LabVIEW install

`provision-guest.sh` installs LabVIEW 2026 Community **unactivated** and is **operator-parameterized** —
set both and it installs; omit either and it prints the exact steps + stops (fail-closed, never guesses a
package name):

```bash
sudo NI_FEED_DEB="<NI Ubuntu-24.04 package-feed .deb URL from download.ni.com>" \
     LABVIEW_PKG="<e.g. labview-2026-community>" \
     ./provision-guest.sh
```

Confirm the exact package name on the working VM with `dpkg -l | grep -i labview`.

## Activation (operator only)

After `provision-guest.sh`, the operator signs in with an NI account to activate LabVIEW Community, then
snapshots `labview2026-activated-ready`. **The scripts never automate activation** — it needs human
credentials and is intentionally the operator's step, on both the VirtualBox and VMware VMs.

## Downstream — meshing (Vagrant)

This recipe builds the **golden VM** (one Ubuntu 24.04 + LabVIEW 2026 Community image, from scratch).
**Vagrant's role is the next stage**: it launches *many* copies of that golden VM for meshing experiments —
it is not another way to build the golden VM. The two stages compose:

```
stock Ubuntu 24.04 ISO
  |- build-virtualbox.sh (from scratch) --> golden VM (LabVIEW 2026 Community, unactivated)
       |- operator activates --> snapshot labview2026-activated-ready
            |- vagrant package --> self-contained golden box (e.g. vihs/labview-ubuntu2404-sc)
                 |- Vagrant multi-VM topology --> N instances coordinating over `lbabus net` (TCP/UDP)
```

Once the golden VM is activated, package it into a self-contained box and mesh N copies with the same
pattern as [experiments/multi-vm-topology](../../experiments/multi-vm-topology) (there in its Windows form:
box `vihs/labview-cleanroom-sc`, `vmware_desktop`, two actors on a host-only `private_network` proving
CLAIM/ACK/HANDOFF/DONE + UDP presence — LBA-REQ-006/007). An Ubuntu mesh mirrors it 1:1 — swap the
communicator to **ssh**, the box to the Ubuntu golden box, and the provider to **virtualbox** (LINUX) or
**vmware_desktop** (WIN). Vagrant is cross-provider, so the *same* topology meshes on both planes.
