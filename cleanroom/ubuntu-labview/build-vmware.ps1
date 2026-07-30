#!/usr/bin/env pwsh
<#
.SYNOPSIS
  From-scratch VMware Workstation builder for the Ubuntu 24.04 + LabVIEW 2026 Community clean room (WIN plane).

.DESCRIPTION
  The WIN/VMware MIRROR of build-virtualbox.sh. Reproduces — from NOTHING but the stock public Ubuntu 24.04
  ISO — the operator's working VM `lba-ubuntu2404-labview2026` (Ubuntu 24.04 LTS, BIOS, 12 GB / 6 vCPU,
  128 MB VRAM, SATA-AHCI system disk, NAT). Nothing pre-built is distributed: the user supplies the stock
  Ubuntu ISO; this script creates the VM + drives an unattended Ubuntu install (cloud-init NoCloud seed) +
  installs open-vm-tools. LabVIEW 2026 Community is then installed IN the guest by the SAME provision-guest.sh
  (UNACTIVATED); ACTIVATION is the operator's step.

  PARITY CONTRACT: same guest spec + the same provision-guest.sh as the VirtualBox reference. Only the
  hypervisor-creation step and the guest-tools package differ (open-vm-tools here vs virtualbox-guest-utils
  there). The unattended install is driven by a NoCloud "cidata" seed ISO that subiquity AUTO-DETECTS (no
  kernel arg, no ISO remaster, no Easy Install) - the VMware equivalent of VBoxManage unattended. (Proven:
  the actor guest built + booted Ubuntu 24.04.4 this way; the desktop installer's one-time Review->Install
  confirm is the sole manual touch, and only for the golden VM - mesh clones come from vagrant package.)

