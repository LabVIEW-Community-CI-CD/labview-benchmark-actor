#requires -Version 5
<#+
.SYNOPSIS
  Prepare a Vagrant-hosted Ubuntu golden actor for the human-only LabVIEW activation step.

.DESCRIPTION
  Check and repair public prerequisites for activation, hand off the NI/VIPM sign-in to the user, then
  capture a functional activation receipt after the user completes the step. This script never accepts,
  reads, or transmits credentials.

.EXAMPLE
  pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Check
  pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Repair
  pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Handoff
  pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Confirm
#>
[CmdletBinding()]
param(
  [string]$Vm = 'actor1',

  [ValidateSet('Check', 'Repair', 'Handoff', 'Confirm')]
  [string]$Mode = 'Check',

  [string]$VagrantRoot = (Join-Path $PSScriptRoot 'mesh')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$readinessScript = Join-Path $PSScriptRoot 'activation-ready.sh'
$provisioner = Join-Path $PSScriptRoot 'provision-guest.sh'
$keyring = Join-Path $PSScriptRoot 'ni-labview-2026-noble-community.asc'
$readinessBuilder = Join-Path $repoRoot 'experiments\provisioner-readiness\goldenActivationReadiness.mjs'
$activationProbe = Join-Path $repoRoot 'experiments\activation\probe-activation.sh'
$activationBuilder = Join-Path $repoRoot 'experiments\activation\buildActivationReceipt.mjs'
$artifactDir = Join-Path $VagrantRoot '.vagrant'
$readinessCapture = Join-Path $artifactDir "golden-$Vm-readiness-capture.json"
$readinessReceipt = Join-Path $artifactDir "golden-$Vm-readiness-receipt.json"
$activationCapture = Join-Path $artifactDir "golden-$Vm-activation-capture.json"
$activationReceipt = Join-Path $artifactDir "golden-$Vm-activation-receipt.json"

function Invoke-Vagrant {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & vagrant @Arguments | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "vagrant $($Arguments -join ' ') exited $LASTEXITCODE"
  }
}

function Invoke-VagrantAllowFailure {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & vagrant @Arguments | Out-Host
  return $LASTEXITCODE
}

function Send-GuestFile {
  param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
  Invoke-Vagrant -Arguments @('upload', $Source, $Destination, $Vm)
}

function Receive-GuestFile {
  param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
  $encoded = (& vagrant ssh $Vm -c "base64 -w 0 '$Source'" | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "could not read guest file $Source from $Vm"
  }
  try {
    [System.IO.File]::WriteAllBytes($Destination, [System.Convert]::FromBase64String($encoded))
  } catch {
    throw "could not decode guest file $Source from $Vm"
  }
}

function Build-ReadinessReceipt {
  if (-not (Test-Path -LiteralPath $readinessCapture -PathType Leaf)) {
    throw 'golden activation readiness capture was not downloaded'
  }
  & node $readinessBuilder $readinessCapture $readinessReceipt | Out-Host
  $nodeExit = $LASTEXITCODE
  if (-not (Test-Path -LiteralPath $readinessReceipt -PathType Leaf)) {
    throw 'golden activation readiness receipt was not created'
  }
  $receipt = Get-Content -LiteralPath $readinessReceipt -Raw | ConvertFrom-Json
  if ($receipt.schema -ne 'labview-benchmark-actor/golden-activation-readiness@1') {
    throw 'golden activation readiness receipt schema is invalid'
  }
  if ($nodeExit -ne 0 -and $receipt.ready -eq $true) {
    throw 'golden activation readiness builder exited unsuccessfully despite a ready receipt'
  }
  return $receipt
}

