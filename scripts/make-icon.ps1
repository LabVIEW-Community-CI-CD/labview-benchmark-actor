# Generates media/icon.png (128x128) for the Marketplace listing: a benchmark metric polyline with a
# draggable time-cursor line -- the extension's signature viewer surface -- on a dark VS Code-ish panel.
# Deterministic (fixed geometry). Windows-only (System.Drawing). Regenerate: pwsh -File scripts/make-icon.ps1
Add-Type -AssemblyName System.Drawing
$size = 128
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

# Rounded dark panel background.
$bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 24, 26, 33))
$g.FillRectangle($bg, 0, 0, $size, $size)
$panel = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 30, 34, 44))
$g.FillRectangle($panel, 12, 12, $size - 24, $size - 24)

# Baseline grid (subtle).
$grid = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60, 120, 130, 150), 1)
for ($y = 32; $y -lt ($size - 20); $y += 24) { $g.DrawLine($grid, 16, $y, $size - 16, $y) }

# Benchmark metric polyline (accent teal).
$line = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 78, 201, 176), 4)
$line.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$pts = @(
  (New-Object System.Drawing.PointF(20, 84)),
  (New-Object System.Drawing.PointF(38, 74)),
  (New-Object System.Drawing.PointF(54, 90)),
  (New-Object System.Drawing.PointF(70, 50)),
  (New-Object System.Drawing.PointF(88, 62)),
  (New-Object System.Drawing.PointF(108, 34))
)
$g.DrawLines($line, [System.Drawing.PointF[]]$pts)

# Draggable time-cursor (amber vertical line + handle dot) at x=70 -- the extension's signature control.
$cursor = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 240, 180, 60), 3)
$g.DrawLine($cursor, 70, 20, 70, $size - 18)
$dot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 240, 180, 60))
$g.FillEllipse($dot, 70 - 6, 50 - 6, 12, 12)

$g.Dispose()
$out = Join-Path (Split-Path $PSScriptRoot -Parent) 'media\icon.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "wrote $out ($((Get-Item $out).Length) bytes)"
