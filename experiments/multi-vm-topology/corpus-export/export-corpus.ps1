#!/usr/bin/env pwsh
# Multi-VM out-of-band corpus export -> host ingestion boundary (LBA-REQ-010, T-010 leg 2).
#
# Builds on the proven two-golden-box topology (../run-topology.ps1, LBA-REQ-006): each VM produces its
# OWN completed-run corpus VM-local (metrics in the shipped { cpuMeanPct, ramMeanMiB, durationMs,
# framesRendered } shape + a frame), the host fetches BOTH bundles OUT-OF-BAND over WinRM (a file read,
# explicitly NOT lbabus net -- the coordination bus stays comms-only per ADR-0006/0008), materializes the
# COMMITTED on-disk layout exported-corpus/<actorId>/<runId>/metrics.json + a corpus-manifest@v1 (metricsRefs
# RELATIVE to exported-corpus/), and feeds that manifest through LINUX's SHIPPED ingestion boundary
# (../../host-concentration/ingestCorpusManifest.mjs concentrateManifest + dereferenceMetrics) via
# concentrate-corpora.mjs. The emitted manifest is drive-ready for the live ollama drive
# (../../ollama-comparison/drive-real-corpus.mjs --manifest), the remaining maintainer/GPU step.
#
# To tell a real run-over-run story, ACTOR-A REGRESSES (cpu/ram/duration climb, frames drop) and ACTOR-B
# IMPROVES across its two runs, so the same-actor comparison plan is meaningful. Re-runnable: `vagrant up`
# the two VMs (see ../README.md), then run this script. Writes receipt.json next to this file.
[CmdletBinding()]
param(
  [string[]]$Vms = @('actor-a', 'actor-b'),
  [int]$RunsPerActor = 2
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$topoDir = Split-Path $here -Parent   # experiments/multi-vm-topology (holds the Vagrantfile)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)  # write manifest + metrics BOM-free (the ingestion boundary + live drive read them raw)

function Guest([string]$vm, [string]$ps) {
  # vagrant/VMware write benign warnings to stderr; under ErrorActionPreference=Stop a native stderr record
  # would terminate the script, so relax it locally and rely on the parsed output / exit code instead.
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { (vagrant winrm $vm -c $ps 2>&1) | ForEach-Object { ($_ -replace "`r", '').TrimEnd() } }
  finally { $ErrorActionPreference = $prev }
}
function ActorId([string]$vm) { "ACTOR-$([char](65 + ([array]::IndexOf($Vms, $vm)) % 26))" }

Push-Location $topoDir
try {
  Write-Host '[export] ensuring the two golden-box VMs are up...'
  # `vagrant up` cold-boots VMware, which emits a benign VMX warning to stderr; don't let that terminating
  # native error abort the run under ErrorActionPreference=Stop -- gate on the exit code instead.
  $ErrorActionPreference = 'Continue'
  vagrant up 2>&1 | Select-Object -Last 2 | Out-Null
  $upExit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($upExit -ne 0) { throw "vagrant up failed (exit $upExit)" }

  # exported-corpus/ is COMMITTED (the live GPU drive runs on a host WITHOUT these Windows VMs), so a run
  # regenerates it in place. Clean it first so a run that was removed never lingers.
  $exported = Join-Path $here 'exported-corpus'
  New-Item -ItemType Directory -Force -Path $exported | Out-Null
  Remove-Item $exported -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $exported | Out-Null

  $corpora = @()
  foreach ($vm in $Vms) {
    $actor = ActorId $vm
    $actorLower = $actor.ToLower()
    # ACTOR-A (even index) regresses; ACTOR-B (odd index) improves -- a real run-over-run signal for the plan.
    $trend = if ((([array]::IndexOf($Vms, $vm)) % 2) -eq 0) { 1 } else { -1 }

    # Producer runs ON the VM: writes VM-local run artifacts (metrics in the shipped shape + a frame) and
    # emits a per-actor bundle { actorId, runs:[{ runId, completedAt, metrics, frame }] } as one base64 line
    # for a robust out-of-band fetch. Run DATA is produced + stored VM-local; only the bundle crosses out.
    $producer = @"
`$actor = '$actor'
`$trend = $trend
`$runRoot = 'C:\actor-runs'
New-Item -ItemType Directory -Force -Path `$runRoot | Out-Null
`$baseCpu = 48; `$baseRam = 640; `$baseDur = 1360; `$baseFrames = 465
`$runs = @()
foreach (`$i in 1..$RunsPerActor) {
  `$step = `$i - 1
  `$cpu = `$baseCpu + (`$trend * 9 * `$step)
  `$ram = `$baseRam + (`$trend * 80 * `$step)
  `$dur = `$baseDur + (`$trend * 200 * `$step)
  `$frames = `$baseFrames - (`$trend * 35 * `$step)
  `$runId = '$actorLower' + '-run-' + `$i
  `$dir = Join-Path `$runRoot `$runId
  New-Item -ItemType Directory -Force -Path `$dir | Out-Null
  `$m = [ordered]@{ cpuMeanPct = `$cpu; ramMeanMiB = `$ram; durationMs = `$dur; framesRendered = `$frames }
  (`$m | ConvertTo-Json -Compress) | Set-Content -Path (Join-Path `$dir 'metrics.json') -Encoding ascii
  Set-Content -Path (Join-Path `$dir 'frame-0001.txt') -Value ("frame for `$runId on `$actor") -Encoding ascii
  `$runs += [ordered]@{ runId = `$runId; completedAt = ('2026-07-28T15:0{0}:00.000Z' -f `$i); metrics = `$m; frame = ("frame for `$runId on `$actor") }
}
(`[ordered]@{ actorId = `$actor; runs = `$runs }) | ConvertTo-Json -Depth 6 | Set-Content -Path C:\actor-corpus.json -Encoding utf8
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\actor-corpus.json'))
"@
    # Pass the multi-line producer as a single -EncodedCommand token: a raw multi-line `-c` argument gets
    # tokenized by vagrant.bat on newlines (a stray word like `foreach` is then mis-read as a machine name).
    # -EncodedCommand is base64-of-UTF16LE, exactly what powershell.exe expects, and a single clean token.
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($producer))
    $out = Guest $vm "powershell -NoProfile -EncodedCommand $encoded"
    $b64 = $out | Where-Object { $_ -match '^[A-Za-z0-9+/=]{32,}$' } | Select-Object -Last 1
    if (-not $b64) { throw "no corpus base64 returned from $vm; raw output: $($out -join ' | ')" }
    # Decode the bundle, strip any UTF-8 BOM the guest's Set-Content added, and re-materialize BOM-free on the host.
    $bundleJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) -replace '^\uFEFF', ''
    $bundle = $bundleJson | ConvertFrom-Json

    $runsManifest = @()
    foreach ($run in @($bundle.runs)) {
      $runDir = Join-Path $exported (Join-Path $actor $run.runId)
      New-Item -ItemType Directory -Force -Path $runDir | Out-Null
      $metricsObj = [ordered]@{
        cpuMeanPct     = $run.metrics.cpuMeanPct
        ramMeanMiB     = $run.metrics.ramMeanMiB
        durationMs     = $run.metrics.durationMs
        framesRendered = $run.metrics.framesRendered
      }
      [IO.File]::WriteAllText((Join-Path $runDir 'metrics.json'), ($metricsObj | ConvertTo-Json -Compress), $utf8NoBom)
      [IO.File]::WriteAllText((Join-Path $runDir 'frames.txt'), [string]$run.frame, $utf8NoBom)
      # metricsRef/framesRef are RELATIVE to exported-corpus/ (the manifest dir) with forward slashes so the
      # ingestion boundary + the Linux maintainer host resolve them identically.
      $runsManifest += [ordered]@{
        runId      = $run.runId
        completedAt = $run.completedAt
        metricsRef = "$actor/$($run.runId)/metrics.json"
        framesRef  = "$actor/$($run.runId)/frames.txt"
      }
    }
    $corpora += [ordered]@{ actorId = $actor; runs = $runsManifest }
    Write-Host "[export] $vm -> $actor corpus fetched OUT-OF-BAND over WinRM ($($b64.Length) b64 chars); $($runsManifest.Count) runs materialized under exported-corpus/$actor/"
  }

  # Assemble the corpus-manifest@v1 the ingestion boundary consumes (metricsRefs point at the VM-local
  # metrics files the host just materialized; dereferenceMetrics reads them out-of-band).
  $manifest = [ordered]@{
    schema      = 'labview-benchmark-actor/corpus-manifest@v1'
    generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    topology    = 'multi-vm corpus export (2 golden-box VMs, VM-local dereferenceable metrics)'
    corpora     = $corpora
  }
  $manifestPath = Join-Path $exported 'manifest.json'
  [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8), $utf8NoBom)
  Write-Host "[export] manifest -> $manifestPath (corpus-manifest@v1, $($corpora.Count) actors)"
}
finally {
  Pop-Location
}

Write-Host '[export] ingesting via the shipped concentrateManifest + dereferenceMetrics boundary...'
$receiptPath = Join-Path $here 'receipt.json'
$manifestPath = Join-Path $here 'exported-corpus\manifest.json'
& node (Join-Path $here 'concentrate-corpora.mjs') --manifest $manifestPath --out $receiptPath
if ($LASTEXITCODE -ne 0) { throw "concentrate-corpora.mjs failed (exit $LASTEXITCODE)" }
Write-Host "[export] done -> $receiptPath (drive-ready: node ../../ollama-comparison/drive-real-corpus.mjs --manifest exported-corpus/manifest.json)"
