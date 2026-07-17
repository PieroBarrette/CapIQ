# ============================================================
# Capiq — Génération des icônes PWA (PNG) avec System.Drawing
# Usage :  powershell -ExecutionPolicy Bypass -File tools\make_icons.ps1
# Produit : webapp/icons/icon-192.png et icon-512.png
# (fond plein vert forêt + aiguille de boussole → compatible
#  "any" et "maskable", contenu dans la zone sûre de 80 %)
# ============================================================

Add-Type -AssemblyName System.Drawing

$iconsDir = Join-Path $PSScriptRoot "..\webapp\icons"
New-Item -ItemType Directory -Force $iconsDir | Out-Null

function New-CapiqIcon([int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $bgColor     = [System.Drawing.Color]::FromArgb(255, 14, 23, 18)    # vert forêt sombre
    $ringColor   = [System.Drawing.Color]::FromArgb(70, 232, 239, 233)  # anneau discret
    $northColor  = [System.Drawing.Color]::FromArgb(255, 255, 140, 46)  # orange Capiq
    $southColor  = [System.Drawing.Color]::FromArgb(255, 210, 220, 212) # gris clair
    $centerColor = [System.Drawing.Color]::FromArgb(255, 14, 23, 18)

    # Fond plein (l'OS applique lui-même le masque rond/squircle)
    $bgBrush = New-Object System.Drawing.SolidBrush($bgColor)
    $g.FillRectangle($bgBrush, 0, 0, $size, $size)

    $cx = $size / 2.0
    $cy = $size / 2.0

    # Anneau de boussole
    $ringPen = New-Object System.Drawing.Pen($ringColor, [float]($size * 0.035))
    $rr = $size * 0.36
    $g.DrawEllipse($ringPen, [float]($cx - $rr), [float]($cy - $rr), [float](2 * $rr), [float](2 * $rr))

    # Aiguille : triangle nord (orange) + triangle sud (gris)
    $needleLen  = $size * 0.30
    $needleHalf = $size * 0.105
    $northPts = @(
        [System.Drawing.PointF]::new($cx, $cy - $needleLen),
        [System.Drawing.PointF]::new($cx - $needleHalf, $cy),
        [System.Drawing.PointF]::new($cx + $needleHalf, $cy)
    )
    $southPts = @(
        [System.Drawing.PointF]::new($cx, $cy + $needleLen),
        [System.Drawing.PointF]::new($cx - $needleHalf, $cy),
        [System.Drawing.PointF]::new($cx + $needleHalf, $cy)
    )
    $northBrush = New-Object System.Drawing.SolidBrush($northColor)
    $southBrush = New-Object System.Drawing.SolidBrush($southColor)
    $g.FillPolygon($northBrush, $northPts)
    $g.FillPolygon($southBrush, $southPts)

    # Pivot central
    $dotR = $size * 0.045
    $dotBrush = New-Object System.Drawing.SolidBrush($centerColor)
    $g.FillEllipse($dotBrush, [float]($cx - $dotR), [float]($cy - $dotR), [float](2 * $dotR), [float](2 * $dotR))

    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    $bgBrush.Dispose(); $ringPen.Dispose(); $northBrush.Dispose(); $southBrush.Dispose(); $dotBrush.Dispose()
    Write-Host "OK : $path"
}

New-CapiqIcon 192 (Join-Path $iconsDir "icon-192.png")
New-CapiqIcon 512 (Join-Path $iconsDir "icon-512.png")
