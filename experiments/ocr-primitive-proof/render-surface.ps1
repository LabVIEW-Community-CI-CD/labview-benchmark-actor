param(
  [string]$OutPath = "$env:TEMP\ocr-proof\surface.png",
  [string]$TimeText = "00:00:12.34",
  [string]$BitStream = "1010010100000000000000000000000000000000",
  [string]$StatusText = "Waiting for a controlled click target or trigger.",
  [int]$TimeFontSize = 64
)

Add-Type -AssemblyName System.Drawing

$dir = Split-Path -Parent $OutPath
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

# Mimic the mprr self-test surface: light background (250,250,248), dark text,
# large monospace stopwatch time, a bit-stream line, and a status line.
$width = 1600
$height = 500
$bmp = [System.Drawing.Bitmap]::new($width, $height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $g.Clear([System.Drawing.Color]::FromArgb(250, 250, 248))

  $dark = [System.Drawing.Color]::FromArgb(24, 24, 24)
  $brush = [System.Drawing.SolidBrush]::new($dark)

  $timeFont   = [System.Drawing.Font]::new("Consolas", $TimeFontSize, [System.Drawing.FontStyle]::Bold)
  $bitFont    = [System.Drawing.Font]::new("Consolas", 36, [System.Drawing.FontStyle]::Regular)
  $statusFont = [System.Drawing.Font]::new("Segoe UI", 30, [System.Drawing.FontStyle]::Regular)

  $g.DrawString($TimeText,   $timeFont,   $brush, [single]60, [single]60)
  $g.DrawString($BitStream,  $bitFont,    $brush, [single]60, [single]220)
  $g.DrawString($StatusText, $statusFont, $brush, [single]60, [single]340)

  $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output $OutPath
}
finally {
  $timeFont.Dispose(); $bitFont.Dispose(); $statusFont.Dispose()
  $brush.Dispose(); $g.Dispose(); $bmp.Dispose()
}
