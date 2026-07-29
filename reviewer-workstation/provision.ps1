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

# 0) Prereqs. The VirtualBox golden box (vihs/win11-labview2026) ships VS Code + gh, but the VMware
#    cleanroom box (vihs/labview-cleanroom) and BYO reviewer boxes may ship NEITHER the tools NOR winget
#    (confirmed live: the cleanroom box has no `code` and no App Installer/winget). So self-install with a
#    winget-free direct download from the official vendor URLs, falling back to winget only if present.
function Refresh-MachinePath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}
function Install-VSCodeDirect {
  $exe = Join-Path $env:TEMP 'vscode-system-setup.exe'
  Step "Downloading VS Code system installer (update.code.visualstudio.com)"
  Invoke-WebRequest -Uri 'https://update.code.visualstudio.com/latest/win32-x64/stable' -OutFile $exe -UseBasicParsing
  Step "Installing VS Code silently"
  $p = Start-Process -FilePath $exe -ArgumentList '/VERYSILENT','/NORESTART','/MERGETASKS=!runcode,addtopath' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "VS Code installer exited $($p.ExitCode)." }
}
function Install-GhDirect {
  Step "Resolving latest GitHub CLI Windows msi"
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/cli/cli/releases/latest' -Headers @{ 'User-Agent' = 'lba-reviewer' }
  $asset = $rel.assets | Where-Object { $_.name -like '*windows_amd64.msi' } | Select-Object -First 1
  if (-not $asset) { throw "No windows_amd64.msi asset in the cli/cli latest release." }
  $msi = Join-Path $env:TEMP $asset.name
  Step "Downloading $($asset.name)"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $msi -UseBasicParsing
  Step "Installing GitHub CLI silently"
  $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i',"`"$msi`"",'/quiet','/norestart' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "gh msi exited $($p.ExitCode)." }
}
function Ensure-Tool([string]$Command, [string]$WingetId, [string]$Label, [scriptblock]$DirectInstall) {
  if (Get-Command $Command -ErrorAction SilentlyContinue) { return }
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Step "Installing $Label via winget ($WingetId)"
    winget install --id $WingetId --exact --source winget --accept-package-agreements --accept-source-agreements --silent
  } else {
    Step "winget unavailable; installing $Label via direct download"
    & $DirectInstall
  }
  Refresh-MachinePath
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "$Label install did not put '$Command' on PATH. Inspect the install output and re-run."
  }
}
Ensure-Tool 'code' 'Microsoft.VisualStudioCode' 'VS Code'    { Install-VSCodeDirect }
Ensure-Tool 'gh'   'GitHub.cli'                 'GitHub CLI' { Install-GhDirect }
Step "VS Code: $((code --version)[0]); gh: $((gh --version)[0])"

# Authenticate gh non-interactively. The labview-benchmark-actor repo is INTERNAL (private): the gated
# ext-v*/collab-cli-v* Releases are NOT world-readable, so a headless guest cannot use gh unauthenticated
# (`gh api`/`gh release download` abort with "run gh auth login"). Consume a token forwarded from the host
# (VIHS_REVIEWER_GH_TOKEN, or GH_TOKEN) and expose it as GH_TOKEN so gh authenticates with no interactive
# login and no credentials persisted to guest disk. Fail fast with guidance when no token was supplied.
$reviewerToken = $env:VIHS_REVIEWER_GH_TOKEN
if (-not $reviewerToken) { $reviewerToken = $env:GH_TOKEN }
if (-not $reviewerToken) {
  throw "No GitHub token in the guest. $repo is INTERNAL, so its gated ext-v*/collab-cli-v* Releases need auth. On the HOST set a token before provisioning (e.g. `$env:GH_TOKEN = (gh auth token)  -- or VIHS_REVIEWER_GH_TOKEN) then re-run: VAGRANT_CWD=reviewer-workstation vagrant provision. The token needs contents:read on $repo (SSO-authorized for SSO orgs)."
}
$env:GH_TOKEN = $reviewerToken
Step "GitHub token present; gh authenticates non-interactively for the private-release downloads."

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
