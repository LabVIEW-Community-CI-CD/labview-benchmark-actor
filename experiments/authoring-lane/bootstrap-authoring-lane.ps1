<#
.SYNOPSIS
  Bootstrap the LabVIEW AUTHORING LANE on Windows: clone CalmyJane/labview_assistant, install its DQMH
  dependency via VIPM, and build its VI Package from the .vipb -- the authoring-lane subject-under-test the
  benchmark exercises.

.DESCRIPTION
  WINDOWS ONLY. labview_assistant drives the LabVIEW IDE through ActiveX (a Windows-only automation surface),
  so this whole lane runs on a Windows cleanroom, NOT on the Linux host. It is bootstrapped into the VS Code
  extension (labviewBenchmarkActor.bootstrapAuthoringLane) so it can be run against a Windows cleanroom later.

  Grounded facts baked in:
    - labview_assistant heavily uses DQMH (Delacor_lib_QMH_* VIs) as a LOAD-TIME dependency. The build spec
      "AI Assistant for LabVIEW.vipb" declares NO <Package_Dependencies>, so DQMH must be installed separately:
      the core toolkit package is `delacor_lib_dqmh_toolkit` (pulls in delacor_lib_qmh runtime classes).
    - The .vipb has <Community_Edition>true</Community_Edition>, so `vipm build` needs VIPM Community (or Pro).
      Community build/publish is licensed only inside a PUBLIC repo -- labview_assistant IS public, so it's OK.
    - The .vipb targets <Package_LabVIEW_Version>25.1 (64-bit)</Package_LabVIEW_Version>; a newer LabVIEW
      (e.g. 2026) can build it, but VIPM must have that LabVIEW registered.
    - The .vipb's <Library_Source_Folder> is "VI Package", which is NOT committed in the repo. If it's missing,
      the build has no source; this script WARNS and points at LabVIEW_Server (the actual project) so the
      operator can repoint Library_Source_Folder (the .vipb is plain XML) during Windows testing.

.NOTES
  Requires on the Windows target: git, LabVIEW (>= the .vipb target), and VIPM installed + Community-activated
  (`vipm about` -> Edition: Community). Credentials are never handled here.
#>
[CmdletBinding()]
param(
  [string]$WorkDir     = "$HOME\lba-authoring-lane",
  [string]$RepoUrl     = 'https://github.com/CalmyJane/labview_assistant',
  [string]$DqmhPackage = 'delacor_lib_dqmh_toolkit',
  [string]$VipbName    = 'AI Assistant for LabVIEW.vipb',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
function Log($m) { Write-Host "[authoring-lane] $m" }

# --- 1) Preflight: Windows + toolchain -------------------------------------------------------------------
if (-not ($IsWindows -or $env:OS -eq 'Windows_NT')) {
  Write-Error 'The LabVIEW authoring lane is WINDOWS ONLY (labview_assistant drives LabVIEW via ActiveX). Run this on a Windows cleanroom.'
  exit 2
}
foreach ($tool in 'git', 'vipm') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Write-Error "Required tool '$tool' not found on PATH. Install it on the Windows cleanroom first."
    exit 3
  }
}
Log 'checking VIPM edition (Community/Pro required for the Community_Edition build spec)...'
$about = (& vipm about) 2>&1 | Out-String
$edition = ([regex]::Match($about, 'Edition:\s*(\w+)')).Groups[1].Value
Log "VIPM edition = '$edition'"
if ($edition -notmatch '^(Community|Professional|Enterprise)$') {
  Write-Warning "VIPM edition is '$edition'. The .vipb is Community_Edition=true; `vipm build` needs Community (in a public repo) or Professional. Activate VIPM before building."
}

# --- 2) Clone labview_assistant --------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$repoDir = Join-Path $WorkDir 'labview_assistant'
if (Test-Path (Join-Path $repoDir '.git')) {
  Log "repo already present at $repoDir -- pulling latest"
  git -C $repoDir pull --ff-only
} else {
  Log "cloning $RepoUrl -> $repoDir"
  git clone --depth 1 $RepoUrl $repoDir
}

# --- 3) Install the DQMH dependency (load-time; not declared in the .vipb) --------------------------------
Log "installing DQMH dependency '$DqmhPackage' via VIPM (launches LabVIEW to install the palette/VIs)..."
& vipm install $DqmhPackage
if ($LASTEXITCODE -ne 0) { Write-Error "vipm install $DqmhPackage failed (exit $LASTEXITCODE)."; exit 4 }
Log 'DQMH installed.'

# --- 4) Build the VI Package from the .vipb --------------------------------------------------------------
$vipb = Join-Path $repoDir $VipbName
if (-not (Test-Path $vipb)) { Write-Error "Build spec not found: $vipb"; exit 5 }

# The .vipb source folder must exist for the build to have inputs.
[xml]$vipbXml = Get-Content -LiteralPath $vipb
$srcFolder = $vipbXml.VI_Package_Builder_Settings.Library_General_Settings.Library_Source_Folder
$srcPath = Join-Path $repoDir $srcFolder
if (-not (Test-Path $srcPath)) {
  Write-Warning "The .vipb Library_Source_Folder '$srcFolder' is MISSING in the repo. The build has no source. The actual project is 'LabVIEW_Server' -- repoint <Library_Source_Folder> in the .vipb (it is plain XML) to LabVIEW_Server (or the curated subset) before building on the Windows cleanroom."
}

if ($SkipBuild) { Log 'SkipBuild set -- stopping before `vipm build` (dependency ready, build deferred).'; exit 0 }

Log "building '$VipbName' with VIPM (Community_Edition build; public repo required)..."
& vipm build $vipb
if ($LASTEXITCODE -ne 0) { Write-Error "vipm build failed (exit $LASTEXITCODE). Common causes: missing source folder, LabVIEW version mismatch, or unactivated VIPM."; exit 6 }

$outDir = Join-Path $repoDir ($vipbXml.VI_Package_Builder_Settings.Library_General_Settings.Library_Output_Folder)
$vip = Get-ChildItem -Path $outDir -Filter *.vip -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($vip) { Log "OK: built VI Package -> $($vip.FullName)" } else { Log 'build reported success but no .vip found under the output folder.' }
Log 'authoring-lane bootstrap complete.'
