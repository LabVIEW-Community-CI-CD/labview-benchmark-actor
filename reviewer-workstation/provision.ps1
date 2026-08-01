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
# (`gh api`/`gh release download` abort with "run gh auth login"). The token is handed off as a FILE (the
# Vagrant file provisioner does NOT echo contents; passing it via the shell provisioner `env:` would leak
# it -- Vagrant echoes the full env-prefixed command when a step fails). Read the file, delete it
# immediately (keep the token only in this process env), then expose it as GH_TOKEN; env vars remain a
# fallback. Fail fast with guidance when no token is available; no credentials are persisted to guest disk.
$tokenFile = 'C:\Windows\Temp\lba-gh-token'
$reviewerToken = $null
if (Test-Path $tokenFile) {
  $reviewerToken = (Get-Content -Raw $tokenFile -ErrorAction SilentlyContinue)
  if ($reviewerToken) { $reviewerToken = $reviewerToken.Trim() }
  Remove-Item $tokenFile -Force -ErrorAction SilentlyContinue
}
if (-not $reviewerToken) { $reviewerToken = $env:VIHS_REVIEWER_GH_TOKEN }
if (-not $reviewerToken) { $reviewerToken = $env:GH_TOKEN }
if (-not $reviewerToken) {
  throw "No GitHub token in the guest. $repo is INTERNAL, so its gated ext-v*/collab-cli-v* Releases need auth. On the HOST, write a token to reviewer-workstation/.gh-token before provisioning (e.g. Set-Content reviewer-workstation/.gh-token (gh auth token)) then re-run: VAGRANT_CWD=reviewer-workstation vagrant provision. The token needs contents:read on $repo (SSO-authorized for SSO orgs)."
}
$env:GH_TOKEN = $reviewerToken
Step "GitHub token present; gh authenticates non-interactively for the private-release downloads."

# Resolve the newest tag with a given prefix, or honor an explicit tag.
function Resolve-Tag([string]$prefix, [string]$tag) {
  if ($tag -and $tag -ne 'latest') { return $tag }
  # Filter release tags in PowerShell -- NOT gh's inline --jq: its nested quotes get mangled through the
  # WinRM `powershell -OutputFormat Text -file` bridge, so jq would see startswith(ext-v) unquoted and abort
  # with "function not defined: v/0". ConvertFrom-Json + Where-Object is quote-safe and equivalent.
  $releases = gh api "repos/$repo/releases?per_page=100" | ConvertFrom-Json
  $match = $releases | Where-Object { $_.tag_name -like "$prefix*" } | Select-Object -First 1
  if (-not $match) { throw "No ${prefix}* release found in $repo (has the gated $prefix release been cut yet?)." }
  return $match.tag_name
}

# Install the extension into the INTERACTIVE console user's VS Code profile -- NOT the WinRM 'vagrant'
# profile provisioning runs as -- or the human reviewer never sees it (#121). Extensions are per-user; the
# profile FOLDER can differ from the username (e.g. user 'vitech' -> 'C:\Users\VI-Tech'), so resolve the
# real profile path from the user's SID via Win32_UserProfile. Falls back to the provisioning profile only
# when no one is logged on at the console.
function Install-ExtensionForInteractiveUser([string]$VsixPath) {
  $extDirArgs = @()
  $consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName
  if ($consoleUser) {
    try {
      $sid = (New-Object System.Security.Principal.NTAccount($consoleUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
      $profilePath = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }).LocalPath
      if ($profilePath) {
        $extDir = Join-Path $profilePath '.vscode\extensions'
        New-Item -ItemType Directory -Force -Path $extDir | Out-Null
        $extDirArgs = @('--extensions-dir', $extDir)
        Step "target profile: $consoleUser -> $extDir"
      }
    } catch {
      Step "WARN could not resolve console-user profile ($consoleUser): $($_.Exception.Message)"
    }
  } else {
    Step 'WARN no interactive console user detected; installing into the provisioning profile.'
  }
  code --install-extension $VsixPath @extDirArgs --force
}

