# Clean-room bootstrap - installs the pinned collab-cli toolchain and BUILDS lbabus in the VM.
#
# Runs as a Vagrant shell provisioner (privileged) inside the licensed-LabVIEW clean room. Idempotent:
# tool installs skip when the binary is already present, and `dotnet tool update` is a no-op when current.
# "Build it on bootstrap" per project direction - the CLI is compiled from the synced source, not downloaded.

$ErrorActionPreference = 'Stop'

# Provisioner-safe toolchain install. NOTE: winget is an MSIX app-execution alias that is NOT resolvable
# in the non-interactive (elevated / network-logon) WinRM provisioner session, so the pinned toolchain is
# installed via the official dotnet-install script + direct release archives instead. git ships in the box.
$ProgressPreference = 'SilentlyContinue'   # keep Invoke-WebRequest fast + quiet over WinRM

function Add-MachinePath([string]$dir) {
    $machine = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
    if ($machine -notlike "*$dir*") {
        [Environment]::SetEnvironmentVariable('PATH', "$machine;$dir", 'Machine')
    }
    if ($env:PATH -notlike "*$dir*") { $env:PATH = "$env:PATH;$dir" }
}

function Install-ToolArchive([string]$name, [string]$url, [string]$exeName) {
    $root = Join-Path $env:ProgramData "cleanroom-tools\$name"
    $exe = Get-ChildItem -Path $root -Filter $exeName -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $exe) {
        Write-Host "[cleanroom] installing $name ..."
        New-Item -ItemType Directory -Force $root | Out-Null
        $zip = Join-Path $env:TEMP "$name.zip"
        Invoke-WebRequest -UseBasicParsing $url -OutFile $zip
        Expand-Archive -Path $zip -DestinationPath $root -Force
        Remove-Item $zip -Force
        $exe = Get-ChildItem -Path $root -Filter $exeName -Recurse | Select-Object -First 1
    }
    if (-not $exe) { throw "[cleanroom] $name install failed: $exeName not found under $root" }
    Add-MachinePath $exe.Directory.FullName
}

Write-Host '[cleanroom] installing pinned toolchain (winget-free, WinRM-safe)...'

# .NET SDK 8 via the official install script (reliable in any session; the base box ships only the runtime).
$hasSdk = $false
if (Get-Command dotnet -ErrorAction SilentlyContinue) { $hasSdk = @(dotnet --list-sdks 2>$null).Count -gt 0 }
if (-not $hasSdk) {
    $dotnetInstall = Join-Path $env:TEMP 'dotnet-install.ps1'
    Invoke-WebRequest -UseBasicParsing 'https://dot.net/v1/dotnet-install.ps1' -OutFile $dotnetInstall
    & $dotnetInstall -Channel 8.0 -InstallDir 'C:\Program Files\dotnet'
}
Add-MachinePath 'C:\Program Files\dotnet'

# git must ship in the base box (a full Git-for-Windows install is out of scope for the provisioner).
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw '[cleanroom] git not found on PATH - include Git for Windows in the base box.'
}

# Pinned CLI tools via direct release archives (pinned versions are minimums per lbabus selfcheck).
Install-ToolArchive 'ripgrep' 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip' 'rg.exe'
Install-ToolArchive 'gh'      'https://github.com/cli/cli/releases/download/v2.96.0/gh_2.96.0_windows_amd64.zip' 'gh.exe'
Install-ToolArchive 'glab'    'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/packages/generic/glab/1%2E109%2E0/glab_1%2E109%2E0_windows_amd64%2Ezip' 'glab.exe'

# Make the .NET global-tools dir (where lbabus installs below) visible on PATH.
Add-MachinePath "$env:USERPROFILE\.dotnet\tools"

# Locate the synced collab-cli source (SMB mount from the host repo).
$src = @('C:\vagrant-src\tools\collab-cli', 'C:\vagrant\tools\collab-cli') |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $src) { throw '[cleanroom] collab-cli source not found in the synced folder.' }

Write-Host "[cleanroom] building collab-cli from $src ..."
Push-Location $src
try {
    dotnet build -c Release
    $version = (Select-Xml -Path 'LbaBus.csproj' -XPath '//Version' | Select-Object -First 1).Node.InnerText
    $pack = Join-Path $env:TEMP 'lbabus-pack'
    dotnet pack -c Release -o $pack
    dotnet tool update --global LabViewBenchmarkActor.CollabBus --add-source $pack --version $version
} finally {
    Pop-Location
}

# lbabus prints its human-readable report to stderr. Capture stdout+stderr together (2>&1) and echo it as
# normal output so that (a) benign stderr cannot raise a NativeCommandError under $ErrorActionPreference,
# and (b) no stray error-stream records are left to make the WinRM provisioner treat bootstrap as failed.
$ErrorActionPreference = 'Continue'

Write-Host '[cleanroom] === lbabus capabilities ==='
$capsOut = & lbabus capabilities 2>&1
$capsOut | ForEach-Object { Write-Host $_ }

Write-Host '[cleanroom] === lbabus selfcheck ==='
$selfcheckOut = & lbabus selfcheck 2>&1
$selfcheckCode = $LASTEXITCODE
$selfcheckOut | ForEach-Object { Write-Host $_ }
if ($selfcheckCode -ne 0) {
    throw "[cleanroom] selfcheck failed (exit $selfcheckCode) - the clean-room toolchain is incomplete."
}

Write-Host '[cleanroom] === lbabus agents (materialize version-pinned base instructions) ==='
$agentsPath = Join-Path $env:USERPROFILE 'AGENTS.md'
$agentsOut = & lbabus agents --out $agentsPath 2>&1
$agentsOut | ForEach-Object { Write-Host $_ }
Write-Host "[cleanroom] agent base instructions materialized at $agentsPath (shared by every session on this lbabus version)."
Write-Host '[cleanroom] bootstrap complete - clean room is a valid coordination environment.'
