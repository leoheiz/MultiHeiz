# Real OS mouse click via user32 (SetCursorPos + mouse_event).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools\realclick.ps1 -X <phys> -Y <phys>
# Coordinates are physical screen pixels. Calls SetProcessDPIAware so DPI scaling is consistent.
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [int]$SettleMs = 80
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MhRealClick {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
}
"@

[void][MhRealClick]::SetProcessDPIAware()
if (-not [MhRealClick]::SetCursorPos($X, $Y)) {
  Write-Error "SetCursorPos failed ($X, $Y)"
  exit 2
}
Start-Sleep -Milliseconds $SettleMs
[MhRealClick]::mouse_event([MhRealClick]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[MhRealClick]::mouse_event([MhRealClick]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
Write-Output "clicked phys=($X,$Y)"
exit 0
