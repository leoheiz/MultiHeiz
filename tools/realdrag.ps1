# Real OS mouse drag / click / double-click via user32 (SetCursorPos + SendInput).
# DPI-aware. Coordinates are physical screen pixels.
# Usage:
#   -Mode Click -X n -Y n
#   -Mode DoubleClick -X n -Y n
#   -Mode Drag -X n -Y n -DeltaX n -DeltaY n [-Steps n]
param(
  [ValidateSet('Click', 'DoubleClick', 'Drag')]
  [string]$Mode = 'Click',
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [int]$DeltaX = 0,
  [int]$DeltaY = 0,
  [int]$Steps = 8,
  [int]$SettleMs = 60
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MhRealDrag {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  public const int INPUT_MOUSE = 0;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public int type;
    public InputUnion u;
  }

  public static void MouseFlag(uint flags) {
    INPUT[] inputs = new INPUT[1];
    inputs[0].type = INPUT_MOUSE;
    inputs[0].u.mi.dwFlags = flags;
    uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != 1) {
      throw new InvalidOperationException("SendInput failed flags=" + flags + " err=" + Marshal.GetLastWin32Error());
    }
  }
}
"@

[void][MhRealDrag]::SetProcessDPIAware()

function Move-Cursor([int]$cx, [int]$cy) {
  if (-not [MhRealDrag]::SetCursorPos($cx, $cy)) {
    throw "SetCursorPos failed ($cx, $cy)"
  }
}

Move-Cursor $X $Y
Start-Sleep -Milliseconds $SettleMs

if ($Mode -eq 'Click') {
  [MhRealDrag]::MouseFlag([MhRealDrag]::MOUSEEVENTF_LEFTDOWN)
  Start-Sleep -Milliseconds 30
  [MhRealDrag]::MouseFlag([MhRealDrag]::MOUSEEVENTF_LEFTUP)
  Write-Output "click phys=($X,$Y)"
  exit 0
}

if ($Mode -eq 'DoubleClick') {
  [MhRealDrag]::MouseFlag([MhRealDrag]::MOUSEEVENTF_LEFTDOWN)
  Start-Sleep -Milliseconds 20
  [MhRealDrag]::MouseFlag([MhRealDrag]::MOUSEEVENTF_LEFTUP)
  Start-Sleep -Milliseconds 40
  [MhRealDrag]::MouseFlag([MhRealDrag]::MOUSEEVENTF_LEFTDOWN)
  Start-Sleep -Milliseconds 20
  [MhRealDrag]::MouseFlag([MhRealDrag]::MOUSEEVENTF_LEFTUP)
  Write-Output "dblclick phys=($X,$Y)"
  exit 0
}

# Drag
if ($Steps -lt 1) { $Steps = 1 }
[MhRealDrag]::MouseFlag([MhRealDrag]::MOUSEEVENTF_LEFTDOWN)
Start-Sleep -Milliseconds 40
for ($i = 1; $i -le $Steps; $i++) {
  $nx = [int]([math]::Round($X + ($DeltaX * $i / $Steps)))
  $ny = [int]([math]::Round($Y + ($DeltaY * $i / $Steps)))
  Move-Cursor $nx $ny
  Start-Sleep -Milliseconds 25
}
Start-Sleep -Milliseconds 40
[MhRealDrag]::MouseFlag([MhRealDrag]::MOUSEEVENTF_LEFTUP)
$endX = $X + $DeltaX
$endY = $Y + $DeltaY
Write-Output "drag phys=($X,$Y)->($endX,$endY) steps=$Steps"
exit 0
