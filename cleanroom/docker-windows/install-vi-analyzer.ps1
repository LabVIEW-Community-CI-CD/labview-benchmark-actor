# install-vi-analyzer.ps1 -- install the LabVIEW VI Analyzer Toolkit into the Docker WINDOWS-CONTAINER clean
# room (and, by design, the Vagrant clean room) from the SAME NI offline feed LabVIEW came from.
#
# WHAT THIS DOES (WIN-plane confirmed against the real LabVIEW 2026 community offline ISO + nipkg 26.5.0):
#   * The VI Analyzer toolkit CONTENT ships bundled in LabVIEW **Community** (under <LV>\project\_VI Analyzer);
#     it is present after install-labview.ps1 but UNLICENSED/disabled until the license package is installed.
#   * The sole VI Analyzer package on the community feed is `ni-labview-vi-analyzer-toolkit-lic`
#     (DisplayName "LabVIEW VI Analyzer Toolkit License Files"; Depends ni-license-manager/ni-mdfsupport/
#     ni-metauninstaller -- all on the same feed). The community LabVIEW meta-package does NOT auto-pull it,
#     so it must be installed explicitly. Installing it ENABLES the bundled toolkit.
#
# This mirrors install-labview.ps1 (extracted-feed primary for Hyper-V isolation; corrected nipkg 26.5.0 flags:
# `--system` is feed-add-only; the install flag is `--include-recommended`). Run AFTER install-labview.ps1
# (needs LabVIEW installed + NIPM bootstrapped). Then the labview-icon-editor pattern RUNS VI Analyzer via
# `LabVIEWCLI -OperationName RunVIAnalyzer -ConfigPath <.viancfg> -ReportPath <out> -LabVIEWPath <LabVIEW.exe>`
# -- the same command works here and on the Vagrant clean room once this toolkit is enabled.
#
# Usage:
#   $env:LV_EXTRACTED_FEED = 'C:\lv-feed'   # the LabVIEW offline feed (VI Analyzer is on it); staged host-side
#   ./install-vi-analyzer.ps1 -Version 2026q1
#
# Nothing licensed is committed to the repo -- only the map + this installer; the feed is staged from NI on the
# Windows host (the community VI Analyzer license is free, but the feed artifacts stay gitignored).

[CmdletBinding()]
param(
    [string]$Version = $(if ($env:LV_VERSION) { $env:LV_VERSION } else { '2026q1' }),
    [string]$IsoMap = (Join-Path $PSScriptRoot 'lv-iso-map.json'),
    # VI Analyzer is on the SAME feed as LabVIEW; default to LV_EXTRACTED_FEED, allow a dedicated override.
    [string]$ExtractedFeed = $(if ($env:VIA_EXTRACTED_FEED) { $env:VIA_EXTRACTED_FEED } else { $env:LV_EXTRACTED_FEED }),
    [string]$Package = $null
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 1. Resolve the VI Analyzer nipkg package from the map (version-tolerant), unless one was passed explicitly.
if (-not $Package) {
    if (-not (Test-Path $IsoMap)) { throw "[via-install] iso map not found: $IsoMap" }
    $map = Get-Content -Raw $IsoMap | ConvertFrom-Json
    $entry = $map.versions.$Version.windows
    if (-not $entry) { throw "[via-install] no windows entry for version '$Version' in $IsoMap" }
    $Package = $entry.vi_analyzer_package
}
if (-not $Package) { throw "[via-install] no 'vi_analyzer_package' for '$Version' in $IsoMap (and no -Package)." }
Write-Host "[via-install] version=$Version vi-analyzer package=$Package"

# 2. Locate nipkg. install-labview.ps1 bootstraps NIPM from the ISO (which ships no standalone nipkg.exe), so
#    by the time this runs nipkg exists on PATH or under the NI Package Manager install dir.
$nipkg = (Get-Command nipkg.exe -ErrorAction SilentlyContinue).Source
if (-not $nipkg) {
    $nipkg = @("$env:ProgramFiles\National Instruments\NI Package Manager\nipkg.exe",
               "${env:ProgramFiles(x86)}\National Instruments\NI Package Manager\nipkg.exe") |
        Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $nipkg) { throw "[via-install] nipkg unavailable -- run install-labview.ps1 first (it bootstraps NIPM)." }
Write-Host "[via-install] nipkg: $nipkg"

# 3. Ensure the offline feed carrying VI Analyzer is registered. install-labview.ps1 already adds the LabVIEW
#    feed as 'lv-cleanroom-offline'; re-adding is tolerated (idempotent) so this script also stands alone on a
#    Vagrant clean room that staged only the feed. If the feed is already registered, feed-add is a no-op-ish.
if ($ExtractedFeed -and (Test-Path $ExtractedFeed)) {
    Write-Host "[via-install] ensuring feed registered: $ExtractedFeed"
    try { & $nipkg feed-add --system --name lv-cleanroom-offline $ExtractedFeed 2>&1 | ForEach-Object { Write-Host $_ } } catch { Write-Host "[via-install] feed-add note: $($_.Exception.Message)" }
    & $nipkg update
}
else {
    Write-Host "[via-install] no ExtractedFeed provided; relying on a feed install-labview.ps1 already registered."
}

# 4. Install the VI Analyzer toolkit LICENSE (enables the LabVIEW-Community-bundled toolkit content). Flags
#    corrected vs nipkg 26.5.0: no `--system` on install; the flag is `--include-recommended`.
& $nipkg install --accept-eulas --yes --include-recommended $Package

# 5. Verify: (a) nipkg reports the license package installed (authoritative), and (b) the toolkit content is
#    present in the LabVIEW install -- what `LabVIEWCLI RunVIAnalyzer` needs (informational; content ships with
#    LabVIEW Community, so a miss here means the LabVIEW install itself is incomplete, not this step).
$installed = (& $nipkg list-installed 2>&1 | Select-String -SimpleMatch $Package)
if (-not $installed) { throw "[via-install] VI Analyzer license package '$Package' is not reported installed by nipkg." }

$lvDir = @('C:\Program Files (x86)\National Instruments\LabVIEW 2026',
           'C:\Program Files\National Instruments\LabVIEW 2026') |
    Where-Object { Test-Path $_ } | Select-Object -First 1
$viaContent = $null
if ($lvDir) {
    $viaContent = @((Join-Path $lvDir 'project\_VI Analyzer'),
                    (Join-Path $lvDir 'vi.lib\addons\_VI Analyzer')) |
        Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $viaContent) {
    Write-Host "[via-install] WARN: VI Analyzer content dir not found under $lvDir -- the license installed, but confirm the LabVIEW Community install carries the toolkit content (project\_VI Analyzer)."
}

Write-Host "[via-install] OK -- VI Analyzer toolkit enabled ($Package). content: $viaContent"
Write-Host "[via-install] run it (labview-icon-editor pattern): LabVIEWCLI -OperationName RunVIAnalyzer -ConfigPath <your.viancfg> -ReportPath <out.txt> -ReportSaveType ASCII -LabVIEWPath <LabVIEW.exe> -Headless"
