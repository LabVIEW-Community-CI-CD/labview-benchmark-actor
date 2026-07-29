#requires -Version 5
<#
.SYNOPSIS
  Per-actor workload for the isolated-actor lbabus TCP/UDP MESH test.

.DESCRIPTION
  Each container runs ONE copy under a distinct actor identity (VIHS_COLLAB_AGENT), fully ISOLATED --
  no shared volume, no shared store. Actors coordinate ONLY through collab-cli's TCP/UDP coordination
  bus (`lbabus net`, ADR-0003/0004, the bus-msg@1 envelope), resolving each other by container name on
  a user-defined docker network.

  This actor:
    1. starts `lbabus net listen` in the background, collecting exactly (peers-1) reliable TCP frames
       (--echo returns an ACK to each sender), with a hard --timeout so a partial mesh cannot hang;
    2. sends one CLAIM frame to every OTHER actor (`lbabus net send`), retrying until that peer's
       listener is up (startup race);
    3. waits for its own listener to finish, then counts the peer frames it received.

  Exit 0 iff it received a frame from EVERY other actor (its side of a full mesh); 1 otherwise. When all
  actors exit 0 the orchestrator has proven a complete mesh over TCP -- real lbabus, isolated containers,
  no shared state.
#>
[CmdletBinding()]
param(
  [string]$Lbabus = 'C:\out\cli\lbabus.dll',
  [Parameter(Mandatory)][string]$Peers,   # comma-separated actor hostnames (self is filtered out)
  [int]$TcpPort = 7420,
  [int]$TimeoutSec = 90,
  [int]$SendRetries = 45,
  [int]$SendRetryMs = 1000
)

$ErrorActionPreference = 'Stop'
$actor = $env:VIHS_COLLAB_AGENT
if ([string]::IsNullOrWhiteSpace($actor)) { $actor = "actor-$PID" }

$others = $Peers.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -and ($_ -ne $actor) }
$expected = @($others).Count
$listenOut = Join-Path $env:TEMP "listen-$actor.out"
$listenErr = Join-Path $env:TEMP "listen-$actor.err"

Write-Host "[$actor] mesh start: peers=$($others -join ',') expected=$expected tcp=$TcpPort"

# 1. background listener: collect exactly $expected TCP frames, echo an ACK to each sender, hard timeout.
$listener = Start-Process -FilePath dotnet -PassThru -NoNewWindow `
  -RedirectStandardOutput $listenOut -RedirectStandardError $listenErr `
  -ArgumentList @($Lbabus, 'net', 'listen', '--tcp', "$TcpPort", '--echo', '--count', "$expected", '--timeout', "$TimeoutSec")

Start-Sleep -Seconds 2   # let our own listener bind before the peers start hammering it

# 2. send one CLAIM to every other actor, retrying until that peer's listener accepts the connection.
foreach ($p in $others) {
  $ok = $false
  for ($r = 1; ($r -le $SendRetries) -and (-not $ok); $r++) {
    & dotnet $Lbabus net send --host $p --tcp $TcpPort --type CLAIM --task mesh --message "hello from $actor" --await 2 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $ok = $true } else { Start-Sleep -Milliseconds $SendRetryMs }
  }
  if (-not $ok) { Write-Host "[$actor] WARN could not reach $p after $SendRetries tries" }
}

# 3. wait for the listener to finish (count reached or timeout), then count received peer frames.
$listener.WaitForExit()
$received = 0
if (Test-Path $listenOut) {
  $received = @(Select-String -Path $listenOut -Pattern '^TCP ' -ErrorAction SilentlyContinue).Count
}

Write-Host "[$actor] received $received / $expected peer frames"
if ($received -ge $expected) { Write-Host "[$actor] MESH OK"; exit 0 }
Write-Host "[$actor] MESH INCOMPLETE"; exit 1
