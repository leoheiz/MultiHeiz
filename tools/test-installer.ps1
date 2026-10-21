#Requires -Version 5.1
<#
.SYNOPSIS
  Safe silent install/uninstall test for MultiHeiz NSIS installer.

  NEVER touches Leo's real per-machine install at C:\Program Files\MultiHeiz
  (HKLM uninstall GUID 45291e89-75cf-5787-a593-ee8a85be971f).

  Builds and tests a TEST-ONLY installer (electron-builder.installertest.yml)
  with appId com.leo.multiheiz.installertest / productName MultiHeizInstallerTest
  so Start Menu shortcuts and registry keys cannot overwrite the real app.

  Also statically verifies the real dist\MultiHeiz-1.3.0-setup.exe exists after
  npm run dist:win (does not run it).
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
$RealStartMenuAlt = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\MultiHeiz\MultiHeiz.lnk'

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
  foreach ($p in @($RealStartMenu, $RealStartMenuAlt)) {
    if (Test-Path -LiteralPath $p) { $shortcuts += $p }
  }
  # User Start Menu / Desktop "MultiHeiz.lnk" (do not modify)
  $userSm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MultiHeiz.lnk'
  $desk = Join-Path $env:USERPROFILE 'Desktop\MultiHeiz.lnk'
  foreach ($p in @($userSm, $desk)) {
    if (Test-Path -LiteralPath $p) { $shortcuts += $p }
  }
  return [pscustomobject]@{
    exeExists = Test-Path -LiteralPath $exe
    exeHash   = Get-FileHashSafe $exe
    fileCount = $files.Count
    reg       = $reg
    shortcuts = $shortcuts
    shortcutHashes = @(
      foreach ($s in $shortcuts) {
        [pscustomobject]@{ path = $s; hash = Get-FileHashSafe $s; lastWrite = (Get-Item -LiteralPath $s).LastWriteTimeUtc }
      }
    )
  }
}

function Assert-RealInstallUnchanged($before, $after) {
  Assert ($before.exeExists -eq $after.exeExists) 'real MultiHeiz.exe existence changed'
  Assert ($before.exeHash -eq $after.exeHash) "real MultiHeiz.exe hash changed: $($before.exeHash) -> $($after.exeHash)"
  Assert ($before.fileCount -eq $after.fileCount) "real install file count changed: $($before.fileCount) -> $($after.fileCount)"
  if ($null -ne $before.reg -or $null -ne $after.reg) {
    Assert ($null -ne $before.reg -and $null -ne $after.reg) 'real HKLM uninstall key presence changed'
    Assert ($before.reg.DisplayVersion -eq $after.reg.DisplayVersion) 'real HKLM DisplayVersion changed'
    Assert ($before.reg.InstallLocation -eq $after.reg.InstallLocation) 'real HKLM InstallLocation changed'
    Assert ($before.reg.UninstallString -eq $after.reg.UninstallString) 'real HKLM UninstallString changed'
  }
  Assert ($before.shortcutHashes.Count -eq $after.shortcutHashes.Count) 'real shortcut count changed'
  for ($i = 0; $i -lt $before.shortcutHashes.Count; $i++) {
    $b = $before.shortcutHashes[$i]
    $a = $after.shortcutHashes | Where-Object { $_.path -eq $b.path } | Select-Object -First 1
    Assert ($null -ne $a) "real shortcut missing: $($b.path)"
    Assert ($b.hash -eq $a.hash) "real shortcut hash changed: $($b.path)"
    Assert ($b.lastWrite -eq $a.lastWrite) "real shortcut LastWriteTime changed: $($b.path)"
  }
}

function Read-Shortcut([string]$lnkPath) {
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($lnkPath)
  return [pscustomobject]@{
    Path = $lnkPath
    TargetPath = $lnk.TargetPath
    IconLocation = $lnk.IconLocation
    WorkingDirectory = $lnk.WorkingDirectory
  }
}

function Get-LnkAumid([string]$lnkPath) {
  $shell = New-Object -ComObject Shell.Application
  $dir = Split-Path -Parent $lnkPath
  $name = Split-Path -Leaf $lnkPath
  $folder = $shell.NameSpace($dir)
  if (-not $folder) { return $null }
  $item = $folder.ParseName($name)
  if (-not $item) { return $null }
  return [string]$item.ExtendedProperty('System.AppUserModel.ID')
}

function Get-TestUninstallKey {
  # electron-builder GUID from appId com.leo.multiheiz.installertest
  $base = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  if (-not (Test-Path $base)) { return $null }
  foreach ($item in @(Get-ChildItem $base -ErrorAction SilentlyContinue)) {
    try {
      $p = Get-ItemProperty -LiteralPath $item.PSPath -ErrorAction Stop
      if ($p.DisplayName -like '*MultiHeizInstallerTest*') { return $item.PSPath }
      if ($p.InstallLocation -and $p.InstallLocation -like '*MultiHeizInstallerTest*') { return $item.PSPath }
    } catch { }
  }
  return $null
}

