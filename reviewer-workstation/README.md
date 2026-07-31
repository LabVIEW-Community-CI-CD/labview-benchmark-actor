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

## Stage a LOCAL candidate (pre-publish last gate)

`provision.ps1` installs a **published** `ext-v*` release. To review the **pre-publish candidate**
built from the current working tree — so a human is the last gate **before** anything reaches the
VS Code Marketplace — use [stage-local-vsix.ps1](stage-local-vsix.ps1) against an already-running VM:

```powershell
# VM already up (vagrant up ...), then from the repo root on the host:
pwsh -File reviewer-workstation/stage-local-vsix.ps1
# or install a prebuilt .vsix without rebuilding:
pwsh -File reviewer-workstation/stage-local-vsix.ps1 -SkipBuild -Vsix .\labview-benchmark-actor.vsix
```

It builds + packages the candidate (`npm test` + `vsce package`), **guards the `.vsix` size** (a fat
`.vsix` means `.vscodeignore` leaked non-runtime content such as the VM disk under `.vagrant/`),
`vagrant upload`s it, installs it with `code --install-extension --force`, verifies the `id@version`
by listing extensions, and drops `C:\lba-review\REVIEW-CHECKLIST.txt` for the reviewer. Then open VS
Code in the VM and inspect the Extensions-view README page (the Marketplace listing), the command
surface, and the benchmark viewer. Nothing is published until the reviewer approves.

## Drive it from a Copilot agent (in the VM)

Once the extension is installed in the VM, open VS Code there. The **Get started with LabVIEW Benchmark
Actor** walkthrough opens automatically (or: `Ctrl+Shift+P` → `Welcome: Open Walkthrough...`), and every
panel is under `Ctrl+Shift+P` → `LabVIEW Benchmark Actor: Open ...`.

To review it the **agentic** way, open **Copilot Chat → Agent** mode in the VM and paste:

> Use the LabVIEW Benchmark Actor tools: call #lbaBenchmarkSummary to summarize the captured benchmark
> numbers, then use #lbaBenchmarkPanel to open the trend, the frame correlator, and the cross-plane
> resource agreement panels, and explain what each one shows.

The agent calls the extension's language-model tools — `lba-benchmark-summary` (the real launchMs / trend /
cross-plane / resource numbers) and `lba-open-benchmark-panel` (opens `run` | `trend` | `frameCorrelator` |
`crossPlaneTrend` | `resourceProfile` | `crossPlaneResource`) — so the panels open and the agent explains
them without any menu hunting.

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
2. Downloads and installs the extension `.vsix` from the resolved `ext-v*` Release **into the
   interactive console user's VS Code profile** (resolved from its SID), so the human reviewer — who
   logs in interactively, not as the WinRM `vagrant` provisioning user — actually sees it (#121).
3. Downloads the self-contained `lbabus` (`*win-x64.exe`) from the resolved `collab-cli-v*`
   Release into `C:\lba-bin` and adds it to the machine `PATH`.
4. Creates the `C:\lba-review` scratch workspace.

Re-running is safe (downloads use `--clobber`; installs use `--force`).

## Lane ownership

The `virtualbox` provider block and this README are validated on the **LINUX** lane. The
`vmware_desktop` provider block and the real WinRM run of `provision.ps1` are owned and validated
on the **WIN** lane. See #108.
