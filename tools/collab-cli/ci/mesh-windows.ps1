#requires -Version 5
<#
.SYNOPSIS
  Isolated-actor lbabus TCP/UDP MESH test (Windows host, Windows-container engine).

.DESCRIPTION
  Launches N containers from the lbabus Windows verification image on a user-defined docker network,
  each a DISTINCT named actor (VIHS_COLLAB_AGENT), fully ISOLATED -- no shared volume, no shared store.
  The actors coordinate ONLY through collab-cli's TCP/UDP bus (`lbabus net`, see ci/mesh-actor.ps1),
  resolving each other by container name. Each actor must hear from EVERY other actor over BOTH TCP
  (reliable frames) and UDP (presence beacons); when every actor exits 0, a complete TCP+UDP mesh formed.

  Exits 0 on a full mesh (all actors 0); 1 if any actor did not complete. Self-cleaning (removes the
  containers and the network on exit).

.EXAMPLE
  docker build -f tools/collab-cli/ci/Dockerfile.windows --target mesh -t lbabus-win-verify:mesh tools/collab-cli
  pwsh -File tools/collab-cli/ci/mesh-windows.ps1 -Actors 3
#>
[CmdletBinding()]
param(
  [string]$Image = 'lbabus-win-verify:mesh',
  [int]$Actors = 3,
  [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Stop'
$run   = 'lbabus-mesh-' + (Get-Random)
$net   = "$run-net"
$names = 1..$Actors | ForEach-Object { "$run-actor-$_" }
$peers = $names -join ','
$exit  = 1

# Scale the per-actor timeouts with N (parity with ci/mesh-linux.sh): a large mesh takes longer to fully
# form -- every actor opens N-1 TCP connections + emits N-1 beacon streams, and containers launch
# sequentially, so early actors retry longer while late actors' listeners come up.
$tcpTimeout = 60 + $Actors * 3
$udpTimeout = 30 + $Actors

Write-Host "== lbabus TCP+UDP mesh: $Actors isolated actors (image $Image, network $net) =="
# Windows containers use the `nat` driver (the Linux `bridge` driver does not exist here); a user-defined
# nat network gives the containers DNS name resolution by container name, which is how actors find peers.
docker network create -d nat $net | Out-Null
try {
  # Launch each isolated actor on the shared network; they reach each other only by name over `lbabus net`.
  foreach ($n in $names) {
    docker run -d --name $n --network $net -e "VIHS_COLLAB_AGENT=$n" $Image `
      -Peers $peers -TimeoutSec $tcpTimeout -UdpTimeoutSec $udpTimeout -SendRetries 90 | Out-Null
  }

  # Wait for every actor to exit (docker wait blocks and prints the exit code).
  $codes = @{}
  foreach ($n in $names) { $codes[$n] = [int](docker wait $n | Select-Object -First 1) }

  Write-Host ''
  foreach ($n in $names) {
    Write-Host "--- $n (exit $($codes[$n])) ---"
    docker logs $n 2>&1 | Select-String -Pattern 'heard|MESH|WARN' | ForEach-Object { "    $_" }
  }

  $failed = @($codes.GetEnumerator() | Where-Object { $_.Value -ne 0 } | ForEach-Object { $_.Key })
  Write-Host ''
  if ($failed.Count -eq 0) {
    Write-Host "PASS  full TCP+UDP mesh: all $Actors isolated actors heard from every peer over TCP and UDP (lbabus net, no shared state)"
    $exit = 0
  } else {
    Write-Host "FAIL  mesh incomplete: $($failed -join ', ')"
    $exit = 1
  }
} finally {
  foreach ($n in $names) { docker rm -f $n 2>$null | Out-Null }
  docker network rm $net 2>$null | Out-Null
}

exit $exit
