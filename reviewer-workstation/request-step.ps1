param([string]$RequestId, [int]$TimeoutSec = 900, [int]$IntervalSec = 3)
# request-step.ps1 -- guest-side poll for the Handoff Beacon op-done answer (LBA-REQ-056, ADR-0036).
#
# Watches handoff/done/<RequestId>.json -- the op-done@1 beacon the extension writes when the human clicks
# "Mark step done" / "Skip" (or runs the matching palette command) in response to the agent's request -- and
# emits it on stdout so the agent (which invoked this via request-step.sh) resumes exactly when the human is
# done. Bounded by IntervalSec / TimeoutSec (the one sanctioned poll in the agentic flow). Emits
# {"outcome":"timeout"} if the deadline passes with no answer.
$ErrorActionPreference = 'Stop'
$doneDir = Join-Path $env:APPDATA 'Code\User\globalStorage\labview-community-ci-cd.labview-benchmark-actor\handoff\done'
$donePath = Join-Path $doneDir ($RequestId + '.json')
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ($true) {
  if (Test-Path $donePath) {
    $d = $null
    try { $d = Get-Content -Raw $donePath | ConvertFrom-Json } catch { $d = $null }
    if ($d -and ($d.outcome -eq 'done' -or $d.outcome -eq 'skipped')) { Get-Content -Raw $donePath; exit }
  }
  if ((Get-Date) -gt $deadline) { ([ordered]@{ outcome = 'timeout'; requestId = $RequestId }) | ConvertTo-Json -Compress; exit }
  Start-Sleep -Seconds $IntervalSec
}
