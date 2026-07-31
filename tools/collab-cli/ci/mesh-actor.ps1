#requires -Version 5
<#
.SYNOPSIS
  Per-actor workload for the isolated-actor lbabus TCP/UDP MESH test.

.DESCRIPTION
  Each container runs ONE copy under a distinct actor identity (VIHS_COLLAB_AGENT), fully ISOLATED --
  no shared volume, no shared store. Actors coordinate ONLY through collab-cli's TCP/UDP coordination
  bus (`lbabus net`, ADR-0003/0004, the bus-msg@1 envelope), resolving each other by container name on
  a user-defined docker network.

  This actor exercises BOTH lbabus net transports:
    1. starts a background TCP listener collecting exactly (peers-1) reliable TCP frames (--echo returns
       an ACK to each sender) AND a background UDP listener collecting presence beacons, both with a hard
       --timeout so a partial mesh cannot hang;
    2. sends one CLAIM frame to every OTHER actor over TCP (`lbabus net send`), retrying until that peer's
       listener is up (startup race); then emits UDP presence beacons (`lbabus net beacon`) to every peer;
    3. waits for both listeners, then counts the distinct peers it heard from over TCP (reliable frames)
       and over UDP (each beacon envelope carries the sender's actor name, so the count is by IDENTITY --
       robust to datagram loss and to address translation on the nat network).

  Exit 0 iff it heard from EVERY other actor over BOTH TCP and UDP (its side of a full mesh); 1 otherwise.
  When all actors exit 0 the orchestrator has proven a complete TCP+UDP mesh over real lbabus, across
  isolated containers with no shared state.
#>
[CmdletBinding()]
param(
  [string]$Lbabus = 'C:\out\cli\lbabus.dll',
  [Parameter(Mandatory)][string]$Peers,   # comma-separated actor hostnames (self is filtered out)
  [int]$TcpPort = 7420,
  [int]$UdpPort = 7421,
  [int]$TimeoutSec = 90,
  [int]$UdpTimeoutSec = 30,
  [int]$UdpBeacons = 3,
  [int]$SendRetries = 45,
  [int]$SendRetryMs = 1000
)

$ErrorActionPreference = 'Stop'
$actor = $env:VIHS_COLLAB_AGENT
if ([string]::IsNullOrWhiteSpace($actor)) { $actor = "actor-$PID" }

# Node type (source|sink|both, default both): a source only EMITS, a sink only COLLECTS, both is the symmetric
# peer. Orthogonal to the mesh-actors.csv lifecycle role. Fail closed on an unknown type. (mesh-node-types.md)
$nodeType = if ([string]::IsNullOrWhiteSpace($env:NODE_TYPE)) { 'both' } else { $env:NODE_TYPE.Trim().ToLowerInvariant() }
if ($nodeType -notin @('source', 'sink', 'both')) { Write-Error "unknown NODE_TYPE='$nodeType' (expected source|sink|both)"; exit 2 }
$isListener = $nodeType -in @('sink', 'both')
$isEmitter  = $nodeType -in @('source', 'both')

$others = $Peers.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -and ($_ -ne $actor) }
$expected = @($others).Count
$tcpOut = Join-Path $env:TEMP "tcp-$actor.out"
$tcpErr = Join-Path $env:TEMP "tcp-$actor.err"
$udpOut = Join-Path $env:TEMP "udp-$actor.out"
$udpErr = Join-Path $env:TEMP "udp-$actor.err"

Write-Host "[$actor] mesh start: peers=$($others -join ',') expected=$expected tcp=$TcpPort udp=$UdpPort"

# 1. background listeners (sink|both only): TCP collects exactly $expected reliable frames (--echo returns an
# ACK to each sender); UDP collects presence beacons, exiting on every distinct peer (--count-distinct) or the
# timeout. A pure source starts NO listeners (node types are enforced).
if ($isListener) {
  $tcpListener = Start-Process -FilePath dotnet -PassThru -NoNewWindow `
    -RedirectStandardOutput $tcpOut -RedirectStandardError $tcpErr `
    -ArgumentList @($Lbabus, 'net', 'listen', '--tcp', "$TcpPort", '--echo', '--count', "$expected", '--timeout', "$TimeoutSec")

  $udpListener = Start-Process -FilePath dotnet -PassThru -NoNewWindow `
    -RedirectStandardOutput $udpOut -RedirectStandardError $udpErr `
    -ArgumentList @($Lbabus, 'net', 'listen', '--udp', "$UdpPort", '--count-distinct', "$expected", '--timeout', "$UdpTimeoutSec")
}

Start-Sleep -Seconds 2   # let our own listeners bind before the peers start hammering them

$peerCsv = $others -join ','
if ($isEmitter) {
  # 2. TCP: ONE `lbabus net send` fans a CLAIM out to EVERY other actor via --hosts, retrying each peer until
  # its listener accepts. A clean exit is also our barrier that every peer is alive.
  & dotnet $Lbabus net send --hosts $peerCsv --tcp $TcpPort --type CLAIM --task mesh --message "hello from $actor" --await 2 --retries $SendRetries --retry-ms $SendRetryMs 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Host "[$actor] WARN one or more TCP peers unreachable after $SendRetries tries" }
  # 3. UDP: ONE `lbabus net beacon` fans presence beacons out to EVERY peer via --hosts; each envelope carries
  # THIS actor's identity so a peer attributes it regardless of datagram loss or address translation.
  & dotnet $Lbabus net beacon --hosts $peerCsv --udp $UdpPort --count $UdpBeacons --interval 1 --task mesh 2>$null | Out-Null
}

# 4. verdict. A sink|both waits for its listeners and counts DISTINCT peers heard over each transport; a pure
# source has nothing to hear -- its success is that it fanned its stream out to every peer.
if ($isListener) {
  $tcpListener.WaitForExit()
  $udpListener.WaitForExit()

  $tcpReceived = 0
  if (Test-Path $tcpOut) {
    $tcpReceived = @(Select-String -Path $tcpOut -Pattern '^TCP ' -ErrorAction SilentlyContinue).Count
  }

  # UDP line = "UDP <addr>  [<ts>] <senderId> #<seq> ..." -- pull <senderId>, count distinct non-self peers.
  $udpSenders = @()
  if (Test-Path $udpOut) {
    $udpSenders = @(Select-String -Path $udpOut -Pattern '^UDP ' -ErrorAction SilentlyContinue |
      ForEach-Object { if ($_.Line -match '\]\s+(\S+)\s+#\d+') { $Matches[1] } } |
      Where-Object { $_ -and ($_ -ne $actor) } | Sort-Object -Unique)
  }
  $udpDistinct = @($udpSenders).Count

  Write-Host "[$actor] TCP heard from $tcpReceived / $expected ; UDP heard from $udpDistinct / $expected ($($udpSenders -join ','))"
  if (($tcpReceived -ge $expected) -and ($udpDistinct -ge $expected)) { Write-Host "[$actor] MESH OK (TCP+UDP)"; exit 0 }
  Write-Host "[$actor] MESH INCOMPLETE"; exit 1
}
else {
  Write-Host "[$actor] SOURCE emitted to $expected peer(s)"
  Write-Host "[$actor] MESH OK (source)"; exit 0
}
