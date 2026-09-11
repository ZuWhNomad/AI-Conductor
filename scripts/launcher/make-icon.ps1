# Draws the launcher icon (blue disc with a white "C") with GDI+ and writes conductor.ico next to this script.
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot 'conductor.ico'
$size = 128
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)
$bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 47, 79, 191))
$g.FillEllipse($bg, 4, 4, $size - 8, $size - 8)
$font = New-Object System.Drawing.Font 'Segoe UI', 72, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
$g.DrawString('C', $font, [System.Drawing.Brushes]::White, $rect, $fmt)
$g.Dispose()
$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$fs = [System.IO.File]::Create($out)
$icon.Save($fs)
$fs.Close()
Write-Output "wrote $out ($((Get-Item $out).Length) bytes)"
