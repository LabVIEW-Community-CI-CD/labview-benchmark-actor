# install-labview.ps1 -- install LabVIEW (32-bit) + the LabVIEW CLI into the Docker WINDOWS-CONTAINER clean
# room from an NI offline FEED, resolved through the labview-icon-editor .lv-iso-map.json pattern. CORRECTED
# against the REAL LabVIEW 2026 offline ISO + nipkg 26.5.0 (WIN-plane live validation, PR #62 follow-up):
#   * the ISO ships NO standalone nipkg.exe -- NIPM is BOOTSTRAPPED from the ISO's Install.exe first;
#   * there is NO 'LabVIEW_COM_PKG' package -- the real meta-package is ni-labview-<year>-community-x86;
#   * in-container Mount-DiskImage FAILS under Hyper-V isolation ("A virtual disk support provider for the
#     specified file was not found") -- the Win11-client default -- so a HOST-EXTRACTED feed is the PRIMARY
#     path and Mount-DiskImage is a process-isolation-only fallback;
#   * LabVIEWCLI is a SEPARATE NI product (its own ISO/feed) -- labview-cli=yes installs it too.
#
# Usage (inside the Windows container build, or on a Windows host):
#   # PRIMARY (Hyper-V isolation): stage HOST-extracted offline feeds and point the installer at them:
#   $env:LV_EXTRACTED_FEED     = 'C:\lv-feed'       # the ISO's feeds\ + pool\ + NIPM bootstrap, host-extracted
#   $env:LV_CLI_EXTRACTED_FEED = 'C:\lv-cli-feed'   # the LabVIEW CLI product's extracted feed (labview-cli=yes)
#   ./install-labview.ps1 -Version 2026q1 -Arch x86
#   # FALLBACK (process isolation only, e.g. Windows Server): let it Mount-DiskImage an ISO via LV_ISO_PATH.
#
# Nothing licensed is committed to the repo -- only the map + this installer; feeds/ISOs are staged from NI on
# the Windows host.

