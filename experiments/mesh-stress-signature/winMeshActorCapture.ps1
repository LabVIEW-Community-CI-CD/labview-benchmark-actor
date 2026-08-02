# winMeshActorCapture.ps1 -- one Windows mesh ACTOR's stress + capture, run INSIDE a golden-box VM via
# VBoxManage guestcontrol. Spins $Busy CPU-burning RUNSPACES (in-process threads -- fast startup + clean core
# saturation, unlike heavyweight Start-Job child processes) to drive the VM to its commanded stress rung, waits
# a short ramp, then runs the proven exact-12-FPS PDH sampler (winPdhSampler.ps1) so the VM's OWN
# performance-counter signature is captured under that load. Emits the same performance-counter-correlation@v2
# JSON a Linux actor does -- so a real Win11 VM becomes a calibratable mesh actor. Deterministic given the load.
#   usage: powershell -ExecutionPolicy Bypass -File winMeshActorCapture.ps1 <Busy> <Out.json> [Samples=48] [SamplerPath=C:\tmp\winPdhSampler.ps1]
param(
  [Parameter(Mandatory = $true)][int]$Busy,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Samples = 48,
  [string]$SamplerPath = 'C:\tmp\winPdhSampler.ps1'
)
$ErrorActionPreference = 'Stop'

if (Test-Path $Out) { Remove-Item $Out -Force }   # never append onto a prior capture

$durationMs = [int](($Samples / 12.0) * 1000) + 2000   # cover the whole capture window + ramp/teardown slack
$deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $durationMs

# $Busy CPU burners as runspaces: each holds ~100% of one core with a tight loop until the wall-clock deadline
# (epoch-ms, so it does not drift with the VM TSC). Runspaces are in-process threads => ~ms startup, so the load
# is at steady state well before the frame-locked capture begins (Start-Job child pwsh startup thrashed instead).
$pool = [runspacefactory]::CreateRunspacePool(1, [Math]::Max(1, $Busy))
$pool.Open()
$burners = @()
for ($i = 0; $i -lt $Busy; $i++) {
  $ps = [powershell]::Create()
  $ps.RunspacePool = $pool
  [void]$ps.AddScript({
    param($dl)
    while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $dl) { for ($k = 0; $k -lt 1000000; $k++) { } }
  }).AddArgument($deadline)
  $burners += @{ ps = $ps; handle = $ps.BeginInvoke() }
}

Start-Sleep -Milliseconds 600   # let the burners ramp to steady state before the frame-locked capture

& powershell -ExecutionPolicy Bypass -File $SamplerPath $Out $Samples 12

foreach ($b in $burners) { try { $b.ps.Stop() } catch { }; try { $b.ps.Dispose() } catch { } }
try { $pool.Close(); $pool.Dispose() } catch { }
Write-Output ("busy=$Busy samples=$Samples -> $Out")