.NOTES
  SAFE BY DEFAULT: prints the exact commands (dry-run). Pass -Run to execute. Refuses to touch an existing VM
  of the same name unless -Force (so it never clobbers the operator's real VM). Guest spec matches the
  operator's VM; snapshot workflow labview2026-installed-preactivation -> labview2026-activated-ready.
  Activation (NI-account sign-in) is NEVER automated here.
#>
[CmdletBinding()]
param(
  [switch]$Run,
  [switch]$Force,
  [ValidateSet('headless', 'gui', 'none')]
  [string]$StartMode    = $(if ($env:START_MODE)     { $env:START_MODE }     else { 'headless' }),
  [string]$VMName       = $(if ($env:VM_NAME)        { $env:VM_NAME }        else { 'lba-ubuntu2404-labview2026-scratch' }),
  [string]$Iso          = $env:ISO,                  # path to the stock Ubuntu 24.04 ISO (you download it; required for -Run)
  [int]   $DiskGB       = $(if ($env:DISK_GB)        { [int]$env:DISK_GB }   else { 80 }),
  [int]   $MemMB        = $(if ($env:MEM_MB)         { [int]$env:MEM_MB }    else { 12288 }),   # matches the operator's working VM
  [int]   $Cpus         = $(if ($env:CPUS)           { [int]$env:CPUS }      else { 6 }),
  [int]   $VramMB       = $(if ($env:VRAM_MB)        { [int]$env:VRAM_MB }   else { 128 }),
  [string]$BaseFolder   = $(if ($env:BASEFOLDER)     { $env:BASEFOLDER }     else { Join-Path $HOME 'VMware VMs' }),
  [string]$GuestUser    = $(if ($env:GUEST_USER)     { $env:GUEST_USER }     else { 'actor' }),
  [string]$GuestFullName= $(if ($env:GUEST_FULLNAME) { $env:GUEST_FULLNAME } else { 'actor' })
)

$ErrorActionPreference = 'Stop'
$DryRun = -not $Run

function Write-Step {
  param([string]$Display, [scriptblock]$Action)
  if ($DryRun) { Write-Host "  [dry-run] $Display" }
  else         { Write-Host "  + $Display"; & $Action }
}

# --- Locate VMware tooling (allow override via VMWARE_DIR) ---------------------------------------------
$vmwareDirs = @(
  $env:VMWARE_DIR,
  'C:\Program Files (x86)\VMware\VMware Workstation',
  'C:\Program Files\VMware\VMware Workstation'
) | Where-Object { $_ -and (Test-Path $_) }

$vmrun = $null; $vdisk = $null; $mkisofs = $null
foreach ($d in $vmwareDirs) {
  if (-not $vmrun   -and (Test-Path (Join-Path $d 'vmrun.exe')))               { $vmrun   = Join-Path $d 'vmrun.exe' }
  if (-not $vdisk   -and (Test-Path (Join-Path $d 'vmware-vdiskmanager.exe'))) { $vdisk   = Join-Path $d 'vmware-vdiskmanager.exe' }
  if (-not $mkisofs -and (Test-Path (Join-Path $d 'mkisofs.exe')))            { $mkisofs = Join-Path $d 'mkisofs.exe' }
}
if (-not $vmrun) { Write-Error '[abort] vmrun.exe not found - install VMware Workstation (or set VMWARE_DIR).'; exit 1 }
if (-not $vdisk) { Write-Error '[abort] vmware-vdiskmanager.exe not found - install VMware Workstation (or set VMWARE_DIR).'; exit 1 }

# ISO-builder for the NoCloud seed: prefer VMware's bundled mkisofs, else oscdimg/mkisofs/genisoimage on PATH.
if (-not $mkisofs) {
  foreach ($tool in 'oscdimg.exe', 'mkisofs.exe', 'genisoimage.exe') {
    $c = Get-Command $tool -ErrorAction SilentlyContinue
    if ($c) { $mkisofs = $c.Source; break }
  }
}

# openssl (for the SHA-512 crypt of the local dev-only guest password) - VMware/git usually ships one.
$openssl = (Get-Command openssl.exe -ErrorAction SilentlyContinue).Source
if (-not $openssl) {
  foreach ($cand in 'C:\Program Files\Git\usr\bin\openssl.exe', 'C:\Program Files (x86)\Git\usr\bin\openssl.exe') {
    if (Test-Path $cand) { $openssl = $cand; break }
  }
}

# --- Safety: never clobber the operator's real VM (or any existing VM of this name) --------------------
$vmDir  = Join-Path $BaseFolder $VMName
$vmx    = Join-Path $vmDir "$VMName.vmx"
$disk   = Join-Path $vmDir "$VMName.vmdk"
$seedIso= Join-Path $vmDir 'seed-cidata.iso'

if (Test-Path $vmDir) {
  if ($Force) { Write-Host "[warn] VM folder '$vmDir' exists - -Force given, continuing." }
  else        { Write-Error "[abort] VM folder '$vmDir' already exists. Choose a new -VMName or pass -Force."; exit 1 }
}

if ($Run) {
  if (-not $Iso)              { Write-Error '[abort] -Run needs -Iso <stock ubuntu-24.04-*.iso> (the ISO you download).'; exit 1 }
  if (-not (Test-Path $Iso)) { Write-Error "[abort] ISO not found: $Iso"; exit 1 }
}

$vramBytes = $VramMB * 1MB

Write-Host "== From-scratch VMware build: $VMName =="
Write-Host "   ubuntu-64 | $MemMB MB RAM | $Cpus vCPU | $VramMB MB VRAM | $DiskGB GB SATA-AHCI | NAT | BIOS"
Write-Host ("   tooling: vmrun={0}; vdiskmanager={1}; iso-builder={2}; openssl={3}" -f `
  (Split-Path $vmrun -Leaf), (Split-Path $vdisk -Leaf), $(if ($mkisofs) { Split-Path $mkisofs -Leaf } else { 'NONE' }), $(if ($openssl) { 'yes' } else { 'no' }))
if ($DryRun) { Write-Host '   (dry-run - printing commands only; pass -Run to execute)' }
Write-Host ''

# 1) VM folder.
Write-Step "New-Item -ItemType Directory '$vmDir'" { New-Item -ItemType Directory -Force -Path $vmDir | Out-Null }

# 2) System disk - SATA/AHCI growable monolithic sparse (matches the VBox IntelAhci disk).
Write-Step "$([IO.Path]::GetFileName($vdisk)) -c -s ${DiskGB}GB -a lsilogic -t 0 `"$disk`"" {
  & $vdisk -c -s "${DiskGB}GB" -a lsilogic -t 0 $disk | Out-Null
}

# 3) NoCloud cloud-init seed (unattended Ubuntu 24.04 install + open-vm-tools). The local dev-only guest
#    credential is hashed (openssl passwd -6) so no plaintext lands in the seed; falls back to a marked
#    placeholder if openssl is unavailable (operator supplies the hash or uses Easy Install / manual).
$plainPw = if ($env:GUEST_PASSWORD) { $env:GUEST_PASSWORD } else { 'labview' }
$pwHash  = '<<SET-VIA: openssl passwd -6>>'
if ($openssl) {
  try { $pwHash = (& $openssl passwd -6 $plainPw).Trim() } catch { Write-Host "[warn] openssl hash failed: $_" }
}
$userData = @"
#cloud-config
autoinstall:
  version: 1
  locale: en_US.UTF-8
  keyboard: { layout: us }
  identity:
    hostname: $VMName
    realname: "$GuestFullName"
    username: $GuestUser
    password: "$pwHash"
  ssh:
    install-server: true
    allow-pw: true
  packages:
    - open-vm-tools
  late-commands:
    - curtin in-target --target=/target -- systemctl enable open-vm-tools || true
"@
$metaData = "instance-id: $VMName`nlocal-hostname: $VMName`n"

$seedDir = Join-Path $vmDir '_seed'
Write-Step "write NoCloud seed (user-data + meta-data) to '$seedDir'" {
  New-Item -ItemType Directory -Force -Path $seedDir | Out-Null
  # LF line endings; cloud-init is strict about that.
  [IO.File]::WriteAllText((Join-Path $seedDir 'user-data'), ($userData -replace "`r`n", "`n"))
  [IO.File]::WriteAllText((Join-Path $seedDir 'meta-data'), ($metaData -replace "`r`n", "`n"))
}

if ($mkisofs) {
  $leaf = Split-Path $mkisofs -Leaf
  if ($leaf -ieq 'oscdimg.exe') {
    Write-Step "oscdimg -lCIDATA `"$seedDir`" `"$seedIso`"" { & $mkisofs -lCIDATA $seedDir $seedIso | Out-Null }
  } else {
    Write-Step "$leaf -o `"$seedIso`" -V CIDATA -J -R `"$seedDir`"" { & $mkisofs -o $seedIso -V CIDATA -J -R $seedDir | Out-Null }
  }
} else {
  Write-Host "  [note] no ISO builder found - seed written to '$seedDir' but NOT packed into $seedIso."
  Write-Host "         Build it with any of:  oscdimg -lCIDATA `"$seedDir`" `"$seedIso`""
  Write-Host "                                mkisofs -o `"$seedIso`" -V CIDATA -J -R `"$seedDir`""
  Write-Host "         (label the volume CIDATA so subiquity auto-detects it)."
}

# 4) Write the .vmx - matched hardware profile (BIOS, 6 vCPU / 12 GB, 128 MB svga, SATA-AHCI, IDE optical, NAT).
$vmxText = @"
.encoding = "UTF-8"
config.version = "8"
virtualHW.version = "21"
displayName = "$VMName"
guestOS = "ubuntu-64"
firmware = "bios"
memsize = "$MemMB"
numvcpus = "$Cpus"
cpuid.coresPerSocket = "$Cpus"
svga.present = "TRUE"
svga.vramSize = "$vramBytes"
mks.enable3d = "FALSE"
# System disk on SATA (VMware SATA == AHCI, mirrors the VBox IntelAhci controller).
sata0.present = "TRUE"
sata0:0.present = "TRUE"
sata0:0.fileName = "$VMName.vmdk"
sata0:0.deviceType = "disk"
# Install ISO on IDE optical (mirrors the VBox PIIX4 IDE optical; ejected after install).
ide1:0.present = "TRUE"
ide1:0.deviceType = "cdrom-image"
ide1:0.fileName = "$Iso"
ide1:0.startConnected = "TRUE"
# NoCloud seed on a second IDE optical (labelled CIDATA; cloud-init reads it for the unattended install).
ide1:1.present = "TRUE"
ide1:1.deviceType = "cdrom-image"
ide1:1.fileName = "seed-cidata.iso"
ide1:1.startConnected = "TRUE"
# NAT networking (NIC1 NAT, matches the VBox reference). e1000 (PCI), NOT e1000e (PCIe): a hand-written
# minimal vmx has no PCIe root-port bridge, so an e1000e NIC finds no PCIe slot and CRASHES vmware-vmx
# (msg.pci.noslotavail). e1000 is a plain PCI device and just works. (Proven on VMware Workstation 25.)
ethernet0.present = "TRUE"
ethernet0.connectionType = "nat"
ethernet0.virtualDev = "e1000"
ethernet0.addressType = "generated"
# Minimal, headless-friendly.
usb.present = "FALSE"
usb_xhci.present = "FALSE"
sound.present = "FALSE"
tools.syncTime = "TRUE"
rtc.diffFromUTC = "0"
# Auto-answer the first-boot moved/copied (uuid) dialog so a scripted start never blocks on it.
msg.autoAnswer = "TRUE"
uuid.action = "create"
"@
Write-Step "write .vmx -> '$vmx'" { [IO.File]::WriteAllText($vmx, ($vmxText -replace "`r`n", "`n")) }

# 5) Boot into the installer (unless -StartMode none).
if ($StartMode -ne 'none') {
  $gui = if ($StartMode -eq 'gui') { 'gui' } else { 'nogui' }
  Write-Step "vmrun -T ws start `"$vmx`" $gui" { & $vmrun -T ws start $vmx $gui }
} else {
  Write-Host "  [note] -StartMode none: VM created but not started."
}

# --- Next steps (identical to the VBox reference) -----------------------------------------------------
@"

Next (matches the operator's real snapshot workflow):
  1) The CIDATA seed built above is AUTO-DETECTED by subiquity (NoCloud "cidata" volume label) - no kernel
     arg, no ISO remaster, no Easy Install. GRUB auto-boots the stock ISO and the unattended Ubuntu 24.04 +
     open-vm-tools install runs. NOTE: the DESKTOP installer shows one "Review your choices -> Install"
     confirm - a single click, ONCE, for this golden VM only (mesh clones come from vagrant package, not a
     re-install). Readiness = vmrun getGuestIPAddress returns an IP (open-vm-tools up).
  2) After the guest reboots, copy provision-guest.sh + its bundled NI keyring (ni-labview-2026-noble-
     community.asc) into the guest and install LabVIEW 2026 Community (UNACTIVATED) - the SAME script both
     planes use, now with NO args (the NI apt repo + public keyring are baked in):
       sudo ./provision-guest.sh
  3) Snapshot the clean pre-activation state:
       vmrun -T ws snapshot "$vmx" labview2026-installed-preactivation
  4) OPERATOR activates LabVIEW Community (NI sign-in), then snapshot the activated state:
       vmrun -T ws snapshot "$vmx" labview2026-activated-ready
     WIN then flags the operator "ready for activation" once the VM boots green + provision-guest.sh runs.

This mirrors build-virtualbox.sh 1:1 - same guest spec + the SAME provision-guest.sh; only the creation
step + guest-tools package (open-vm-tools vs virtualbox-guest-utils) differ. Downstream meshing (Vagrant)
is unchanged: package the activated VM into a self-contained box and mesh N copies (see README.md).
"@ | Write-Host
