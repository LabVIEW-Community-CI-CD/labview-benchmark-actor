#!/usr/bin/env pwsh
# LBA-REQ-006 / T-006 -- multi-VM Vagrant topology proof (re-runnable receipt generator).
#
# Proves two self-contained golden-box VMs (actor-a, actor-b, see Vagrantfile) coordinate over the
# local `lbabus net` TCP/UDP bus (LBA-REQ-007, ADR-0003/0004): UDP presence beacons + ordered,
# reliable TCP CLAIM/HANDOFF/DONE with echoed ACKs, comms-only (no run data / frames / images).
#
# Prereq: `vagrant up` both VMs in this directory (see README.md). Then run this script from the host.
# Writes receipt.json next to this file. Exit 0 iff every cross-VM assertion holds.
[CmdletBinding()]
param(
  [string]$Collector = 'actor-a',
  [string]$Sender    = 'actor-b',
  [int]$TcpPort = 7420,
  [int]$UdpPort = 7421
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
Set-Location $here

function Guest([string]$vm, [string]$ps) {
  (vagrant winrm $vm -c $ps 2>&1) | ForEach-Object { ($_ -replace "`r", '').TrimEnd() }
}
function GuestIp([string]$vm) {
  (Guest $vm "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { `$_.IPAddress -like '192.168.198.*' }).IPAddress") |
    Where-Object { $_ -match '^192\.168\.198\.\d+$' } | Select-Object -First 1
}

Write-Host '[topo] discovering host-only IPs...'
$ipA = GuestIp $Collector
$ipB = GuestIp $Sender
if (-not $ipA -or -not $ipB) { throw "could not discover both private IPs (collector=$ipA sender=$ipB)" }
Write-Host "[topo] $Collector=$ipA  $Sender=$ipB"

Write-Host '[topo] opening lbabus net ports on the collector firewall...'
Guest $Collector ("New-NetFirewallRule -DisplayName 'lbabus-net-tcp' -Direction Inbound -Protocol TCP -LocalPort $TcpPort -Action Allow -EA SilentlyContinue | Out-Null; " +
                  "New-NetFirewallRule -DisplayName 'lbabus-net-udp' -Direction Inbound -Protocol UDP -LocalPort $UdpPort -Action Allow -EA SilentlyContinue | Out-Null; Write-Output ok") | Out-Null

# Collector: run `lbabus net listen` in the FOREGROUND of a `vagrant winrm` call (its pseudo-console
# lets the Ctrl-C handler bind -- a detached / Start-Process launch fails because WinRM session 0 has
# no interactive window station). Wrap it in a host job so the sender can fire concurrently.
# --count 5 (2 presence + CLAIM/HANDOFF/DONE), --timeout as an upper bound.
Write-Host '[topo] launching collector job (lbabus net listen, --echo, count 5)...'
$collectorJob = Start-Job -ScriptBlock {
  param($dir, $tcp, $udp)
  $env:PATH = "C:\Program Files\Vagrant\bin;" + $env:PATH
  Set-Location $dir
  vagrant winrm actor-a -c "`$env:VIHS_COLLAB_AGENT='ACTOR-A'; lbabus net listen --tcp $tcp --udp $udp --echo --count 5 --timeout 90" 2>&1
} -ArgumentList $here, $TcpPort, $UdpPort
Start-Sleep -Seconds 12   # let vagrant winrm connect + the TCP/UDP listeners bind before the sender fires

Write-Host '[topo] sender: 2 UDP presence beacons + TCP CLAIM/HANDOFF/DONE...'
$send = @"
`$env:VIHS_COLLAB_AGENT='ACTOR-B'
lbabus net beacon --host $ipA --port $UdpPort --count 2 --interval 1
lbabus net send --host $ipA --port $TcpPort --type CLAIM --task benchmark --message 'actor-b claims benchmark slot'
lbabus net send --host $ipA --port $TcpPort --type HANDOFF --task benchmark --message 'actor-b hands off to actor-a'
lbabus net send --host $ipA --port $TcpPort --type DONE --task benchmark --message 'actor-b done'
"@
$senderOut = Guest $Sender $send

Write-Host '[topo] waiting for collector job to drain...'
$recv = (Receive-Job $collectorJob -Wait -AutoRemoveJob) | ForEach-Object { ($_ -replace "`r", '').TrimEnd() }

$presence = @($recv | Where-Object { $_ -match 'UDP .*presence.*ACTOR-B present' }).Count
$claim    = [bool]@($recv | Where-Object { $_ -match 'TCP .*CLAIM task:benchmark' })
$handoff  = [bool]@($recv | Where-Object { $_ -match 'TCP .*HANDOFF task:benchmark' })
$done     = [bool]@($recv | Where-Object { $_ -match 'TCP .*DONE task:benchmark' })
$acks     = @($senderOut | Where-Object { $_ -match 'reply <-.*ACK task:benchmark' }).Count
$stopped  = [bool]@($recv | Where-Object { $_ -match 'received 5 message' })
# comms-only: every received frame is a coordination envelope (CLAIM/HANDOFF/DONE/ACK/PROGRESS), never run data/frames.
$commsOnly = -not [bool]@($recv | Where-Object { $_ -match 'frame|image|tdms|run-data|payloadBytes' })

$pass = ($presence -ge 2) -and $claim -and $handoff -and $done -and ($acks -ge 3) -and $commsOnly

$receipt = [ordered]@{
  schema      = 'labview-benchmark-actor/multi-vm-topology-receipt-v1'
  requirement = 'LBA-REQ-006'
  test        = 'T-006'
  ranAt       = (Get-Date).ToUniversalTime().ToString('o')
  transport   = 'lbabus net -- labview-benchmark-actor/bus-msg@1, ADR-0003/0004 (4-byte BE length-prefixed JSON over TCP + UDP datagrams)'
  topology    = [ordered]@{
    collector = [ordered]@{ vm = $Collector; ip = $ipA; identity = 'ACTOR-A' }
    sender    = [ordered]@{ vm = $Sender;    ip = $ipB; identity = 'ACTOR-B' }
    tcpPort   = $TcpPort
    udpPort   = $UdpPort
    network   = 'VMware host-only private_network (VM<->VM)'
    box       = 'vihs/labview-cleanroom-sc (self-contained golden box)'
  }
  asserts     = [ordered]@{
    udpPresenceBeacons = $presence
    tcpClaim = $claim; tcpHandoff = $handoff; tcpDone = $done
    echoedAcks = $acks
    listenerCleanStop = $stopped
    commsOnly = $commsOnly
  }
  pass              = $pass
  collectorReceived = $recv
  senderLog         = $senderOut
}
$receiptPath = Join-Path $here 'receipt.json'
$receipt | ConvertTo-Json -Depth 6 | Set-Content -Path $receiptPath -Encoding utf8
Write-Host "[topo] receipt -> $receiptPath  (pass=$pass; presence=$presence claim=$claim handoff=$handoff done=$done acks=$acks)"
if (-not $pass) { exit 1 }
