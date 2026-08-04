# ACG Ubuntu benchmark witness + Linux reviewer workstation (Vagrant)

A reproducible, provider-portable **GUI Ubuntu desktop** that doubles as (1) a **Linux reviewer workstation**
with the LabVIEW Benchmark Actor extension installed, and (2) a **benchmark witness** that runs the C# `tpd`
**throughput-to-disk ladder** (no LabVIEW) and records a per-rung MBps distribution. One `Vagrantfile` spawns it
on **either** hypervisor:

| host | provider | default plane |
|---|---|---|
| Linux (this repo's dev box) | `virtualbox` | `VAGRANT-VBOX` |
| Windows / macOS (VMware) | `vmware_desktop` | `VAGRANT-VMWARE` |

## The model: best-effort reproducibility, measured variation

Real disk benchmarks **vary** run-to-run and box-to-box, so a witness records the per-rung **distribution**
(mean / stddev / coefficient-of-variation) rather than a single number — the timestamp differentiates each run.
The cross-witness corroboration (`experiments/acg-quorum/compare-ladders.mjs`) verdicts **corroborated** when the
witnesses span distinct environments (ADR-0017) **and** every shared rung agrees within a tolerance band
(default 20% CoV), always reporting the measured spread. This replaces the deterministic screenshot-hash quorum
with a real-benchmark, best-effort model. **No LabVIEW** — the disk ladder exercises the extension's Linux path
with pure software.

## What a spawn does

1. Clones the candidate from an auth-free host-side git bundle (the repo is private).
2. Builds + packages the extension **VSIX**, installs **.NET 8** + builds the `tpd` tool.
3. Runs the **throughput-to-disk ladder** (a discarded warm-up + N samples per rung) → `out/throughput-ladder-<PLANE>.json`.
4. Installs a **GUI Ubuntu desktop** (GDM auto-login as `vagrant`) + **VS Code** + the **VSIX**, so the box is a
   usable Linux reviewer workstation. Run **"LabVIEW Benchmark Actor: Run Throughput-to-Disk Ladder"** from the
   command palette to drive the ladder interactively.

## Prerequisites

- [Vagrant](https://developer.hashicorp.com/vagrant) 2.3+ and a provider: **VirtualBox** (Linux host) or
  **VMware + the `vagrant-vmware-desktop` plugin** (Windows/macOS).
- The host has this repo checked out. Keep the box store on fast local disk (`VAGRANT_HOME`).

## Bring-up

```bash
# Linux host (VirtualBox) -- from reviewer-workstation/witness-vm/
WITNESS_REF=feature/acg-vagrant-witness vagrant up --provider virtualbox
vagrant reload            # boot into the GNOME desktop (auto-login)

# Windows host (VMware) -- PowerShell
$env:WITNESS_REF="feature/acg-vagrant-witness"; vagrant up --provider vmware_desktop; vagrant reload
```

Overrides: `WITNESS_PLANE=<name>`, `WITNESS_RUNGS=256M,512M,1G`, `WITNESS_SAMPLES=3`, `WITNESS_COMMIT=<sha>`,
`WITNESS_BOX=<box>`, `WITNESS_MEM` / `WITNESS_CPUS`, `WITNESS_DESKTOP=0` (benchmark only, skip the desktop).

## Corroborate two witnesses

Collect a ladder receipt from each host into one folder, then:

```bash
node experiments/acg-quorum/compare-ladders.mjs \
  out/throughput-ladder-VAGRANT-VBOX.json \
  out/throughput-ladder-VAGRANT-VMWARE.json
```

`verdict: pass` with `distinctEnvironments: true` and every rung's `crossCovPct` within tolerance means the
witnesses corroborate best-effort; the per-rung `crossCovPct` quantify the spread.

## Teardown

```bash
vagrant destroy -f      # also removes the host-side candidate.bundle
```

> Note: the Ubuntu desktop pulls NetworkManager, which is pinned to leave the vagrant NAT interface on
> `systemd-networkd` so the install does not drop the provisioner SSH. The desktop comes up on `vagrant reload`
> (GDM auto-login on Xorg). If a `vmware_desktop` synced folder is one-way, collect the receipt with
> `vagrant ssh -c 'cat /vagrant/out/throughput-ladder-<PLANE>.json'`.