[CmdletBinding()]
param(
    [string]$Version = $(if ($env:LV_VERSION) { $env:LV_VERSION } else { '2026q1' }),
    [ValidateSet('x86', 'x64')] [string]$Arch = $(if ($env:LV_ARCH) { $env:LV_ARCH } else { 'x86' }), # x86 = 32-bit
    [string]$IsoMap = (Join-Path $PSScriptRoot 'lv-iso-map.json'),
    [string]$ExtractedFeed = $env:LV_EXTRACTED_FEED,        # host-extracted offline feed dir (PRIMARY under Hyper-V)
    [string]$CliExtractedFeed = $env:LV_CLI_EXTRACTED_FEED, # host-extracted LabVIEW CLI feed dir (labview-cli=yes)
    [string]$IsoPath = $env:LV_ISO_PATH                     # process-isolation fallback: an ISO to Mount-DiskImage
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 1. Resolve the real nipkg META-package names from the map (version-tolerant; NOT a pinned 'LabVIEW_COM_PKG').
if (-not (Test-Path $IsoMap)) { throw "[lv-install] iso map not found: $IsoMap" }
$map = Get-Content -Raw $IsoMap | ConvertFrom-Json
$entry = $map.versions.$Version.windows
if (-not $entry) { throw "[lv-install] no windows entry for version '$Version' in $IsoMap" }
$package = $entry.package
$cliPackage = $entry.cli_package
if (-not $package) { throw "[lv-install] no 'package' (nipkg meta-package) for '$Version'/$Arch in $IsoMap" }
Write-Host "[lv-install] version=$Version arch=$Arch package=$package cli=$cliPackage"

# 2. Resolve the offline FEED directory. PRIMARY = a host-extracted feed (works under Hyper-V isolation).
#    Mount-DiskImage is ONLY a process-isolation fallback: WIN confirmed it throws inside a Hyper-V-isolated
#    container ("A virtual disk support provider for the specified file was not found").
$feedDir = $null
$mounted = $null
if ($ExtractedFeed -and (Test-Path $ExtractedFeed)) {
    $feedDir = $ExtractedFeed
    Write-Host "[lv-install] using host-extracted feed: $feedDir"
}
elseif ($IsoPath -and (Test-Path $IsoPath)) {
    Write-Host "[lv-install] no extracted feed; attempting Mount-DiskImage (process-isolation only) ..."
    try {
        $mounted = Mount-DiskImage -ImagePath $IsoPath -PassThru
        $feedDir = ($mounted | Get-Volume).DriveLetter + ':'
    }
    catch {
        throw "[lv-install] Mount-DiskImage failed ($($_.Exception.Message)). Under Hyper-V isolation the disk-image provider is absent in-container -- set LV_EXTRACTED_FEED to a HOST-extracted offline feed (feeds\ + pool\ + NIPM bootstrap) instead."
    }
}
else {
    throw "[lv-install] provide LV_EXTRACTED_FEED (host-extracted offline feed -- REQUIRED under Hyper-V isolation) or LV_ISO_PATH (process-isolation fallback)."
}

try {
    # 3. Ensure NIPM (nipkg) exists -- the ISO ships NO standalone nipkg.exe; it is bootstrapped by the ISO's
    #    Install.exe / the ni-package-manager packages. Reuse nipkg if already on PATH.
    $nipkg = (Get-Command nipkg.exe -ErrorAction SilentlyContinue).Source
    if (-not $nipkg) {
        $bootstrap = @((Join-Path $feedDir 'Install.exe'), (Join-Path $feedDir 'bin\Install.exe')) |
            Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($bootstrap) {
            Write-Host "[lv-install] bootstrapping NI Package Manager via $bootstrap (passive) ..."
            & $bootstrap --passive --accept-eulas --prevent-reboot
        }
        $nipkg = (Get-Command nipkg.exe -ErrorAction SilentlyContinue).Source
        if (-not $nipkg) {
            $nipkg = @("$env:ProgramFiles\National Instruments\NI Package Manager\nipkg.exe",
                       "${env:ProgramFiles(x86)}\National Instruments\NI Package Manager\nipkg.exe") |
                Where-Object { Test-Path $_ } | Select-Object -First 1
        }
    }
    if (-not $nipkg) { throw "[lv-install] nipkg unavailable after NIPM bootstrap -- add the ni-package-manager packages to the staged feed or run the ISO Install.exe." }
    Write-Host "[lv-install] nipkg: $nipkg"

    # 4. Add the offline feed + install the LabVIEW 32-bit meta-package. Flags CORRECTED vs nipkg 26.5.0
    #    (WIN-confirmed): --system is feed-add-only (NOT valid on install/update); the flag is
    #    --include-recommended (not --include-recommends).
    & $nipkg feed-add --system --name lv-cleanroom-offline $feedDir
    & $nipkg update
    & $nipkg install --accept-eulas --yes --include-recommended $package

    # 5. LabVIEWCLI is a SEPARATE product -> install it too for the labview-cli=yes parity goal (its own feed).
    if ($cliPackage -and $CliExtractedFeed -and (Test-Path $CliExtractedFeed)) {
        & $nipkg feed-add --system --name lv-cli-cleanroom-offline $CliExtractedFeed
        & $nipkg update
        & $nipkg install --accept-eulas --yes --include-recommended $cliPackage
    }
    elseif ($cliPackage) {
        Write-Host "[lv-install] WARN: LV_CLI_EXTRACTED_FEED not set -- LabVIEWCLI ($cliPackage) is a separate NI product; labview-cli=yes needs its feed staged too."
    }
}
finally {
    if ($mounted) { Dismount-DiskImage -ImagePath $IsoPath | Out-Null }
}

# 6. Prove LabVIEW is present: LabVIEWCLI on PATH (the clean-room labview-cli capability) or a known install dir.
$lvcli = (Get-Command LabVIEWCLI.exe -ErrorAction SilentlyContinue).Source
$lvDir = @(
    'C:\Program Files (x86)\National Instruments\LabVIEW 2026',
    'C:\Program Files\National Instruments\LabVIEW 2026'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $lvcli -and -not $lvDir) {
    throw "[lv-install] LabVIEW install not verified (no LabVIEWCLI on PATH and no LabVIEW 2026 install dir)."
}
Write-Host "[lv-install] OK -- LabVIEW $Version ($Arch) installed. CLI: $lvcli; dir: $lvDir"