# Verify-before-install (ADR-0022 / LBA-REQ-031, closing the reviewer-workstation clause of LBA-REQ-025): the
# release corroboration provenance MUST verify before the .vsix is installed. Download the release's provenance
# bundle and run the dependency-free Node verifier (experiments/acg-transparency/verify-release-inclusion.mjs),
# which admits install only when >= quorumMin witnesses each have an enrolled-witness-signed attestation that is
# INCLUDED in the Ed25519-signed Merkle transparency log. A non-zero exit BLOCKS the install (fail-closed). Set
# VIHS_REVIEWER_ALLOW_UNATTESTED=1 ONLY to provision from a pre-provenance release.
function Assert-ReleaseProvenance([string]$ExtTag, [string]$WorkDir) {
  gh release download $ExtTag --repo $repo --pattern '*.provenance.json' --dir $WorkDir --clobber 2>$null
  $prov = Get-ChildItem $WorkDir -Filter '*.provenance.json' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $prov) {
    if ($env:VIHS_REVIEWER_ALLOW_UNATTESTED -eq '1') {
      Step "WARN: release $ExtTag carries no *.provenance.json and VIHS_REVIEWER_ALLOW_UNATTESTED=1 -> installing UNATTESTED."
      return
    }
    throw "verify-before-install BLOCKED: release $ExtTag carries no *.provenance.json corroboration bundle. Cut the release with an attached provenance bundle, or set VIHS_REVIEWER_ALLOW_UNATTESTED=1 to override (NOT recommended)."
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "verify-before-install BLOCKED: 'node' is not on PATH; the reviewer box needs Node to verify the corroboration provenance."
  }
  $srcDir = $env:VIHS_REVIEWER_REPO_DIR
  if (-not $srcDir) { $srcDir = Join-Path $env:TEMP 'lba-actor-src' }
  if (Test-Path (Join-Path $srcDir '.git')) {
    Step "Updating verifier source at $srcDir"
    git -C $srcDir fetch --depth 1 origin | Out-Null
    git -C $srcDir reset --hard origin/HEAD | Out-Null
  } else {
    Step "Cloning verifier source ($repo) to $srcDir"
    gh repo clone $repo $srcDir -- --depth 1
  }
  $verifier = Join-Path $srcDir 'experiments\acg-transparency\verify-release-inclusion.mjs'
  if (-not (Test-Path $verifier)) { throw "verify-before-install BLOCKED: verifier not found at $verifier." }
  Step "Running verify-before-install over $($prov.Name)"
  & node $verifier --provenance $prov.FullName
  if ($LASTEXITCODE -ne 0) { throw "verify-before-install BLOCKED: the corroboration provenance for $ExtTag did not verify (exit $LASTEXITCODE). The .vsix will NOT be installed." }
  Step "verify-before-install: provenance verified; proceeding to install."
}

# cosign KEYLESS verify-before-install (LBA-REQ-025 / ADR-0016, NETWORK-GATED): verify the .vsix's own keyless
# signature -- a Fulcio certificate bound to the extension-release.yml workflow identity + a public rekor entry,
# attached to the Release by the hardened release lane -- BEFORE installing it. Needs network (the sigstore TUF
# root + rekor). A failed OR absent signature BLOCKS the install (fail-closed). Set VIHS_REVIEWER_ALLOW_UNSIGNED=1
# ONLY to install a pre-hardening release that predates artifact keyless-signing.
# The Fulcio cert identity binds to the ref the signing workflow ran on. Under the org tag-creation ruleset the
# live release is keyless-signed by extension-release.yml on workflow_dispatch from refs/heads/develop (the tag
# cannot be pushed, so the OIDC identity can never be a tag ref); the maintainer then cuts the immutable release
# locally from that signed artifact. Accept EITHER that develop-ref identity OR an ext-v* tag identity (the latter
# retained for if the ruleset is lifted). The repo + workflow-file + OIDC-issuer pin is the real trust anchor, and
# the workflow's own fail-closed bidirectional WIN<->LINUX agreement gate is what authorizes the signature.
$KeylessIdentityRegexp = '^https://github\.com/LabVIEW-Community-CI-CD/labview-benchmark-actor/\.github/workflows/extension-release\.yml@refs/(tags/ext-v|heads/develop)'
$KeylessOidcIssuer = 'https://token.actions.githubusercontent.com'

