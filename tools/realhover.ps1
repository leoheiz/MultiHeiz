# Real OS mouse move (and optional click) via user32 SetCursorPos / mouse_event.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\realhover.ps1 -X <phys> -Y <phys>
#   powershell ... -File tools\realhover.ps1 -X <phys> -Y <phys> -Click
# Coordinates are physical screen pixels. Calls SetProcessDPIAware for DPI consistency.
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [int]$SettleMs = 80,
  [switch]$Click
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MhRealHover {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
}
"@

[void][MhRealHover]::SetProcessDPIAware()
if (-not [MhRealHover]::SetCursorPos($X, $Y)) {
  Write-Error "SetCursorPos failed ($X, $Y)"
  exit 2
}
Start-Sleep -Milliseconds $SettleMs
if ($Click) {
  [MhRealHover]::mouse_event([MhRealHover]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [MhRealHover]::mouse_event([MhRealHover]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  Write-Output "moved+clicked phys=($X,$Y)"
} else {
  Write-Output "moved phys=($X,$Y)"
}
exit 0
