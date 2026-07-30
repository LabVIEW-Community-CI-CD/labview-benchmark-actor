#requires -Version 5
<#
.SYNOPSIS
  lbabus WINDOWS verification suite.

.DESCRIPTION
  Windows-container parity of the gates in tools/collab-cli/ci/Dockerfile. Runs the lbabus CLI through
  the cross-plane-meaningful checks, adapted to a Windows container:

    - version         : the CLI runs on Windows and reports its pinned SemVer.
    - ci-stress       : the cross-process resource-lease mutual-exclusion regression gate
                        (Windows file-lock / process semantics differ from Linux -- the highest-value
                        Windows check; the same gate the Linux harness runs, LBABUS #15/#18).
    - ci-agents       : `lbabus agents` embed round-trips (--out then --check exit 0) and drift is
                        detected (--check non-zero) -- "same version => same base instructions".
    - ci-docs         : same embed round-trip + drift detection for `lbabus docs`.
    - ci-harness      : the in-container GitHub mock + declarative case runner (cases/*.json). Ripgrep
                        is absent here, so requiresRipgrep cases SKIP (the ci-no-rg equivalent) while
                        the mock-requiring version-guard / defect cases RUN.

  Every gate is inspected via its process exit code; a failure is recorded and the script exits 1 after
  running them all (so one run surfaces the full picture). Used BOTH as a build-time RUN gate in
  Dockerfile.windows AND as the image ENTRYPOINT, so `docker run <image>` re-verifies lbabus on Windows.

  This lane is LEAN by design: NO NI LabVIEW ISO/feed install (no LabVIEW, no VI Analyzer) -- just the
  .NET toolchain that builds and exercises lbabus.
#>
[CmdletBinding()]
param(
  [string]$Out = 'C:\out',
  [string]$Repo = 'C:\repo',
  [int]$StressAgents = 16,
  [int]$StressRounds = 30,
  [int]$MockPort = 8099
)

# Native (dotnet) non-zero exits are inspected via $LASTEXITCODE, not turned into terminating errors.
$ErrorActionPreference = 'Continue'
$script:failures = @()

function Invoke-Dotnet {
  # Runs `dotnet <args>` streaming output to the host; returns the process exit code (never throws).
  param([Parameter(Mandatory)][string[]]$DotnetArgs)
  & dotnet @DotnetArgs 2>&1 | ForEach-Object { Write-Host $_ }
  return $LASTEXITCODE
}

function Assert-Gate {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Body)
  Write-Host ''
  Write-Host "== $Name =="
  try {
    & $Body
    Write-Host "OK: $Name"
  } catch {
    Write-Warning "FAIL: $Name -- $($_.Exception.Message)"
    $script:failures += $Name
  }
}

$cli    = Join-Path $Out 'cli\lbabus.dll'
$stress = Join-Path $Out 'stress\lbabus-stress.dll'
$mock   = Join-Path $Out 'mock\lbabus-mock.dll'
$runner = Join-Path $Out 'ci\lbabus-ci.dll'
$tmp    = Join-Path $env:TEMP 'lbabus-verify'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Assert-Gate 'version' {
  if ((Invoke-Dotnet @($cli, 'version')) -ne 0) { throw 'lbabus version failed' }
}

Assert-Gate 'ci-stress (cross-process lease mutual-exclusion)' {
  $ec = Invoke-Dotnet @($stress, '--lbabus', $cli, '--agents', "$StressAgents", '--rounds', "$StressRounds")
  if ($ec -ne 0) { throw "lbabus-stress exited $ec" }
}

Assert-Gate 'ci-agents (embed round-trip + drift detection)' {
  $f = Join-Path $tmp 'AGENTS.md'
  if ((Invoke-Dotnet @($cli, 'agents', '--out', $f)) -ne 0) { throw 'agents --out failed' }
  if ((Invoke-Dotnet @($cli, 'agents', '--check', $f)) -ne 0) { throw 'agents --check (clean) should pass' }
  Add-Content -Path $f -Value "`ndrift line"
  if ((Invoke-Dotnet @($cli, 'agents', '--check', $f)) -eq 0) { throw 'agents --check did NOT detect drift' }
}

Assert-Gate 'ci-docs (embed round-trip + drift detection)' {
  $f = Join-Path $tmp 'DOCS.md'
  if ((Invoke-Dotnet @($cli, 'docs', '--out', $f)) -ne 0) { throw 'docs --out failed' }
  if ((Invoke-Dotnet @($cli, 'docs', '--check', $f)) -ne 0) { throw 'docs --check (clean) should pass' }
  Add-Content -Path $f -Value "`ndrift line"
  if ((Invoke-Dotnet @($cli, 'docs', '--check', $f)) -eq 0) { throw 'docs --check did NOT detect drift' }
}

Assert-Gate 'ci-harness (GitHub mock + declarative case runner)' {
  $ec = Invoke-Dotnet @($mock, 'run-harness', '--port', "$MockPort", '--repo-root', $Repo, '--lbabus', $cli, '--runner', $runner)
  if ($ec -ne 0) { throw "mock run-harness exited $ec" }
}

Write-Host ''
if ($script:failures.Count -gt 0) {
  Write-Host ('lbabus Windows verification FAILED: ' + ($script:failures -join ', '))
  exit 1
}
Write-Host 'lbabus Windows verification PASSED (all gates green on win32)'
exit 0
