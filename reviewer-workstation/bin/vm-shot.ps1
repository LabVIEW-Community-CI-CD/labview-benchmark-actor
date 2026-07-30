$ErrorActionPreference = 'SilentlyContinue'
$vmrun = @(
  'C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe',
  'C:\Program Files\VMware\VMware Workstation\vmrun.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
Write-Host "vmrun=$vmrun"
$vmx = Get-ChildItem 'C:\dev\labview-benchmark-actor\reviewer-workstation\.vagrant\machines\default\vmware_desktop' -Recurse -Filter *.vmx | Select-Object -First 1 -ExpandProperty FullName
Write-Host "vmx=$vmx"
$out = $args[0]
if (-not $out) { $out = Join-Path $env:TEMP 'vm-shot.png' }
# Public Vagrant default guest credentials for local dev boxes (not a secret); override via args[1]/args[2].
$gu = if ($args[1]) { $args[1] } else { 'vagrant' }
$gp = if ($args[2]) { $args[2] } else { 'vagrant' }
if ($vmrun -and $vmx) {
  & $vmrun -T ws -gu $gu -gp $gp captureScreen $vmx $out 2>&1 | Out-Host
  $exists = Test-Path $out
  $size = (Get-Item $out -ErrorAction SilentlyContinue).Length
  Write-Host "captured=$exists size=$size out=$out"
} else {
  Write-Host "MISSING vmrun or vmx"
}