function Ensure-Cosign {
  if (Get-Command cosign -ErrorAction SilentlyContinue) { return }
  Step "Installing cosign (sigstore) via direct download"
  New-Item -ItemType Directory -Force -Path 'C:\lba-bin' | Out-Null
  $exe = 'C:\lba-bin\cosign.exe'
  Invoke-WebRequest -Uri 'https://github.com/sigstore/cosign/releases/latest/download/cosign-windows-amd64.exe' -OutFile $exe -UseBasicParsing
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if ($machinePath -notlike '*C:\lba-bin*') { [Environment]::SetEnvironmentVariable('Path', "$machinePath;C:\lba-bin", 'Machine') }
  $env:Path = "$env:Path;C:\lba-bin"
  if (-not (Get-Command cosign -ErrorAction SilentlyContinue)) { throw "cosign install did not put 'cosign' on PATH." }
}

function Assert-VsixKeylessSignature([string]$ExtTag, [string]$Vsix, [string]$WorkDir) {
  gh release download $ExtTag --repo $repo --pattern '*.vsix.sigstore' --dir $WorkDir --clobber 2>$null
  $sig = Get-ChildItem $WorkDir -Filter '*.vsix.sigstore' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $sig) {
    if ($env:VIHS_REVIEWER_ALLOW_UNSIGNED -eq '1') {
      Step "WARN: release $ExtTag carries no *.vsix.sigstore keyless signature and VIHS_REVIEWER_ALLOW_UNSIGNED=1 -> installing UNVERIFIED."
      return
    }
    throw "keyless verify-before-install BLOCKED: release $ExtTag carries no *.vsix.sigstore keyless signature. Cut the release with the hardened extension-release workflow, or set VIHS_REVIEWER_ALLOW_UNSIGNED=1 to override (NOT recommended)."
  }
  Ensure-Cosign
  Step "cosign verify-blob: verifying the .vsix keyless signature ($($sig.Name))"
  & cosign verify-blob --bundle $sig.FullName --certificate-identity-regexp $KeylessIdentityRegexp --certificate-oidc-issuer $KeylessOidcIssuer $Vsix
  if ($LASTEXITCODE -ne 0) { throw "keyless verify-before-install BLOCKED: the .vsix keyless signature did not verify (exit $LASTEXITCODE). The .vsix will NOT be installed." }
  Step "cosign verify-blob: the .vsix keyless signature verified (pinned Fulcio identity + public rekor). Proceeding."
}

# 1) Extension .vsix from the ext-v* Release.
$extResolved = Resolve-Tag 'ext-v' $extTag
$dir = Join-Path $env:TEMP 'lba-ext'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Step "Downloading extension .vsix from $extResolved"
gh release download $extResolved --repo $repo --pattern '*.vsix' --dir $dir --clobber
$vsix = Get-ChildItem $dir -Filter '*.vsix' | Select-Object -First 1
if (-not $vsix) { throw "No .vsix asset in release $extResolved." }
Assert-ReleaseProvenance -ExtTag $extResolved -WorkDir $dir
Assert-VsixKeylessSignature -ExtTag $extResolved -Vsix $vsix.FullName -WorkDir $dir
Step "Installing extension $($vsix.Name) into the interactive reviewer's profile"
Install-ExtensionForInteractiveUser $vsix.FullName

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
