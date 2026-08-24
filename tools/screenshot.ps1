# Capture the primary screen to a PNG so the transparent overlay can be verified.
#
# Graphics.CopyFromScreen cannot do this: the sprite window is layered
# (WS_EX_LAYERED, because it is transparent) and plain BitBlt omits layered
# windows. .NET's CopyPixelOperation enum has no CaptureBlt member, so the
# capture goes through BitBlt directly with SRCCOPY | CAPTUREBLT.
param([string]$Out = "screen.png")

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ScreenGrab {
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(
    IntPtr hdcDest, int xDest, int yDest, int w, int h,
    IntPtr hdcSrc, int xSrc, int ySrc, uint rop);
}
"@

$SRCCOPY   = 0x00CC0020
$CAPTUREBLT = 0x40000000

$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)

$desktop = [ScreenGrab]::GetDesktopWindow()
$srcDC = [ScreenGrab]::GetWindowDC($desktop)
$dstDC = $g.GetHdc()
[void][ScreenGrab]::BitBlt($dstDC, 0, 0, $b.Width, $b.Height, $srcDC, $b.X, $b.Y, ($SRCCOPY -bor $CAPTUREBLT))
$g.ReleaseHdc($dstDC)
[void][ScreenGrab]::ReleaseDC($desktop, $srcDC)

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "$Out $($b.Width)x$($b.Height)"
