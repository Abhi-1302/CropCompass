Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)

function Brush([string]$color) {
    New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($color))
}
function Pen([string]$color, [float]$width) {
    $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml($color)), $width
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    return $pen
}

$shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(22, 17, 74, 43))
$graphics.FillEllipse($shadow, 62, 224, 135, 14)
$stem = Pen '#267f43' 10
$graphics.DrawBezier($stem, 129, 165, 121, 127, 125, 99, 145, 75)

$left = New-Object System.Drawing.Drawing2D.GraphicsPath
$left.AddBezier(124, 119, 68, 122, 24, 84, 34, 33)
$left.AddBezier(34, 33, 86, 28, 132, 65, 124, 119)
$left.CloseFigure()
$leftBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.Rectangle]::new(30, 30, 104, 100)), ([System.Drawing.ColorTranslator]::FromHtml('#a8dc59')), ([System.Drawing.ColorTranslator]::FromHtml('#35a153')), 65
$graphics.FillPath($leftBrush, $left)
$outline = Pen '#23824b' 3
$graphics.DrawPath($outline, $left)
$vein = Pen '#d6f29a' 4
$graphics.DrawBezier($vein, 115, 107, 89, 84, 66, 59, 49, 47)

$right = New-Object System.Drawing.Drawing2D.GraphicsPath
$right.AddBezier(132, 105, 127, 52, 164, 20, 217, 25)
$right.AddBezier(217, 25, 231, 73, 193, 113, 132, 105)
$right.CloseFigure()
$rightBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.Rectangle]::new(130, 23, 91, 87)), ([System.Drawing.ColorTranslator]::FromHtml('#85d46b')), ([System.Drawing.ColorTranslator]::FromHtml('#239557')), 110
$graphics.FillPath($rightBrush, $right)
$graphics.DrawPath($outline, $right)
$graphics.DrawBezier($vein, 143, 95, 164, 81, 188, 54, 203, 38)

$body = New-Object System.Drawing.Drawing2D.GraphicsPath
$body.AddBezier(127, 132, 159, 126, 181, 149, 183, 180)
$body.AddBezier(183, 180, 191, 210, 165, 231, 129, 231)
$body.AddBezier(129, 231, 91, 231, 68, 211, 76, 182)
$body.AddBezier(76, 182, 76, 151, 96, 130, 127, 132)
$body.CloseFigure()
$bodyBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.Rectangle]::new(74, 131, 112, 101)), ([System.Drawing.ColorTranslator]::FromHtml('#e1efad')), ([System.Drawing.ColorTranslator]::FromHtml('#a9d970')), 90
$graphics.FillPath($bodyBrush, $body)
$graphics.DrawPath((Pen '#568b48' 3), $body)
$graphics.DrawBezier((Pen '#f4facf' 5), 92, 161, 98, 147, 112, 140, 124, 141)
$graphics.DrawBezier((Pen '#568b48' 4), 77, 190, 62, 186, 57, 178, 59, 173)
$graphics.DrawBezier((Pen '#568b48' 4), 183, 190, 196, 184, 199, 175, 197, 171)
$graphics.FillEllipse((Brush '#233f32'), 102, 171, 10, 14)
$graphics.FillEllipse((Brush '#233f32'), 145, 171, 10, 14)
$graphics.FillEllipse((Brush '#ffffff'), 104, 172, 3, 4)
$graphics.FillEllipse((Brush '#ffffff'), 147, 172, 3, 4)
$graphics.FillEllipse((Brush '#edb4a0'), 87, 187, 16, 8)
$graphics.FillEllipse((Brush '#edb4a0'), 155, 187, 16, 8)
$graphics.DrawArc((Pen '#36543b' 3), 118, 183, 22, 17, 10, 160)
$destination = Join-Path $PSScriptRoot '..\public\sprout.png'
$bitmap.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output 'Generated the original 256x256 transparent Sprout mascot.'
