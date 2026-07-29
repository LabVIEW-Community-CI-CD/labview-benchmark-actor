#Requires -Version 5.1
<#
.SYNOPSIS
  Reviewer-workstation provisioner for labview-benchmark-actor (#108).

.DESCRIPTION
  Repurposes the vi-history-suite golden box `vihs/win11-labview2026` (Windows 11 + LabVIEW 2026 +
  VS Code + Node + git + LabVIEW fixtures). It adds ONLY the labview-benchmark-actor bits:
    1. the extension .vsix, from the gated `ext-v*` GitHub Release;
    2. the `lbabus` CLI (self-contained win-x64) from the `collab-cli-v*` Release;
    3. a scratch workspace so the reviewer can immediately run Write/Show/Check.
  Idempotent-ish and safe to re-run. WIN validates this on real Windows (WinRM).
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Step([string]$m) { Write-Host "[reviewer] $m" }

$repo      = $env:VIHS_REVIEWER_REPO
$extTag    = $env:VIHS_REVIEWER_EXT_TAG
$lbabusTag = $env:VIHS_REVIEWER_LBABUS_TAG
Step "repo=$repo ext-tag=$extTag lbabus-tag=$lbabusTag"

# 0) Prereqs supplied by the golden box.
if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
  throw "VS Code 'code' not on PATH. The golden box vihs/win11-labview2026 should already have it; re-bake or install VS Code."
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI 'gh' not found. Install it (winget install GitHub.cli); the reviewer supplies 'gh auth login' for release download + bus."
}
Step "VS Code: $((code --version)[0]); gh: $((gh --version)[0])"

# Resolve the newest tag with a given prefix, or honor an explicit tag.
function Resolve-Tag([string]$prefix, [string]$tag) {
  if ($tag -and $tag -ne 'latest') { return $tag }
  $t = gh api "repos/$repo/releases" --jq "[.[] | select(.tag_name | startswith(`"$prefix`"))][0].tag_name" 2>$null
  if (-not $t) { throw "No ${prefix}* release found in $repo (has the gated $prefix release been cut yet?)." }
  return $t.Trim()
}

# 1) Extension .vsix from the ext-v* Release.
$extResolved = Resolve-Tag 'ext-v' $extTag
$dir = Join-Path $env:TEMP 'lba-ext'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Step "Downloading extension .vsix from $extResolved"
gh release download $extResolved --repo $repo --pattern '*.vsix' --dir $dir --clobber
$vsix = Get-ChildItem $dir -Filter '*.vsix' | Select-Object -First 1
if (-not $vsix) { throw "No .vsix asset in release $extResolved." }
Step "Installing extension $($vsix.Name)"
code --install-extension $vsix.FullName --force

# 2) lbabus CLI (self-contained win-x64) from the collab-cli Release.
$lbTag  = Resolve-Tag 'collab-cli-v' $lbabusTag
$binDir = 'C:\lba-bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Step "Downloading lbabus from $lbTag"
gh release download $lbTag --repo $repo --pattern '*win-x64.exe' --dir $binDir --clobber
$lbExe = Get-ChildItem $binDir -Filter '*win-x64.exe' | Select-Object -First 1
if ($lbExe) {
  Copy-Item $lbExe.FullName (Join-Path $binDir 'lbabus.exe') -Force
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if ($machinePath -notlike "*$binDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$machinePath;$binDir", 'Machine')
  }
  Step "lbabus installed at $binDir\lbabus.exe (added to Machine PATH)"
} else {
  Step "WARN: no lbabus win-x64 asset in $lbTag; the bus + capabilities commands stay unavailable until installed."
}

# 3) Scratch workspace so the reviewer can open a folder and run Write/Show/Check immediately.
$ws = 'C:\lba-review'
New-Item -ItemType Directory -Force -Path $ws | Out-Null
Set-Content -Path (Join-Path $ws 'README.txt') -Encoding ASCII -Value @'
labview-benchmark-actor reviewer workspace.

1. Open this folder in VS Code (the extension is already installed).
2. Follow docs/testing/reviewer-manual-test-plan.md via the Command Palette
   (Ctrl+Shift+P -> "LabVIEW Benchmark Actor: ...").
3. Bus + capabilities commands need "gh auth login" first (reviewer-supplied).
4. End-to-end LabVIEW (TC-09) uses 32-bit LabVIEW 2026 host-native headless;
   see the golden-box docs.
'@
Step "Scratch workspace at $ws"
Step "DONE. Open VS Code with:  code C:\lba-review  (the extension is installed)."
