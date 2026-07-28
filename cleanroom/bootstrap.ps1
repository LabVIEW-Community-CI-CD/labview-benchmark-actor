# Clean-room bootstrap — installs the pinned collab-cli toolchain and BUILDS lbabus in the VM.
#
# Runs as a Vagrant shell provisioner (privileged) inside the licensed-LabVIEW clean room. Idempotent:
# winget skips already-installed packages, and `dotnet tool update` is a no-op when current. "Build it
# on bootstrap" per project direction — the CLI is compiled from the synced source, not downloaded.

$ErrorActionPreference = 'Stop'

Write-Host '[cleanroom] installing pinned toolchain via winget...'
$pins = @(
    'Microsoft.DotNet.SDK.8',
    'Git.Git',
    'GitHub.cli',
    'BurntSushi.ripgrep.MSVC',
    'GLab.GLab'
)
foreach ($id in $pins) {
    try {
        winget install --id $id --exact --source winget `
            --accept-package-agreements --accept-source-agreements --silent
    } catch {
        Write-Warning "[cleanroom] winget $id failed: $_"
    }
}

# Refresh PATH so the freshly installed tools are visible in this session.
$env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('PATH', 'User') + ';' +
            "$env:USERPROFILE\.dotnet\tools"

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

Write-Host '[cleanroom] === lbabus capabilities ==='
lbabus capabilities

Write-Host '[cleanroom] === lbabus selfcheck ==='
lbabus selfcheck
if ($LASTEXITCODE -ne 0) {
    throw "[cleanroom] selfcheck failed (exit $LASTEXITCODE) — the clean-room toolchain is incomplete."
}

Write-Host '[cleanroom] === lbabus agents (materialize version-pinned base instructions) ==='
$agentsPath = Join-Path $env:USERPROFILE 'AGENTS.md'
lbabus agents --out $agentsPath
Write-Host "[cleanroom] agent base instructions materialized at $agentsPath (shared by every session on this lbabus version)."
Write-Host '[cleanroom] bootstrap complete — clean room is a valid coordination environment.'
