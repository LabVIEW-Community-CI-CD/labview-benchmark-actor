# Reviewer workstation (#108)

A Windows 11 + LabVIEW 2026 VM where an **expert human reviewer** operates the
`labview-benchmark-actor` VS Code extension and the embedded `AGENTS.md`, then works
through [docs/testing/reviewer-manual-test-plan.md](../docs/testing/reviewer-manual-test-plan.md).

It **repurposes the maintainer-held golden box** (Windows 11 + LabVIEW 2026 + VS Code + Node +
git + LabVIEW fixtures + boot-time WinRM self-heal) and adds only the `labview-benchmark-actor`
bits — the extension `.vsix` (from the gated `ext-v*` Release), the `lbabus` CLI (from the
`collab-cli-v*` Release), and a scratch workspace.

## Providers

Dual-provider by design; pick the one that matches your host. Each provider uses its own
maintainer-held Windows + LabVIEW box (there is **no public LabVIEW box** — licensing):

| Provider | Host lane | Default box | Override |
| --- | --- | --- | --- |
| `virtualbox` | Linux/Ubuntu (LINUX lane; validated here) | `vihs/win11-labview2026` | `VIHS_REVIEWER_BOX` |
| `vmware_desktop` | Windows/VMware (WIN lane) | `vihs/labview-cleanroom` | `VIHS_REVIEWER_BOX_VMWARE` |

Reviewers **without** a box build one per the golden-box docs (bring your own **licensed**
LabVIEW, required for the end-to-end LabVIEW case TC-09) and register it under the name above,
or point the override env var at their own box.

## Bring the box up

```sh
# VirtualBox (Linux host)
VAGRANT_CWD=reviewer-workstation vagrant up --provider virtualbox

# VMware (Windows host)
VAGRANT_CWD=reviewer-workstation vagrant up --provider vmware_desktop
```

Then, inside the guest, open the scratch workspace in VS Code (the extension is already installed):

```powershell
code C:\lba-review
```

Follow [docs/testing/reviewer-manual-test-plan.md](../docs/testing/reviewer-manual-test-plan.md)
from the Command Palette (`Ctrl+Shift+P` → `LabVIEW Benchmark Actor: ...`). The bus and
capabilities commands require `gh auth login` first (reviewer-supplied).

## Configuration (env)

| Variable | Default | Purpose |
| --- | --- | --- |
| `LBA_VM_NAME` | `actor` | VM name shown in VirtualBox / VMware. Set a unique value to run **multiple** reviewer instances side by side. |
| `LBA_VM_HOSTNAME` | = `LBA_VM_NAME` | Guest Windows hostname, sanitized to NetBIOS rules (`<=15` chars, `[A-Za-z0-9-]`). |
| `VIHS_REVIEWER_BOX` | `vihs/win11-labview2026` | VirtualBox box name. |
| `VIHS_REVIEWER_BOX_VMWARE` | `vihs/labview-cleanroom` | VMware box name. |
| `VIHS_REVIEWER_MEM` | `8192` | Guest memory (MB). |
| `VIHS_REVIEWER_CPUS` | `4` | Guest vCPUs. |
| `VIHS_REVIEWER_REPO` | `LabVIEW-Community-CI-CD/labview-benchmark-actor` | Release source for the `.vsix` + `lbabus`. |
| `VIHS_REVIEWER_EXT_TAG` | `latest` | `ext-v*` tag to install (`latest` = newest gated release). |
| `VIHS_REVIEWER_LBABUS_TAG` | `latest` | `collab-cli-v*` tag to install (`latest` = newest release). |

## What provisioning does

[provision.ps1](provision.ps1) (WinRM, privileged) is additive on top of the golden box:

1. Ensures `code` (VS Code) and `gh` are on `PATH`, winget-installing them when the box lacks
   them (the VirtualBox golden box ships them; the VMware cleanroom box and BYO boxes may not).
2. Downloads and installs the extension `.vsix` from the resolved `ext-v*` Release.
3. Downloads the self-contained `lbabus` (`*win-x64.exe`) from the resolved `collab-cli-v*`
   Release into `C:\lba-bin` and adds it to the machine `PATH`.
4. Creates the `C:\lba-review` scratch workspace.

Re-running is safe (downloads use `--clobber`; installs use `--force`).

## Lane ownership

The `virtualbox` provider block and this README are validated on the **LINUX** lane. The
`vmware_desktop` provider block and the real WinRM run of `provision.ps1` are owned and validated
on the **WIN** lane. See #108.
