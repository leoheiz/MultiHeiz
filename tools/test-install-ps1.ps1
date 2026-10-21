#Requires -Version 5.1
<#
.SYNOPSIS
  Test install.ps1 against a local mock GitHub API + TEST-ONLY setup.
  Never runs the production MultiHeiz setup. Snapshots Leo's real install.
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root 'package.json'))) {
  $Root = (Get-Location).Path
}

$RealInstallDir = 'C:\Program Files\MultiHeiz'
$RealUninstallGuid = '45291e89-75cf-5787-a593-ee8a85be971f'
$RealUninstallKey = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$RealUninstallGuid"
$RealStartMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\MultiHeiz.lnk'

function Write-Step([string]$msg) { Write-Host "==> $msg" }
function Fail([string]$msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; exit 1 }
function Assert($cond, [string]$msg) {
  $ok = $false
  if ($cond -is [bool]) { $ok = $cond }
  elseif ($null -eq $cond) { $ok = $false }
  else { $ok = [bool]$cond }
  if (-not $ok) { Fail $msg }
}

function Get-FileHashSafe([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $fs = [System.IO.File]::OpenRead($path)
    try {
      $bytes = $sha.ComputeHash($fs)
      return ([BitConverter]::ToString($bytes) -replace '-', '')
    } finally { $fs.Dispose() }
  } finally { $sha.Dispose() }
}