Write-Step 'Snapshot real MultiHeiz install (must stay unchanged)'
$before = Snapshot-RealInstall
if ($before.exeExists) {
  Write-Host "  Real install present: hash=$($before.exeHash) files=$($before.fileCount)"
} else {
  Write-Host '  Real install not found at Program Files (ok)'
}
if ($null -ne $before.reg) {
  Write-Host "  HKLM uninstall: $($before.reg.DisplayName) $($before.reg.DisplayVersion)"
}

# Abort if a real per-user MultiHeiz exists at default location AND we'd collide -
# we always use a different productName, so default LOCALAPPDATA\Programs\MultiHeiz is fine to leave alone.
$realPerUser = Join-Path $env:LOCALAPPDATA 'Programs\MultiHeiz'
if (Test-Path -LiteralPath (Join-Path $realPerUser 'MultiHeiz.exe')) {
  Write-Host "  Note: per-user MultiHeiz at $realPerUser (will not touch; test uses MultiHeizInstallerTest)"
}

Write-Step 'Decision: use TEST-ONLY installer (different appId) - real setup never executed'
# Reason: same appId GUID as Leo's per-machine install; installSection may interact with
# uninstall registry. Safer to never run the production setup against this PC.

Write-Step 'Build test-only NSIS installer'
$testOut = Join-Path $Root 'dist-installertest'
if (Test-Path $testOut) { Remove-Item $testOut -Recurse -Force }
Push-Location $Root
try {
  & npx --yes electron-builder --win nsis --config electron-builder.installertest.yml
  Assert ($LASTEXITCODE -eq 0) "electron-builder installertest failed: $LASTEXITCODE"
} finally {
  Pop-Location
}

$setup = Get-ChildItem $testOut -Filter 'MultiHeizInstallerTest-*-setup.exe' | Select-Object -First 1
Assert ($null -ne $setup) "test setup.exe not found in $testOut"
Write-Host "  Setup: $($setup.FullName)"

$installDir = Join-Path $env:TEMP ('mh-inst-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $installDir | Out-Null
$fakeUserData = Join-Path $env:TEMP ('mh-inst-ud-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $fakeUserData | Out-Null
Set-Content -Path (Join-Path $fakeUserData 'keep-me.txt') -Value 'should survive silent uninstall'

# Place a marker under the product userData name so silent uninstall must KEEP it
# (installer.nsh only deletes on Yes / /DELETEDATA). We use a throwaway copy under
# APPDATA\MultiHeizInstallerTest created by us - not Leo's MultiHeiz folder.
$testAppData = Join-Path $env:APPDATA 'MultiHeizInstallerTest'
$weCreatedAppData = -not (Test-Path -LiteralPath $testAppData)
if ($weCreatedAppData) {
  New-Item -ItemType Directory -Path $testAppData | Out-Null
}
$marker = Join-Path $testAppData 'test-installer-keep.txt'
Set-Content -LiteralPath $marker -Value 'keep'

Write-Step "Silent per-user install to $installDir (no UAC)"
$p = Start-Process -FilePath $setup.FullName -ArgumentList @('/S', '/currentuser', "/D=$installDir") -PassThru -Wait -WindowStyle Hidden
Assert ($p.ExitCode -eq 0 -or $null -eq $p.ExitCode) "installer exit code $($p.ExitCode)"

# NSIS /S can return before files flush; wait briefly
$exe = Join-Path $installDir 'MultiHeizInstallerTest.exe'
$uninst = Join-Path $installDir 'Uninstall MultiHeizInstallerTest.exe'
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  if ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $uninst)) { break }
  Start-Sleep -Milliseconds 500
}
Assert (Test-Path -LiteralPath $exe) "installed exe missing: $exe"
Assert (Test-Path -LiteralPath $uninst) "uninstaller missing: $uninst"
Write-Host "  Installed exe + uninstaller OK"

$smLnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MultiHeizInstallerTest.lnk'
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $smLnk) { break }
  # sometimes under a folder
  $alt = Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Filter '*MultiHeizInstallerTest*.lnk' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($alt) { $smLnk = $alt.FullName; break }
  Start-Sleep -Milliseconds 400
}
Assert (Test-Path -LiteralPath $smLnk) "Start Menu shortcut missing (expected MultiHeizInstallerTest.lnk)"
$lnk = Read-Shortcut $smLnk
Write-Host "  Shortcut target=$($lnk.TargetPath) icon=$($lnk.IconLocation)"
Assert ($lnk.TargetPath -eq $exe) "shortcut target mismatch: $($lnk.TargetPath) vs $exe"
Assert (
  ($lnk.IconLocation -like "*MultiHeizInstallerTest*") -or
  ($lnk.IconLocation -like "*$exe*") -or
  ($lnk.IconLocation -eq "$exe,0")
) "shortcut icon should reference app: $($lnk.IconLocation)"

