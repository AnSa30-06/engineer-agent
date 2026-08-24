# Capture one window by title, including its DirectComposition content.
#
# The sprite overlay is a transparent Chromium window. BitBlt from the desktop
# DC cannot see that surface, so verification goes through PrintWindow with
# PW_RENDERFULLCONTENT. The handle comes from EnumWindows rather than
# FindWindow, which does not match Electron's frameless windows reliably.
param([string]$Title = "Engineer", [string]$Out = "window.png")

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class WinCap{
 public delegate bool Cb(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int i);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
 [StructLayout(LayoutKind.Sequential)] public struct R{public int L,T,Rr,B;}
}
"@

$found = [IntPtr]::Zero
$cb = [WinCap+Cb]{
  param($h, $p)
  if ([WinCap]::IsWindowVisible($h)) {
    $t = New-Object Text.StringBuilder 256
    [void][WinCap]::GetWindowTextW($h, $t, 256)
    if ($t.ToString() -eq $Title) { $script:found = $h; return $false }
  }
  return $true
}
[void][WinCap]::EnumWindows($cb, [IntPtr]::Zero)
if ($found -eq [IntPtr]::Zero) { Write-Output "NOT FOUND: $Title"; exit 1 }

$r = New-Object WinCap+R
[void][WinCap]::GetWindowRect($found, [ref]$r)
$w = $r.Rr - $r.L; $ht = $r.B - $r.T

$bmp = New-Object System.Drawing.Bitmap $w, $ht, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][WinCap]::PrintWindow($found, $hdc, 0x2)   # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

$ex = [WinCap]::GetWindowLong($found, -20)
$flags = @()
if ($ex -band 0x8)     { $flags += "topmost" }
if ($ex -band 0x80)    { $flags += "toolwindow(no-taskbar)" }
if ($ex -band 0x80000) { $flags += "layered" }
Write-Output "$Out rect=$($r.L),$($r.T) ${w}x${ht} exstyle=0x$('{0:X}' -f $ex) $($flags -join ' ')"