function Snapshot-RealInstall {
  $exe = Join-Path $RealInstallDir 'MultiHeiz.exe'
  $files = @()
  if (Test-Path -LiteralPath $RealInstallDir) {
    $files = @(Get-ChildItem -LiteralPath $RealInstallDir -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  }
  $reg = $null
  if (Test-Path -LiteralPath $RealUninstallKey) {
    $reg = Get-ItemProperty -LiteralPath $RealUninstallKey | Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString, QuietUninstallString
  }
  $shortcuts = @()
  foreach ($p in @(
      $RealStartMenu,
      (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\MultiHeiz\MultiHeiz.lnk'),
      (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MultiHeiz.lnk'),
      (Join-Path $env:USERPROFILE 'Desktop\MultiHeiz.lnk'),
      (Join-Path $env:PUBLIC 'Desktop\MultiHeiz.lnk')
    )) {
    if (Test-Path -LiteralPath $p) { $shortcuts += $p }
  }
  return [pscustomobject]@{
    exeExists = Test-Path -LiteralPath $exe
    exeHash   = Get-FileHashSafe $exe
    fileCount = $files.Count
    reg       = $reg
    shortcutHashes = @(
      foreach ($s in $shortcuts) {
        [pscustomobject]@{ path = $s; hash = Get-FileHashSafe $s; lastWrite = (Get-Item -LiteralPath $s).LastWriteTimeUtc }
      }
    )
  }
}

function Assert-RealInstallUnchanged($before, $after) {
  Assert ($before.exeExists -eq $after.exeExists) 'real MultiHeiz.exe existence changed'
  Assert ($before.exeHash -eq $after.exeHash) "real MultiHeiz.exe hash changed"
  Assert ($before.fileCount -eq $after.fileCount) 'real install file count changed'
  if ($null -ne $before.reg -or $null -ne $after.reg) {
    Assert ($null -ne $before.reg -and $null -ne $after.reg) 'real HKLM uninstall key presence changed'
    Assert ($before.reg.DisplayVersion -eq $after.reg.DisplayVersion) 'real HKLM DisplayVersion changed'
    Assert ($before.reg.UninstallString -eq $after.reg.UninstallString) 'real HKLM UninstallString changed'
  }
  Assert ($before.shortcutHashes.Count -eq $after.shortcutHashes.Count) 'real shortcut count changed'
  foreach ($b in $before.shortcutHashes) {
    $a = $after.shortcutHashes | Where-Object { $_.path -eq $b.path } | Select-Object -First 1
    Assert ($null -ne $a) "real shortcut missing: $($b.path)"
    Assert ($b.hash -eq $a.hash) "real shortcut hash changed: $($b.path)"
    Assert ($b.lastWrite -eq $a.lastWrite) "real shortcut LastWriteTime changed: $($b.path)"
  }
}

function Get-TestUninstallKey {
  $base = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  if (-not (Test-Path $base)) { return $null }
  foreach ($item in @(Get-ChildItem $base -ErrorAction SilentlyContinue)) {
    try {
      $p = Get-ItemProperty -LiteralPath $item.PSPath -ErrorAction Stop
      if ($p.DisplayName -like '*MultiHeizInstallerTest*') { return $item.PSPath }
    } catch { }
  }
  return $null
}

function Uninstall-TestVariant {
  $ukey = Get-TestUninstallKey
  if (-not $ukey) { return }
  $props = Get-ItemProperty -LiteralPath $ukey
  $quiet = [string]$props.QuietUninstallString
  $uninst = [string]$props.UninstallString
  $exe = $null
  $dir = $null
  if ($quiet -match '^"([^"]+)"') { $exe = $Matches[1] }
  elseif ($uninst -match '^"([^"]+)"') { $exe = $Matches[1] }
  if ($exe) { $dir = Split-Path -Parent $exe }
  if ($exe -and (Test-Path -LiteralPath $exe)) {
    $args = @('/S', '/currentuser')
    if ($dir) { $args += "_?=$dir" }
    Write-Host "  Uninstalling test variant: $exe"
    Start-Process -FilePath $exe -ArgumentList $args -Wait -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 2
  }
}

Write-Step 'Snapshot real MultiHeiz install'
$before = Snapshot-RealInstall

Write-Step 'Ensure TEST-ONLY setup exists'
$testOut = Join-Path $Root 'dist-installertest'
$setup = Get-ChildItem $testOut -Filter 'MultiHeizInstallerTest-*-setup.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $setup) {
  Write-Host '  Building installertest (electron-builder)...'
  if (Test-Path $testOut) { Remove-Item $testOut -Recurse -Force }
  Push-Location $Root
  try {
    & npx --yes electron-builder --win nsis --config electron-builder.installertest.yml
    Assert ($LASTEXITCODE -eq 0) "electron-builder failed: $LASTEXITCODE"
  } finally { Pop-Location }
  $setup = Get-ChildItem $testOut -Filter 'MultiHeizInstallerTest-*-setup.exe' | Select-Object -First 1
}
Assert ($null -ne $setup) "test setup missing in $testOut"
Write-Host "  Setup: $($setup.FullName)"

$setupHash = (Get-FileHashSafe $setup.FullName).ToLowerInvariant()
$ver = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version
$setupName = $setup.Name

$serveRoot = Join-Path $env:TEMP ('mh-mock-gh-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$assetsDir = Join-Path $serveRoot 'assets'
New-Item -ItemType Directory -Path $assetsDir | Out-Null
Copy-Item -LiteralPath $setup.FullName -Destination (Join-Path $assetsDir $setupName)
Set-Content -LiteralPath (Join-Path $assetsDir 'SHA256SUMS.txt') -Value "$setupHash  $setupName`n" -Encoding ascii
Set-Content -LiteralPath (Join-Path $assetsDir 'SHA256SUMS-BAD.txt') -Value $(('0' * 64) + "  $setupName`n") -Encoding ascii

# Start mock on ephemeral port (node prints MOCK_READY port=N)
$mockProc = Start-Process -FilePath 'node' -ArgumentList @(
  (Join-Path $Root 'tools\mock-github-release-server.js'),
  '--port', '0',
  '--root', $serveRoot,
  '--latest', (Join-Path $serveRoot 'latest.json'),
  '--bad-latest', (Join-Path $serveRoot 'latest-bad.json')
) -WorkingDirectory $Root -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $serveRoot 'mock-out.txt') -RedirectStandardError (Join-Path $serveRoot 'mock-err.txt')

# Write JSON after we know the port — start with placeholder, restart approach:
# Simpler: pick a fixed free port first.
Stop-Process -Id $mockProc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 200

$port = 0
for ($try = 18000; $try -lt 18200; $try++) {
  try {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $try)
    $l.Start(); $l.Stop()
    $port = $try
    break
  } catch { }
}
Assert ($port -gt 0) 'no free port for mock server'
$prefix = "http://127.0.0.1:$port/"

$releaseObj = [ordered]@{
  tag_name = "v$ver"
  name = "MultiHeiz $ver"
  assets = @(
    [ordered]@{ name = $setupName; browser_download_url = "${prefix}assets/$setupName" },
    [ordered]@{ name = 'SHA256SUMS.txt'; browser_download_url = "${prefix}assets/SHA256SUMS.txt" }
  )
}
($releaseObj | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $serveRoot 'latest.json') -Encoding utf8

$badObj = [ordered]@{
  tag_name = "v$ver"
  name = "MultiHeiz $ver"
  assets = @(
    [ordered]@{ name = $setupName; browser_download_url = "${prefix}assets/$setupName" },
    [ordered]@{ name = 'SHA256SUMS.txt'; browser_download_url = "${prefix}assets/SHA256SUMS-BAD.txt" }
  )
}
($badObj | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $serveRoot 'latest-bad.json') -Encoding utf8

Write-Step "Mock GitHub API on $prefix"
$mockOut = Join-Path $serveRoot 'mock-out.txt'
$mockErr = Join-Path $serveRoot 'mock-err.txt'
$mockProc = Start-Process -FilePath 'node' -ArgumentList @(
  (Join-Path $Root 'tools\mock-github-release-server.js'),
  '--port', "$port",
  '--root', $serveRoot,
  '--latest', (Join-Path $serveRoot 'latest.json'),
  '--bad-latest', (Join-Path $serveRoot 'latest-bad.json')
) -WorkingDirectory $Root -PassThru -WindowStyle Hidden -RedirectStandardOutput $mockOut -RedirectStandardError $mockErr

$ready = $false
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $mockOut) {
    $txt = Get-Content $mockOut -Raw -ErrorAction SilentlyContinue
    if ($txt -match 'MOCK_READY') { $ready = $true; break }
  }
  if ($mockProc.HasExited) { break }
  Start-Sleep -Milliseconds 200
}
if (-not $ready) {
  $err = if (Test-Path $mockErr) { Get-Content $mockErr -Raw } else { '' }
  Fail "mock server failed to start: $err"
}

