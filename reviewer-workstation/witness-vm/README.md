# ACG Ubuntu witness (Vagrant)

A reproducible, provider-portable **machine-corroboration witness** for the Actor Corroboration Grid
(ADR-0015 / LBA-REQ-024). One `Vagrantfile` spawns an identical Ubuntu witness on **either** hypervisor:

| host | provider | default plane |
|---|---|---|
| Linux (this repo's dev box) | `virtualbox` | `VAGRANT-VBOX` |
| Windows / macOS (VMware) | `vmware_desktop` | `VAGRANT-VMWARE` |

Both spawns run the **same** deterministic pipeline the native LINUX witness runs, so they reproduce
byte-identical anchors (`seriesHash`, `pngSha256`) and form a clean 2-witness quorum (confidence 1.0). The
witness needs **no LabVIEW** — the corroboration anchors are the deterministic SwiftShader viewer render plus
`lba verify`, both pure software.

## Why Vagrant

The 2nd witness used to be a hand-built guest. Capturing it as a `Vagrantfile` makes it **turnkey + auditable**:
anyone can `vagrant up` and reproduce the exact witness environment, and the two hosts spawn *identical* boxes
so the only difference is the hypervisor/plane — exactly the distinct-environment property the quorum wants
(ADR-0017), with none of the manual drift.

## Prerequisites

- [Vagrant](https://developer.hashicorp.com/vagrant) 2.3+.
- A provider: **VirtualBox** (Linux host) or **VMware + the `vagrant-vmware-desktop` plugin** (Windows/macOS).
- The host has this repo checked out (the guest gets the code via an auth-free git bundle — the repo is private).

## Bring-up

From `reviewer-workstation/witness-vm/`:

```bash
# Linux host (VirtualBox)
WITNESS_REF=release/1.0.0 vagrant up --provider virtualbox

# Windows host (VMware)   -- PowerShell
$env:WITNESS_REF="release/1.0.0"; vagrant up --provider vmware_desktop
```

Useful overrides: `WITNESS_COMMIT=<sha>` (pin an exact candidate), `WITNESS_PLANE=<name>` (override the plane),
`WITNESS_BOX=<box>` (e.g. a 26.04 box to match a native resolute host), `WITNESS_MEM` / `WITNESS_CPUS`.

The provisioner clones the candidate from the host-side bundle, builds it, runs `lba verify`, renders the
deterministic screenshot, probes hardware, and assembles the bundle. Outputs land on the host under `out/`:

```
out/witness-<PLANE>.bundle.json      # the acg-witness-bundle (feed to compare-witnesses.mjs)
out/gate-<PLANE>.json                # cleanroom-gate-suite-receipt (verdict + candidate version/commit)
out/screenshot-receipt-<PLANE>.json  # seriesHash + pngSha256
out/capability-<PLANE>.json          # hardware-capability record
```

## Form the quorum

Collect a bundle from each host into one folder, then:

```bash
node experiments/acg-quorum/compare-witnesses.mjs \
  out/witness-VAGRANT-VBOX.bundle.json \
  out/witness-VAGRANT-VMWARE.bundle.json
```

A `verdict: pass` with `distinctEnvironments: true` and `consensus.{version,sourceCommit}` naming the candidate
feeds the composite-release-decision receipt (LBA-REQ-070) exactly like the native LINUX + VMWARE witnesses did
for ext 1.0.0.

## Teardown

```bash
vagrant destroy -f      # also removes the host-side candidate.bundle
```

> Status: authored against the proven witness pipeline (the same commands run natively to seal the ext 1.0.0
> quorum). A live end-to-end `vagrant up` on both providers is the next validation step.
