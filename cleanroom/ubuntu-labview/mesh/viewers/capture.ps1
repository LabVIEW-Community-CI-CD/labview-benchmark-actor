<#
.SYNOPSIS
  Host-side packet capture of the Ubuntu mesh's lbabus-net traffic (viewer 1), using Windows' built-in
  pktmon on the host-only vmnet. Captures at L2, so it sees the inter-actor 192.168.56.0/24 traffic
  regardless of the host firewall or whether the host has an IP on the subnet.

.DESCRIPTION
  Reads ../../mesh-actors.csv for the mesh TCP/UDP ports, filters pktmon to them, captures for -Seconds,
  then converts + summarizes (packet count per port + per source). REQUIRES an elevated shell (pktmon).

    powershell -File cleanroom/ubuntu-labview/mesh/viewers/capture.ps1 [-Seconds 10] [-OutDir C:\stage]
#>
[CmdletBinding()]
param(
  [int]$Seconds = 10,
  [string]$OutDir = 'C:\stage'
)
$ErrorActionPreference = 'Stop'

$admin = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Error 'capture.ps1 needs an ELEVATED shell (pktmon requires admin).'; exit 1 }
if (-not (Get-Command pktmon.exe -ErrorAction SilentlyContinue)) { Write-Error 'pktmon not found (Windows 10/11 built-in).'; exit 1 }

# Mesh ports from the store.
$csv = Join-Path $PSScriptRoot '..\..\mesh-actors.csv'
$ports = @(8776, 8777)
if (Test-Path $csv) {
  $rows = Import-Csv $csv | Where-Object role -eq 'mesh'
  $ports = @($rows.tcp_port + $rows.udp_port | ForEach-Object { [int]$_ } | Sort-Object -Unique)
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$etl = Join-Path $OutDir 'PktMon.etl'   # pktmon writes PktMon.etl in the working directory by default
$txt = Join-Path $OutDir 'mesh-capture.txt'

Write-Host "== mesh packet capture (pktmon, L2 on the host-only vmnet) =="
Write-Host "   ports: $($ports -join ', ')  seconds: $Seconds"

pktmon filter remove | Out-Null
foreach ($p in $ports) { pktmon filter add "mesh-$p" -p $p | Out-Null }
Remove-Item $etl -ErrorAction SilentlyContinue
Push-Location $OutDir
try {
  pktmon start --capture --pkt-size 0 | Out-Null
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  pktmon stop | Out-Null
} finally {
  Pop-Location
}
pktmon filter remove | Out-Null

if (-not (Test-Path $etl)) { Write-Error "pktmon produced no capture at $etl."; exit 1 }
pktmon etl2txt $etl -o $txt | Out-Null
if (-not (Test-Path $txt)) { Write-Error 'pktmon produced no text output.'; exit 1 }

$lines = Get-Content $txt
$hits = $lines | Select-String -Pattern ('\b(' + ($ports -join '|') + ')\b')
Write-Host ("== captured {0} packet line(s) matching the mesh ports ==" -f $hits.Count)
$hits | Select-Object -First 8 | ForEach-Object { "  " + $_.Line.Trim() }
Write-Host "   full capture: $etl (open in Wireshark via: pktmon pcapng $etl) + text: $txt"
