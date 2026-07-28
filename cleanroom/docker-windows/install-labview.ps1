# install-labview.ps1 -- install LabVIEW (32-bit by default) into the Docker WINDOWS-CONTAINER clean room from
# an NI offline ISO, resolved through the labview-icon-editor .lv-iso-map.json pattern (lv-iso-map.json here).
#
# This is the EXPANSION over the Vagrant clean room: the Vagrant lane inherits LabVIEW from a pre-baked licensed
# base box, whereas the Docker Windows-container lane INSTALLS LabVIEW into the image from the ISO map. Windows
# hosts only (a Windows-container engine + a Windows base image are required).
#
# Usage (inside the Windows container build, or standalone on a Windows host):
#   ./install-labview.ps1 -Version 2026q1 -Arch x86            # LabVIEW 2026 Community, 32-bit (x86)
#   $env:LV_ISO_PATH = 'C:\iso\ni-labview-2026-community-x86.iso'; ./install-labview.ps1   # offline/licensed ISO
#
# The ISO is a licensed/community artifact obtained FROM NI at build time (download per the map, or an
# operator-supplied LV_ISO_PATH). Nothing licensed is committed to the repo -- only the map + this installer.

[CmdletBinding()]
param(
    [string]$Version = $(if ($env:LV_VERSION) { $env:LV_VERSION } else { '2026q1' }),
    [ValidateSet('x86', 'x64')] [string]$Arch = $(if ($env:LV_ARCH) { $env:LV_ARCH } else { 'x86' }), # x86 = 32-bit
    [string]$IsoMap = (Join-Path $PSScriptRoot 'lv-iso-map.json'),
    [string]$IsoPath = $env:LV_ISO_PATH   # optional pre-supplied (offline/licensed) ISO; else downloaded from the map
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 1. Resolve the ISO URL + NIPM package id from the map (ni/labview-icon-editor .lv-iso-map.json shape).
if (-not (Test-Path $IsoMap)) { throw "[lv-install] iso map not found: $IsoMap" }
$map = Get-Content -Raw $IsoMap | ConvertFrom-Json
$entry = $map.versions.$Version.windows
if (-not $entry) { throw "[lv-install] no windows entry for version '$Version' in $IsoMap" }
$isoUrl = $entry.$Arch
$packageId = $entry.package_id
if (-not $isoUrl) { throw "[lv-install] no '$Arch' ISO for version '$Version' (x86 = 32-bit) in $IsoMap" }
Write-Host "[lv-install] version=$Version arch=$Arch package='$packageId'"
Write-Host "[lv-install] iso=$isoUrl"

# 2. Obtain the ISO: prefer an operator-supplied local ISO (offline / licensed); else download from the map URL.
if (-not $IsoPath) {
    $IsoPath = Join-Path 'C:\lv-iso' "$Version-$Arch.iso"
    New-Item -ItemType Directory -Force (Split-Path $IsoPath) | Out-Null
    if (-not (Test-Path $IsoPath)) {
        Write-Host "[lv-install] downloading ISO from NI ..."
        Invoke-WebRequest -UseBasicParsing $isoUrl -OutFile $IsoPath
    }
}
if (-not (Test-Path $IsoPath)) { throw "[lv-install] ISO not available at $IsoPath" }

# 3. Mount the ISO and locate its NIPM feed / installer (Windows-container hosts support Mount-DiskImage on the
#    process-isolation engine; on hyperV-isolation prefer an extracted ISO via 7-Zip -- see README).
Write-Host "[lv-install] mounting $IsoPath ..."
$image = Mount-DiskImage -ImagePath $IsoPath -PassThru
try {
    $drive = ($image | Get-Volume).DriveLetter + ':'
    Write-Host "[lv-install] ISO mounted at $drive"

    # 4. Headless install of the 32-bit LabVIEW package. NI offline ISOs ship NI Package Manager (nipkg) + an
    #    Install.exe bootstrapper. Prefer nipkg feed-add + install (deterministic, package-id targeted); fall
    #    back to the ISO Install.exe with silent flags. WIN validates the exact flags against the real ISO.
    $nipkg = Get-Command nipkg.exe -ErrorAction SilentlyContinue
    if (-not $nipkg -and (Test-Path "$drive\nipkg.exe")) { $nipkg = "$drive\nipkg.exe" }
    if ($nipkg) {
        $feed = if (Test-Path "$drive\feeds") { "$drive\feeds" } else { $drive }
        Write-Host "[lv-install] nipkg feed-add $feed + install '$packageId' (32-bit) ..."
        & $nipkg feed-add --system --name lv-cleanroom-offline $feed
        & $nipkg update --system
        & $nipkg install --system --accept-eulas --yes --include-recommends $packageId
    }
    elseif (Test-Path "$drive\Install.exe") {
        Write-Host "[lv-install] running $drive\Install.exe (passive, no reboot) ..."
        & "$drive\Install.exe" --passive --accept-eulas --prevent-reboot
    }
    else {
        throw "[lv-install] neither nipkg nor Install.exe found on the ISO at $drive"
    }
}
finally {
    Write-Host "[lv-install] dismounting $IsoPath ..."
    Dismount-DiskImage -ImagePath $IsoPath | Out-Null
}

# 5. Prove LabVIEW is present: LabVIEWCLI on PATH (the clean-room labview-cli capability) or a known install dir.
$lvcli = Get-Command LabVIEWCLI.exe -ErrorAction SilentlyContinue
$lvDir = @(
    'C:\Program Files (x86)\National Instruments\LabVIEW 2026',
    'C:\Program Files\National Instruments\LabVIEW 2026'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $lvcli -and -not $lvDir) {
    throw "[lv-install] LabVIEW install not verified (no LabVIEWCLI on PATH and no LabVIEW 2026 install dir)."
}
Write-Host "[lv-install] OK -- LabVIEW $Version ($Arch) installed. CLI: $($lvcli.Source); dir: $lvDir"
