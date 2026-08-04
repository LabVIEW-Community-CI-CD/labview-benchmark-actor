# win-plane-validate.ps1 -- in-VM WIN-plane build/test validation of a release branch (run inside the reviewer VM).
# Ensures a checkout of $Branch from a host-supplied git bundle (auth-free), then: npm ci, a per-suite test
# matrix (each suite run individually, not the && chain), a masked-activation re-run that reproduces the
# LabVIEW-less condition the captureLaunch not-found assertion is written for, and the packaging gate
# (agent-last-gate --skip-tests). Emits ONE line: WINPLANE_JSON={...receipt...}. Logs under the parent of -Work.
#
# Driven from the host by win-plane-validate.sh; runnable directly:
#   powershell -NoProfile -ExecutionPolicy Bypass -File win-plane-validate.ps1 -Branch release/1.0.0 [-SkipCi]
#
# GOTCHA: npm resolves to npm.ps1, which the guest PowerShell ExecutionPolicy blocks ("running scripts is
# disabled"); every npm/node call therefore goes through `cmd /c` (npm.cmd), and this script itself must be
# invoked with -ExecutionPolicy Bypass.
param(
  [string]$Bundle = 'C:\lba-validate\rel.bundle',
  [string]$Branch = 'release/1.0.0',
  [string]$Work   = 'C:\lba-validate\repo',
  [string]$Mask   = 'C:\lba-validate\labview-mask.cjs',
  [switch]$SkipCi
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$logdir = Split-Path $Work
function Run-Cmd([string]$c, [string]$logfile) { & cmd /c "$c > `"$logfile`" 2>&1"; return ($LASTEXITCODE -eq 0) }

$r = [ordered]@{
  node=''; npm=''; git=''; platform=''; branch=''; head=''; cloned=$false; npmCi=$null;
  suites=[ordered]@{}; maskedActivation=$null; maskedActivationCommands=$null; agentLastGate=$null;
  gateTail=''; winPlaneReady=$false
}
$r.node = ((& node -v) 2>&1 | Out-String).Trim()
$r.npm  = ((& cmd /c "npm -v") 2>&1 | Out-String).Trim()
$r.git  = ((& git --version) 2>&1 | Out-String).Trim()
$r.platform = ($env:PROCESSOR_ARCHITECTURE + ' / ' + [System.Environment]::OSVersion.VersionString)

# Ensure a checkout of $Branch from the bundle (idempotent: reuse an existing checkout).
if (-not (Test-Path (Join-Path $Work '.git'))) {
  if (-not (Test-Path $logdir)) { New-Item -ItemType Directory -Force -Path $logdir | Out-Null }
  & git clone -b $Branch $Bundle $Work 2>&1 | Out-File (Join-Path $logdir 'clone.log') -Encoding utf8
}
$r.cloned = (Test-Path (Join-Path $Work '.git'))
if (-not $r.cloned) { Write-Output ('WINPLANE_JSON=' + ($r | ConvertTo-Json -Compress -Depth 6)); return }

Set-Location $Work
& git checkout $Branch 2>&1 | Out-Null
$r.branch = ((& git rev-parse --abbrev-ref HEAD) 2>&1 | Out-String).Trim()
$r.head   = ((& git rev-parse HEAD) 2>&1 | Out-String).Trim()

if ($SkipCi -and (Test-Path (Join-Path $Work 'node_modules'))) {
  $r.npmCi = 'skipped (node_modules present)'
} else {
  $r.npmCi = (Run-Cmd 'npm ci' (Join-Path $logdir 'npmci.log'))
}

# Per-suite test matrix (each suite individually -- the packaged `npm test` && chain stops at the first fail).
$suites = [ordered]@{
  'extension-activation' = 'node test/extension-activation.mjs'
  'viewer-render'        = 'node test/viewer-render.mjs'
  'viewer-plain-render'  = 'node test/viewer-plain-render.mjs'
  'panels-render'        = 'node test/panels-render.mjs'
  'mcp-server'           = 'node test/mcp-server.mjs'
  'mcp-tool-doc'         = 'node scripts/mcpToolDoc.mjs --check docs/mcp-tools.md'
}
foreach ($k in $suites.Keys) { $r.suites[$k] = (Run-Cmd $suites[$k] (Join-Path $logdir "t_$k.log")) }

# Masked activation: reproduce the LabVIEW-less condition (mask the LabVIEW.exe candidate paths) so the one
# environment-assumption assertion (captureLaunch not-found guard) applies and the suite goes fully green.
if (Test-Path $Mask) {
  $r.maskedActivation = (Run-Cmd "node --require `"$Mask`" test/extension-activation.mjs" (Join-Path $logdir 'mask-activation.log'))
  $m = (Select-String -Path (Join-Path $logdir 'mask-activation.log') -Pattern 'registered (\d+) commands' -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($m -and $m.Matches.Count) { $r.maskedActivationCommands = [int]$m.Matches[0].Groups[1].Value }
}

# Packaging gate (tests asserted above): manifest/changelog/readme/icon/vsix allow-set + size.
$r.agentLastGate = (Run-Cmd 'node scripts\agent-last-gate.mjs --skip-tests' (Join-Path $logdir 'gate.log'))
if (Test-Path (Join-Path $logdir 'gate.log')) { $r.gateTail = ((Get-Content (Join-Path $logdir 'gate.log') -Tail 3) -join ' | ') }

# Honest verdict: every suite EXCEPT extension-activation is green (that one is expected-fail on a real-LabVIEW
# host and is proven green under the mask), masked activation passes, and the packaging gate passes.
$nonActivationGreen = $true
foreach ($k in $r.suites.Keys) { if ($k -ne 'extension-activation' -and -not $r.suites[$k]) { $nonActivationGreen = $false } }
$ciOk = ($r.npmCi -eq $true) -or ($r.npmCi -is [string])
$r.winPlaneReady = ($nonActivationGreen -and ($r.maskedActivation -eq $true) -and ($r.agentLastGate -eq $true) -and $ciOk)

Write-Output ('WINPLANE_JSON=' + ($r | ConvertTo-Json -Compress -Depth 6))