function Get-Readiness {
  param([switch]$Repair)

  Send-GuestFile -Source $readinessScript -Destination '/tmp/lba-activation-ready.sh'
  $guestArgs = 'chmod 700 /tmp/lba-activation-ready.sh; bash /tmp/lba-activation-ready.sh --check --out /tmp/lba-activation-readiness.json'
  if ($Repair) {
    Send-GuestFile -Source $provisioner -Destination '/tmp/lba-provision-guest.sh'
    Send-GuestFile -Source $keyring -Destination '/tmp/lba-ni-keyring.asc'
    $guestArgs = 'chmod 700 /tmp/lba-activation-ready.sh /tmp/lba-provision-guest.sh; bash /tmp/lba-activation-ready.sh --repair --provisioner /tmp/lba-provision-guest.sh --keyring /tmp/lba-ni-keyring.asc --out /tmp/lba-activation-readiness.json; rm -f /tmp/lba-provision-guest.sh /tmp/lba-ni-keyring.asc'
  }

  $guestExit = Invoke-VagrantAllowFailure -Arguments @('ssh', $Vm, '-c', $guestArgs)
  Receive-GuestFile -Source '/tmp/lba-activation-readiness.json' -Destination $readinessCapture
  $receipt = Build-ReadinessReceipt
  if ($Repair) {
    Write-Host 'golden repair completed; rebooting the guest once without rerunning Vagrant provisioners'
    Invoke-Vagrant -Arguments @('reload', $Vm, '--no-provision')
    return Get-Readiness
  }
  if ($guestExit -ne 0 -and $receipt.ready -eq $true) {
    throw 'guest readiness check failed despite a ready receipt'
  }
  return $receipt
}

function Confirm-Activation {
  Send-GuestFile -Source $activationProbe -Destination '/tmp/lba-probe-activation.sh'
  $probeExit = Invoke-VagrantAllowFailure -Arguments @('ssh', $Vm, '-c', 'chmod 700 /tmp/lba-probe-activation.sh; bash /tmp/lba-probe-activation.sh 20 22 /tmp/lba-activation-capture.json')
  Receive-GuestFile -Source '/tmp/lba-activation-capture.json' -Destination $activationCapture
  & node $activationBuilder $activationCapture $activationReceipt | Out-Host
  $builderExit = $LASTEXITCODE
  if (-not (Test-Path -LiteralPath $activationReceipt -PathType Leaf)) {
    throw 'activation receipt was not created'
  }
  $receipt = Get-Content -LiteralPath $activationReceipt -Raw | ConvertFrom-Json
  if ($builderExit -ne 0 -and $receipt.verdict.activated -eq $true) {
    throw 'activation receipt builder failed despite an activated verdict'
  }
  return [pscustomobject]@{ ProbeExit = $probeExit; Receipt = $receipt }
}

Push-Location $VagrantRoot
try {
  Invoke-Vagrant -Arguments @('validate')
  New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null

  switch ($Mode) {
    'Check' {
      $receipt = Get-Readiness
      if ($receipt.ready) {
        Write-Output "golden actor '$Vm' is activation-ready; run -Mode Handoff for the user-only activation step"
        exit 0
      }
      Write-Output "golden actor '$Vm' is not activation-ready: $($receipt.missing -join ', ')"
      exit 1
    }
    'Repair' {
      $receipt = Get-Readiness -Repair
      if (-not $receipt.ready) {
        Write-Output "golden actor '$Vm' remains incomplete after repair: $($receipt.missing -join ', ')"
        exit 1
      }
      Write-Output "golden actor '$Vm' is activation-ready after repair; run -Mode Handoff"
      exit 0
    }
    'Handoff' {
      $receipt = Get-Readiness
      if (-not $receipt.ready) {
        Write-Output "golden actor '$Vm' is not ready; run -Mode Repair first: $($receipt.missing -join ', ')"
        exit 1
      }
      Write-Output "GOLDEN ACTIVATION HANDOFF for '$Vm'"
      Write-Output '1. Open the VMware console for the golden actor and launch LabVIEW Community Edition.'
      Write-Output '2. Sign in to NI and activate LabVIEW (and VIPM if it requests activation).'
      Write-Output '3. Type credentials only in the VM console; do not provide them to automation or chat.'
      Write-Output "4. After activation, run: pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm $Vm -Mode Confirm"
      exit 0
    }
    'Confirm' {
      $readiness = Get-Readiness
      if (-not $readiness.ready) {
        Write-Output "golden actor '$Vm' is not activation-ready: $($readiness.missing -join ', ')"
        exit 1
      }
      $result = Confirm-Activation
      if ($result.Receipt.verdict.activated -eq $true) {
        Write-Output "golden actor '$Vm' activation is CONFIRMED; activation receipt: $activationReceipt"
        exit 0
      }
      Write-Output "golden actor '$Vm' activation remains unconfirmed; complete the user-only handoff and retry Confirm"
      exit 1
    }
  }
} finally {
  Pop-Location
}
