param([int]$TimeoutSec = 900, [int]$IntervalSec = 3)
# await-handoff.ps1 -- guest-side poll for the Handoff Beacon capture-status (LBA-REQ-055, ADR-0035).
#
# Watches the NEWEST LabVIEW-launch capture run dir for capture-status.json (state stopped|failed) -- the beacon
# the extension writes when the operator clicks Stop -- and emits the resolved beacon JSON on stdout so the agent
# (which invoked this via await-handoff.sh) resumes exactly when the human is done. Falls back to capture.json
# (a legacy capture with no beacon = stopped + assembled). Bounded by IntervalSec / TimeoutSec (the one
# sanctioned poll in the agentic flow). Emits {"state":"timeout"} if the deadline passes with no stop.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:APPDATA 'Code\User\globalStorage\svelderrainruiz.labview-benchmark-actor\captures'
if (-not (Test-Path $root)) { '{"state":"error","error":"no captures directory"}'; exit }
$dir = (Get-ChildItem $root -Directory | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
$statusPath = Join-Path $dir 'capture-status.json'
$capPath = Join-Path $dir 'capture.json'
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ($true) {
  if (Test-Path $statusPath) {
    $s = $null
    try { $s = Get-Content -Raw $statusPath | ConvertFrom-Json } catch { $s = $null }
    if ($s -and ($s.state -eq 'stopped' -or $s.state -eq 'failed')) { Get-Content -Raw $statusPath; exit }
  }
  elseif (Test-Path $capPath) {
    ([ordered]@{ state = 'stopped'; runDir = $dir; beacon = $false; captureJsonReady = $true }) | ConvertTo-Json -Compress; exit
  }
  if ((Get-Date) -gt $deadline) { ([ordered]@{ state = 'timeout'; runDir = $dir }) | ConvertTo-Json -Compress; exit }
  Start-Sleep -Seconds $IntervalSec
}