$expectedAumid = 'com.leo.multiheiz.installertest'
$aumid = Get-LnkAumid $smLnk
Write-Host "  Start Menu AUMID=$aumid (expected $expectedAumid)"
Assert ($aumid -eq $expectedAumid) "Start Menu System.AppUserModel.ID mismatch: '$aumid' vs '$expectedAumid'"

$deskLnk = Join-Path $env:USERPROFILE 'Desktop\MultiHeizInstallerTest.lnk'
$deskLnkPublic = Join-Path $env:PUBLIC 'Desktop\MultiHeizInstallerTest.lnk'
$deskFound = $null
foreach ($d in @($deskLnk, $deskLnkPublic)) {
  if (Test-Path -LiteralPath $d) { $deskFound = $d; break }
}
Assert ($null -ne $deskFound) "Desktop shortcut missing (tried $deskLnk / $deskLnkPublic)"
$dLnk = Read-Shortcut $deskFound
Write-Host "  Desktop shortcut: $deskFound target=$($dLnk.TargetPath)"
Assert ($dLnk.TargetPath -eq $exe) "desktop shortcut target mismatch: $($dLnk.TargetPath) vs $exe"

$ukey = Get-TestUninstallKey
Assert ($null -ne $ukey) 'HKCU uninstall key for MultiHeizInstallerTest not found'
$ukeyStr = [string]$ukey
$isHkcu = $ukeyStr -match 'HKCU:|HKEY_CURRENT_USER'
Assert $isHkcu "uninstall key must be HKCU, got $ukeyStr"
Assert (-not ($ukeyStr -match 'HKEY_LOCAL_MACHINE|HKLM:')) "uninstall key must NOT be HKLM: $ukeyStr"
$uProps = Get-ItemProperty -LiteralPath $ukeyStr.Trim()
Write-Host "  Uninstall registry: $ukeyStr"
Write-Host "    DisplayName=$($uProps.DisplayName) DisplayVersion=$($uProps.DisplayVersion)"
Write-Host "    DisplayIcon=$($uProps.DisplayIcon) Publisher=$($uProps.Publisher) EstimatedSize=$($uProps.EstimatedSize)"
Assert ($uProps.DisplayName -like '*MultiHeizInstallerTest*') "DisplayName missing product: $($uProps.DisplayName)"
Assert ([string]$uProps.DisplayIcon) "DisplayIcon missing"
Assert ([string]$uProps.Publisher) "Publisher missing"
Assert ([string]$uProps.DisplayVersion) "DisplayVersion missing"
Assert ($null -ne $uProps.EstimatedSize -and [int]$uProps.EstimatedSize -gt 0) "EstimatedSize missing/zero: $($uProps.EstimatedSize)"

# Real MultiHeiz shortcuts must be unchanged (checked via snapshot later)

Write-Step 'Silent uninstall (must KEEP userData - no /DELETEDATA)'
# NSIS uninstaller copies itself; use Start-Process with /S and _?= so Wait works
$uArgs = @('/S', '/currentuser', "_?=$installDir")
Write-Host "  Running: $uninst $($uArgs -join ' ')"
$up = Start-Process -FilePath $uninst -ArgumentList $uArgs -PassThru -Wait -WindowStyle Hidden
Write-Host "  Uninstaller exit=$($up.ExitCode)"

Start-Sleep -Seconds 2
Assert (-not (Test-Path -LiteralPath $exe)) "exe still present after uninstall: $exe"
Assert (-not (Test-Path -LiteralPath $smLnk)) "Start Menu shortcut still present: $smLnk"
if ($deskFound) {
  Assert (-not (Test-Path -LiteralPath $deskFound)) "Desktop shortcut still present: $deskFound"
}
$ukeyAfter = Get-TestUninstallKey
Assert ($null -eq $ukeyAfter) 'HKCU uninstall key still present'
Assert (Test-Path -LiteralPath $marker) "userData marker was deleted in silent mode (must keep): $marker"
Write-Host '  Files/shortcut/registry removed; userData kept OK'

# Cleanup test userData we created
if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
if ($weCreatedAppData -and (Test-Path -LiteralPath $testAppData)) {
  Remove-Item -LiteralPath $testAppData -Recurse -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $fakeUserData -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $installDir) {
  Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Step 'Re-check real MultiHeiz install snapshot'
$after = Snapshot-RealInstall
Assert-RealInstallUnchanged $before $after
Write-Host '  Real install unchanged'

Write-Step 'Static check: production setup artifact (if present)'
$prodSetup = Join-Path $Root 'dist\MultiHeiz-1.3.0-setup.exe'
if (Test-Path -LiteralPath $prodSetup) {
  $len = (Get-Item -LiteralPath $prodSetup).Length
  Assert ($len -gt 1MB) "production setup too small: $len"
  Write-Host "  Found production setup ($len bytes) - NOT executed (safety)"
} else {
  Write-Host '  Production setup not built yet (run npm run dist:win separately)'
}

Write-Host ''
Write-Host 'PASS: test:installer'
exit 0
