#!/usr/bin/env pwsh
# Multi-VM out-of-band corpus export -> host concentration (LBA-REQ-010, T-010 leg 2).
#
# Builds on the proven two-golden-box topology (../run-topology.ps1, LBA-REQ-006): each VM produces its
# OWN completed-run corpus VM-local, the host fetches BOTH corpora OUT-OF-BAND over WinRM (a file read,
# explicitly NOT lbabus net -- the coordination bus stays comms-only per ADR-0006/0008), and the SHIPPED
# host-concentration core (../../host-concentration/hostConcentration.mjs) merges them with per-actor
# isolation. Re-runnable: `vagrant up` the two VMs (see ../README.md), then run this script. Writes
# receipt.json next to this file.
[CmdletBinding()]
param(
  [string[]]$Vms = @('actor-a', 'actor-b'),
  [int]$RunsPerActor = 2
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$topoDir = Split-Path $here -Parent   # experiments/multi-vm-topology (holds the Vagrantfile)

function Guest([string]$vm, [string]$ps) {
  (vagrant winrm $vm -c $ps 2>&1) | ForEach-Object { ($_ -replace "`r", '').TrimEnd() }
}
function ActorId([string]$vm) { "ACTOR-$([char](65 + ([array]::IndexOf($Vms, $vm)) % 26))" }

Push-Location $topoDir
try {
  Write-Host '[export] ensuring the two golden-box VMs are up...'
  vagrant up 2>&1 | Select-Object -Last 2 | Out-Null

  $fetched = Join-Path $here 'fetched'
  New-Item -ItemType Directory -Force -Path $fetched | Out-Null
  Remove-Item (Join-Path $fetched '*.json') -Force -ErrorAction SilentlyContinue

  foreach ($vm in $Vms) {
    $actor = ActorId $vm
    # Producer runs ON the VM: writes VM-local run artifacts (metrics + a frame) + a per-actor corpus
    # manifest, then emits the manifest as one base64 line for a robust out-of-band fetch. Run DATA stays
    # VM-local; only the manifest (actorId + runs[{runId, refs}]) crosses to the host.
    $producer = @"
`$actor = '$actor'
`$runRoot = 'C:\actor-runs'
New-Item -ItemType Directory -Force -Path `$runRoot | Out-Null
`$runs = @()
foreach (`$i in 1..$RunsPerActor) {
  `$runId = "`$(`$actor.ToLower())-run-`$i"
  `$dir = Join-Path `$runRoot `$runId
  New-Item -ItemType Directory -Force -Path `$dir | Out-Null
  Set-Content -Path (Join-Path `$dir 'metrics.json') -Value ('{"cpuPercent":[' + (`$i*10) + '],"ramMb":[' + (`$i*100) + ']}') -Encoding ascii
  Set-Content -Path (Join-Path `$dir 'frame-0001.txt') -Value ("frame for `$runId on `$actor") -Encoding ascii
  `$runs += [ordered]@{ runId = `$runId; completedAt = ('2026-07-28T15:0{0}:00.000Z' -f `$i); metricsRef = (Join-Path `$dir 'metrics.json'); framesRef = `$dir }
}
(`[ordered]@{ actorId = `$actor; runs = `$runs }) | ConvertTo-Json -Depth 6 | Set-Content -Path C:\actor-corpus.json -Encoding utf8
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\actor-corpus.json'))
"@
    $out = Guest $vm $producer
    $b64 = $out | Where-Object { $_ -match '^[A-Za-z0-9+/=]{32,}$' } | Select-Object -Last 1
    if (-not $b64) { throw "no corpus base64 returned from $vm; raw output: $($out -join ' | ')" }
    $dest = Join-Path $fetched ("$($actor.ToLower()).json")
    [IO.File]::WriteAllBytes($dest, [Convert]::FromBase64String($b64))
    Write-Host "[export] $vm -> $actor corpus fetched OUT-OF-BAND over WinRM ($($b64.Length) b64 chars) -> $dest"
  }
}
finally {
  Pop-Location
}

Write-Host '[export] concentrating via the shipped host-concentration core...'
$receiptPath = Join-Path $here 'receipt.json'
& node (Join-Path $here 'concentrate-corpora.mjs') --fetched-dir $fetched --out $receiptPath
if ($LASTEXITCODE -ne 0) { throw "concentrate-corpora.mjs failed (exit $LASTEXITCODE)" }
Write-Host "[export] done -> $receiptPath"
