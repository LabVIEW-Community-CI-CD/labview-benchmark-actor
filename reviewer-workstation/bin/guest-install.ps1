#Requires -Version 5.1
<#
  Guest-side installer for the reviewer flow. Runs on the VM (admin, via WinRM as 'vagrant') but installs
  the extension into the INTERACTIVE console user's VS Code profile -- the account the human reviewer is
  actually logged in as -- so the candidate is visible to them. See issue #121.

  The interactive profile FOLDER can differ from the username (e.g. user 'vitech' -> folder 'VI-Tech'),
  so the profile path is resolved from the user's SID via Win32_UserProfile, not string-built from the name.
#>
param([Parameter(Mandatory)][string]$Vsix)
$ErrorActionPreference = 'Stop'
$expected = 'svelderrainruiz.labview-benchmark-actor'

$consoleUser = (Get-CimInstance Win32_ComputerSystem).UserName   # e.g. actor\vitech (null if no one logged on)
$extDirArgs = @()
$target = "installer (WinRM) profile"
if ($consoleUser) {
  try {
    $sid = (New-Object System.Security.Principal.NTAccount($consoleUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
    $profilePath = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }).LocalPath
    if ($profilePath) {
      $extDir = Join-Path $profilePath '.vscode\extensions'
      New-Item -ItemType Directory -Force -Path $extDir | Out-Null
      $extDirArgs = @('--extensions-dir', $extDir)
      $target = "$consoleUser -> $extDir"
    }
  } catch {
    Write-Host "[guest-install] WARN could not resolve console-user profile ($consoleUser): $($_.Exception.Message)"
  }
} else {
  Write-Host "[guest-install] WARN no interactive console user detected; installing into the WinRM profile."
}

Write-Host "[guest-install] target profile: $target"
# The guest `code` CLI prints Node deprecation warnings to stderr; under -ErrorActionPreference Stop that
# stderr is promoted to a terminating NativeCommandError. Switch to Continue around the native calls and
# judge success by OUTCOME (list-extensions), not the exit stream.
$ErrorActionPreference = 'Continue'
& code --install-extension $Vsix @extDirArgs --force 2>&1 | ForEach-Object { Write-Host "    $_" }

# Verify by OUTCOME in the target profile.
if ($extDirArgs.Count) { $ids = & code --list-extensions --show-versions @extDirArgs 2>$null }
else { $ids = & code --list-extensions --show-versions 2>$null }
$hit = @($ids | Where-Object { $_ -match [regex]::Escape($expected) })
if ($hit.Count -eq 0) {
  Write-Host "[guest-install] VERIFY FAILED: $expected not present in the target profile."
  exit 1
}
Write-Host "[guest-install] verified in target profile: $($hit -join ', ')"
