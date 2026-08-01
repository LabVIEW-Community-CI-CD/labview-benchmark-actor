#requires -Version 5
<#
  Windows twin of experiments/vi-analyzer/run-vi-analyzer-trend.sh: run LabVIEWCLI RunVIAnalyzer N times on the
  Windows cleanroom, time each wall + save each ASCII report + CLI output + a trend-meta.jsonl, so the host
  parses them into the WIN VI Analyzer trend and cross-plane-compares the resultHash against LINUX (it MUST
  match -- a real VI Analyzer run of the SAME config is substrate-independent). Windows needs no Xvfb, but
  LabVIEW needs a DESKTOP: run this in an INTERACTIVE session (the VM console / RDP), NOT over a bare WinRM
  session-0 shell.

  Cross-plane parity: the config MUST be the NI LabVIEWCLIExampleProject (3 VIs -> 69 tests), the same one the
  LINUX trend used, or the resultHash will not match by design.

  Usage (in an interactive PowerShell on the guest):
    powershell -ExecutionPolicy Bypass -File run-vi-analyzer-trend.ps1 [-N 6]
    # override auto-detection if needed:
    #   -LabVIEWCLI "C:\Program Files\National Instruments\Shared\LabVIEW CLI\LabVIEWCLI.exe"
    #   -Config     "...\nilvcli\Examples\LabVIEWCLIExampleProject\ConfigFile.viancfg"
    #   -LabVIEWPath "C:\Program Files\National Instruments\LabVIEW 2026\LabVIEW.exe"
  Output: %USERPROFILE%\vi-analyzer-trend\ (+ a zipped %USERPROFILE%\vi-analyzer-trend-WIN.zip to hand back).
#>
param(
  [int]$N = 6,
  [string]$LabVIEWCLI = "",
  [string]$Config = "",
  [string]$LabVIEWPath = "",
  [string]$Out = "$env:USERPROFILE\vi-analyzer-trend"
)
$ErrorActionPreference = 'Stop'

function Find-First([string[]]$paths) {
  foreach ($p in $paths) { if ($p -and (Test-Path $p)) { return $p } }
  return ""
}

if (-not $LabVIEWCLI) {
  $c = Get-Command LabVIEWCLI.exe -ErrorAction SilentlyContinue
  if ($c) { $LabVIEWCLI = $c.Source }
  else {
    $LabVIEWCLI = Find-First @(
      "C:\Program Files\National Instruments\Shared\LabVIEW CLI\LabVIEWCLI.exe",
      "C:\Program Files (x86)\National Instruments\Shared\LabVIEW CLI\LabVIEWCLI.exe"
    )
  }
}
if (-not $Config) {
  $Config = Find-First @(
    "C:\Program Files\National Instruments\Shared\nilvcli\Examples\LabVIEWCLIExampleProject\ConfigFile.viancfg",
    "C:\Program Files (x86)\National Instruments\Shared\nilvcli\Examples\LabVIEWCLIExampleProject\ConfigFile.viancfg"
  )
}
if (-not $LabVIEWPath) {
  $LabVIEWPath = Find-First @(
    "C:\Program Files\National Instruments\LabVIEW 2026\LabVIEW.exe",
    "C:\Program Files (x86)\National Instruments\LabVIEW 2026\LabVIEW.exe"
  )
}
if (-not $LabVIEWCLI  -or -not (Test-Path $LabVIEWCLI))  { throw "LabVIEWCLI.exe not found -- pass -LabVIEWCLI <path>" }
if (-not $Config      -or -not (Test-Path $Config))      { throw "VI Analyzer config not found -- pass -Config <ConfigFile.viancfg> (must be the LabVIEWCLIExampleProject for cross-plane parity)" }
if (-not $LabVIEWPath -or -not (Test-Path $LabVIEWPath)) { throw "LabVIEW.exe not found -- pass -LabVIEWPath <LabVIEW.exe>" }

if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Path $Out | Out-Null
Remove-Item "$env:USERPROFILE\vi-analyzer-trend.DONE" -ErrorAction SilentlyContinue
"trend start $(Get-Date -Format o) N=$N host=$env:COMPUTERNAME" | Out-File "$Out\run.log" -Encoding utf8
Write-Host "LabVIEWCLI: $LabVIEWCLI"
Write-Host "Config:     $Config"
Write-Host "LabVIEW:    $LabVIEWPath"

for ($i = 1; $i -le $N; $i++) {
  $ii  = "{0:D2}" -f $i
  $rpt = "$Out\report-$ii.txt"
  $cli = "$Out\cli-$ii.txt"
  $sw  = [System.Diagnostics.Stopwatch]::StartNew()
  & $LabVIEWCLI -OperationName RunVIAnalyzer -ConfigPath $Config -ReportPath $rpt -ReportSaveType ASCII -LabVIEWPath $LabVIEWPath *> $cli
  $rc = $LASTEXITCODE
  $sw.Stop()
  $wall = [int]$sw.ElapsedMilliseconds
  $rec = [pscustomobject]@{ run = $i; wallMs = $wall; exit = $rc; report = "report-$ii.txt"; cli = "cli-$ii.txt" }
  ($rec | ConvertTo-Json -Compress) | Add-Content "$Out\trend-meta.jsonl" -Encoding utf8
  "run $i wall=${wall}ms exit=$rc $(Get-Date -Format o)" | Add-Content "$Out\run.log" -Encoding utf8
  Write-Host "run $i wall=${wall}ms exit=$rc"
}

"trend done $(Get-Date -Format o)" | Add-Content "$Out\run.log" -Encoding utf8
Get-Date -Format o | Out-File "$Out\vi-analyzer-trend.DONE" -Encoding utf8
Compress-Archive -Path "$Out\*" -DestinationPath "$Out.zip" -Force
Write-Host "`nDONE -- results in: $Out"
Write-Host "       (trend-meta.jsonl + report-NN.txt + cli-NN.txt + run.log; also zipped to $Out.zip)"