$installPs1 = Join-Path $Root 'install.ps1'

try {
  Uninstall-TestVariant

  Write-Step 'install.ps1 - first install (test variant)'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $installPs1 `
    -ReleaseJsonUrl "${prefix}releases/latest" `
    -AssetPattern 'MultiHeizInstallerTest-*-setup.exe' `
    -ProductName 'MultiHeizInstallerTest'
  Assert ($LASTEXITCODE -eq 0) "install.ps1 exit $LASTEXITCODE"
  $ukey = Get-TestUninstallKey
  Assert ($null -ne $ukey) 'MultiHeizInstallerTest not in HKCU after install'
  Write-Host "  Installed OK: $ukey"

  Write-Step 'install.ps1 - same version no-op'
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $installPs1 `
    -ReleaseJsonUrl "${prefix}releases/latest" `
    -AssetPattern 'MultiHeizInstallerTest-*-setup.exe' `
    -ProductName 'MultiHeizInstallerTest' 2>&1 | Out-String
  Write-Host $out
  Assert ($LASTEXITCODE -eq 0) "second install.ps1 exit $LASTEXITCODE"
  Assert ($out -match 'instalado|Nada a fazer|already') ('expected no-op message, got: ' + $out)

  Write-Step 'install.ps1 - tampered SHA256 must abort'
  $code = 0
  $errOut = & powershell -NoProfile -ExecutionPolicy Bypass -File $installPs1 `
    -ReleaseJsonUrl "${prefix}releases/latest-bad" `
    -AssetPattern 'MultiHeizInstallerTest-*-setup.exe' `
    -ProductName 'MultiHeizInstallerTest' `
    -Force 2>&1 | Out-String
  $code = $LASTEXITCODE
  Write-Host $errOut
  Assert ($code -ne 0) 'tampered SHA must fail'
  Assert ($errOut -match 'SHA256|confere|ERRO|mismatch') ('expected SHA error, got: ' + $errOut)
  Assert ($null -ne (Get-TestUninstallKey)) 'test install should remain after failed tampered run'

  Write-Step 'Uninstall test variant'
  Uninstall-TestVariant
  Assert ($null -eq (Get-TestUninstallKey)) 'HKCU key still present after uninstall'
} finally {
  try {
    if ($mockProc -and -not $mockProc.HasExited) { Stop-Process -Id $mockProc.Id -Force -ErrorAction SilentlyContinue }
  } catch { }
  if (Test-Path -LiteralPath $serveRoot) {
    Remove-Item -LiteralPath $serveRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  Uninstall-TestVariant
}

Write-Step 'Re-check real MultiHeiz install'
$after = Snapshot-RealInstall
Assert-RealInstallUnchanged $before $after
Write-Host '  Real install unchanged'

Write-Host ''
Write-Host 'PASS: test:install-ps1'
exit 0
