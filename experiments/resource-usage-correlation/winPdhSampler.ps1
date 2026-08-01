# labview-benchmark-actor -- Windows PDH 12-FPS performance sampler (LBA-REQ-011, cross-platform).
#
# The Windows counterpart to linuxProcSampler.mjs: a DRIFT-CORRECTED, frame-locked loop that reads the CURRENT
# PDH counter values at EXACTLY 1000/frameRateHz ms and emits the v2 counters{} catalog as ONE JSON document with
# a measured effective-FPS + phase error. Get-Counter / typeperf floor at a 1 Hz sample interval -- too coarse for
# 12 FPS -- so this uses System.Diagnostics.PerformanceCounter.NextValue(), which reads the live PDH value at ANY
# rate, in a Stopwatch-scheduled loop phase-locked to the 12 FPS frame clock (each sample maps 1:1 to a long
# packet). Emits the SAME performance-counter-correlation@v2 shape a Linux actor does for the shared keys.
#
# Usage: powershell -ExecutionPolicy Bypass -File winPdhSampler.ps1 <out.json> [samples=36] [frameRateHz=12]
param([Parameter(Mandatory = $true)][string]$Out, [int]$Samples = 36, [double]$FrameRateHz = 12)
$ErrorActionPreference = 'Stop'

function New-PC([string]$Category, [string]$Counter, [string]$Instance) {
  try {
    $pc = if ($Instance) { New-Object System.Diagnostics.PerformanceCounter($Category, $Counter, $Instance) }
          else { New-Object System.Diagnostics.PerformanceCounter($Category, $Counter) }
    $null = $pc.NextValue()  # prime (rate counters return 0 on the first read)
    return $pc
  } catch { return $null }
}

# v2 catalog keys -> PDH (category, counter, instance). _Total instances aggregate; System counters are single.
$counters = [ordered]@{
  cpuTotalPct           = (New-PC 'Processor' '% Processor Time' '_Total')
  cpuUserPct            = (New-PC 'Processor' '% User Time' '_Total')
  cpuPrivilegedPct      = (New-PC 'Processor' '% Privileged Time' '_Total')
  contextSwitchesPerSec = (New-PC 'System' 'Context Switches/sec' $null)
  processorQueueLength  = (New-PC 'System' 'Processor Queue Length' $null)
  memAvailableMb        = (New-PC 'Memory' 'Available MBytes' $null)
  memCommittedBytes     = (New-PC 'Memory' 'Committed Bytes' $null)
  memCommittedInUsePct  = (New-PC 'Memory' '% Committed Bytes In Use' $null)
  diskReadsPerSec       = (New-PC 'PhysicalDisk' 'Disk Reads/sec' '_Total')
  diskWritesPerSec      = (New-PC 'PhysicalDisk' 'Disk Writes/sec' '_Total')
  diskReadBytesPerSec   = (New-PC 'PhysicalDisk' 'Disk Read Bytes/sec' '_Total')
  diskWriteBytesPerSec  = (New-PC 'PhysicalDisk' 'Disk Write Bytes/sec' '_Total')
  diskAvgQueueLength    = (New-PC 'PhysicalDisk' 'Avg. Disk Queue Length' '_Total')
}

$frameIntervalMs = 1000.0 / $FrameRateHz
$epoch0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$samplesOut = New-Object System.Collections.ArrayList
$phaseErrors = New-Object System.Collections.ArrayList

for ($n = 1; $n -le $Samples; $n++) {
  # WALL-CLOCK frame boundary (epoch0 + n*interval), NOT a Stopwatch/QPC clock -- in a VM the TSC diverges from wall
  # time, so scheduling off Stopwatch drifts off the 12 FPS long-packet (wall-clock) cadence. Drift-corrected: each
  # sample is anchored to n*interval, not a running += interval.
  $idealMs = $epoch0 + $n * $frameIntervalMs
  while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $idealMs) { Start-Sleep -Milliseconds 1 }
  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [void]$phaseErrors.Add([Math]::Abs($nowMs - $idealMs))
  $c = [ordered]@{}
  foreach ($k in $counters.Keys) {
    $pc = $counters[$k]
    $c[$k] = if ($pc) { try { [Math]::Round([double]$pc.NextValue(), 3) } catch { $null } } else { $null }
  }
  [void]$samplesOut.Add([ordered]@{ epochMs = $nowMs; frameIndex = $n; counters = $c })
}

$dts = for ($i = 1; $i -lt $samplesOut.Count; $i++) { $samplesOut[$i].epochMs - $samplesOut[$i - 1].epochMs }
$dtsSorted = @($dts | Sort-Object)
$peSorted = @($phaseErrors | Sort-Object)
$durationSec = ($samplesOut[$samplesOut.Count - 1].epochMs - $epoch0) / 1000.0
$effectiveFps = $samplesOut.Count / $durationSec

$result = [ordered]@{
  schema             = 'labview-benchmark-actor/resource-correlated-launch@2'
  plane              = 'WIN'
  source             = 'PDH System.Diagnostics.PerformanceCounter (drift-corrected, frame-locked loop)'
  frameRateHz        = $FrameRateHz
  frameIntervalMs    = $frameIntervalMs
  epochMsAtFrameZero = $epoch0
  sampleCount        = $samplesOut.Count
  measured           = [ordered]@{
    medianCadenceMs    = $dtsSorted[[int]([Math]::Floor($dtsSorted.Count / 2))]
    effectiveFps       = [Math]::Round($effectiveFps, 4)
    exactly12fps       = ([Math]::Abs($effectiveFps - $FrameRateHz) -lt 0.05)
    medianPhaseErrorMs = [Math]::Round($peSorted[[int]([Math]::Floor($peSorted.Count / 2))], 3)
    maxPhaseErrorMs    = [Math]::Round($peSorted[$peSorted.Count - 1], 3)
  }
  samples            = $samplesOut
}
$result | ConvertTo-Json -Depth 6 | Set-Content -Path $Out -Encoding UTF8
Write-Host ("[win-pdh] {0} samples @ {1:N3} ms -> {2:N3} FPS (exactly12fps={3}); median phase-error {4} ms, max {5} ms" -f `
  $samplesOut.Count, $frameIntervalMs, $result.measured.effectiveFps, $result.measured.exactly12fps, $result.measured.medianPhaseErrorMs, $result.measured.maxPhaseErrorMs)
