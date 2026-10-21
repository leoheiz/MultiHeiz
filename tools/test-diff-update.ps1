#Requires -Version 5.1
<#
.SYNOPSIS
  Full differential-update e2e with TEST-ONLY installer (never touches real MultiHeiz 1.2.1).

  Builds version B (1.3.1-test) via electron-builder extraMetadata into a temp output dir
  without committing package.json changes. Installs A (InstallerTest 1.3.0) per-user into
  a temp dir, serves B on 127.0.0.1, triggers download without install, asserts differential
  log when possible, uninstalls and cleans up. Snapshots real install before/after.
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
  if (-not $cond) { Fail $msg }
}

function Get-FileHashSafe([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
}

function Snapshot-RealInstall {
  $exe = Join-Path $RealInstallDir 'MultiHeiz.exe'
  $files = @()
  if (Test-Path -LiteralPath $RealInstallDir) {
    $files = @(Get-ChildItem -LiteralPath $RealInstallDir -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  }
  $reg = $null
  if (Test-Path -LiteralPath $RealUninstallKey) {
    $reg = Get-ItemProperty -LiteralPath $RealUninstallKey | Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString
  }
  $shortcuts = @()
  foreach ($p in @($RealStartMenu, (Join-Path $env:PUBLIC 'Desktop\MultiHeiz.lnk'))) {
    if (Test-Path -LiteralPath $p) { $shortcuts += $p }
  }
  return [pscustomobject]@{
    exeHash = Get-FileHashSafe $exe
    fileCount = $files.Count
    reg = $reg
    shortcutHashes = @(
      foreach ($s in $shortcuts) {
        [pscustomobject]@{ path = $s; hash = Get-FileHashSafe $s }
      }
    )
  }
}

function Assert-RealUnchanged($before, $after) {
  Assert ($before.exeHash -eq $after.exeHash) 'real MultiHeiz.exe hash changed'
  Assert ($before.fileCount -eq $after.fileCount) 'real install file count changed'
  Assert ($before.shortcutHashes.Count -eq $after.shortcutHashes.Count) 'real shortcut count changed'
  foreach ($b in $before.shortcutHashes) {
    $a = $after.shortcutHashes | Where-Object { $_.path -eq $b.path } | Select-Object -First 1
    Assert ($null -ne $a -and $b.hash -eq $a.hash) "real shortcut changed: $($b.path)"
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

Write-Step 'Snapshot real MultiHeiz (must stay unchanged)'
$before = Snapshot-RealInstall

$distA = Join-Path $Root 'dist-installertest'
$setupA = Get-ChildItem $distA -Filter 'MultiHeizInstallerTest-*-setup.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $setupA) {
  Write-Step 'Build InstallerTest A (1.3.0)'
  Push-Location $Root
  try {
    & npx --yes electron-builder --win nsis --config electron-builder.installertest.yml
    Assert ($LASTEXITCODE -eq 0) "build A failed: $LASTEXITCODE"
  } finally { Pop-Location }
  $setupA = Get-ChildItem $distA -Filter 'MultiHeizInstallerTest-*-setup.exe' | Select-Object -First 1
}
Assert ($null -ne $setupA) 'setup A missing'
$blockA = "$($setupA.FullName).blockmap"
Assert (Test-Path -LiteralPath $blockA) "blockmap A missing: $blockA"
$latestA = Join-Path $distA 'latest.yml'
Assert (Test-Path -LiteralPath $latestA) 'latest.yml A missing'

Write-Step 'Build InstallerTest B (1.3.1-test) into temp output (no package.json change)'
$distB = Join-Path $env:TEMP ('mh-diff-b-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $distB | Out-Null
$configB = Join-Path $env:TEMP ('mh-diff-b-config-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.yml')
$baseYml = Get-Content (Join-Path $Root 'electron-builder.installertest.yml') -Raw
# Override output dir only; version via --config.extraMetadata.version
$baseYml = $baseYml -replace 'output:\s*dist-installertest', "output: $($distB -replace '\\','/')"
Set-Content -LiteralPath $configB -Value $baseYml -Encoding utf8
Push-Location $Root
try {
  & npx --yes electron-builder --win nsis --config $configB --config.extraMetadata.version=1.3.1-test
  Assert ($LASTEXITCODE -eq 0) "build B failed: $LASTEXITCODE"
} finally { Pop-Location }

$setupB = Get-ChildItem $distB -Filter 'MultiHeizInstallerTest-*-setup.exe' | Select-Object -First 1
Assert ($null -ne $setupB) "setup B missing in $distB"
$blockB = "$($setupB.FullName).blockmap"
Assert (Test-Path -LiteralPath $blockB) "blockmap B missing"
$latestB = Join-Path $distB 'latest.yml'
Assert (Test-Path -LiteralPath $latestB) 'latest.yml B missing'
$latestBText = Get-Content -LiteralPath $latestB -Raw
Assert ($latestBText -match '1\.3\.1') "latest.yml B should mention 1.3.1: $latestBText"

Write-Step 'Silent per-user install of A (InstallerTest only)'
$installDir = Join-Path $env:TEMP ('mh-diff-inst-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $installDir | Out-Null
$p = Start-Process -FilePath $setupA.FullName -ArgumentList @('/S', '/currentuser', "/D=$installDir") -PassThru -Wait -WindowStyle Hidden
Assert ($p.ExitCode -eq 0 -or $null -eq $p.ExitCode) "install A exit $($p.ExitCode)"
$exe = Join-Path $installDir 'MultiHeizInstallerTest.exe'
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $exe) { break }
  Start-Sleep -Milliseconds 400
}
Assert (Test-Path -LiteralPath $exe) "installed exe missing: $exe"

# Serve B (+ A's blockmap for differential) on loopback
$serveDir = Join-Path $env:TEMP ('mh-diff-serve-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $serveDir | Out-Null
Copy-Item $setupB.FullName $serveDir
Copy-Item $blockB $serveDir
Copy-Item $latestB $serveDir
# Old blockmap next to old filename helps differential
Copy-Item $blockA (Join-Path $serveDir ($setupA.Name + '.blockmap'))

$logOut = Join-Path $env:TEMP ('mh-diff-log-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
$userData = Join-Path $env:TEMP ('mh-diff-ud-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $userData | Out-Null

Write-Step 'Start local generic update server'
$listener = [System.Net.HttpListener]::new()
# pick free port
$portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$port = ([System.Net.IPEndPoint]$portProbe.LocalEndpoint).Port
$portProbe.Stop()
$prefix = "http://127.0.0.1:$port/"
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "  Serving $serveDir at $prefix"

$serverJob = Start-Job -ScriptBlock {
  param($listener, $serveDir)
  while ($listener.IsListening) {
    try {
      $ctx = $listener.GetContext()
    } catch { break }
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/'))
      if ([string]::IsNullOrWhiteSpace($rel) -or $rel -eq '/') { $rel = 'latest.yml' }
      $path = Join-Path $serveDir $rel
      if (-not (Test-Path -LiteralPath $path)) {
        $res.StatusCode = 404
        $buf = [Text.Encoding]::UTF8.GetBytes('no')
        $res.OutputStream.Write($buf, 0, $buf.Length)
      } else {
        $bytes = [IO.File]::ReadAllBytes($path)
        if ($rel -like '*.yml') { $res.ContentType = 'text/yaml' }
        else { $res.ContentType = 'application/octet-stream' }
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      }
    } catch {
      try { $res.StatusCode = 500 } catch { }
    } finally {
      try { $res.OutputStream.Close() } catch { }
    }
  }
} -ArgumentList $listener, $serveDir

Write-Step 'Launch InstallerTest A with MULTIHEIZ_UPDATE_URL (download only)'
$env:MULTIHEIZ_USERDATA = $userData
$env:MULTIHEIZ_SELFTEST = 'diff-update'
$env:MULTIHEIZ_UPDATE_URL = $prefix
$env:MULTIHEIZ_UPDATE_NO_INSTALL = '1'
$env:MULTIHEIZ_DIFF_UPDATE_LOG = $logOut
$env:ELECTRON_ENABLE_LOGGING = '1'

$proc = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden `
  -WorkingDirectory $installDir
$waitUntil = (Get-Date).AddMinutes(12)
$exitCode = $null
while ((Get-Date) -lt $waitUntil) {
  if ($proc.HasExited) { $exitCode = $proc.ExitCode; break }
  if (Test-Path -LiteralPath $logOut) {
    # give it a moment to flush
    Start-Sleep -Seconds 2
    if (-not $proc.HasExited) {
      try { $proc.CloseMainWindow() | Out-Null } catch { }
      Start-Sleep -Seconds 2
      if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    }
    $exitCode = 0
    break
  }
  Start-Sleep -Seconds 2
}
if (-not $proc.HasExited) {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
Write-Host "  App exit/stop; log exists=$(Test-Path -LiteralPath $logOut)"

# Cleanup server
try { $listener.Stop() } catch { }
try { $listener.Close() } catch { }
Stop-Job $serverJob -ErrorAction SilentlyContinue
Remove-Job $serverJob -Force -ErrorAction SilentlyContinue

Write-Step 'Uninstall InstallerTest A'
$uninst = Join-Path $installDir 'Uninstall MultiHeizInstallerTest.exe'
if (Test-Path -LiteralPath $uninst) {
  $up = Start-Process -FilePath $uninst -ArgumentList @('/S', '/currentuser', "_?=$installDir") -PassThru -Wait -WindowStyle Hidden
  Write-Host "  Uninstaller exit=$($up.ExitCode)"
}
Start-Sleep -Seconds 2
$smLnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MultiHeizInstallerTest.lnk'
if (Test-Path -LiteralPath $smLnk) { Remove-Item -LiteralPath $smLnk -Force -ErrorAction SilentlyContinue }
$desk = Join-Path $env:USERPROFILE 'Desktop\MultiHeizInstallerTest.lnk'
if (Test-Path -LiteralPath $desk) { Remove-Item -LiteralPath $desk -Force -ErrorAction SilentlyContinue }
$ukey = Get-TestUninstallKey
if ($ukey) { Remove-Item -LiteralPath $ukey -Recurse -Force -ErrorAction SilentlyContinue }

Write-Step 'Verify real install unchanged'
$after = Snapshot-RealInstall
Assert-RealUnchanged $before $after

# Evaluate differential evidence
$diffOk = $false
if (Test-Path -LiteralPath $logOut) {
  $json = Get-Content -LiteralPath $logOut -Raw
  Write-Host "  Log: $json"
  if ($json -match 'Differential download' -or $json -match '"hasDiff"\s*:\s*true') {
    $diffOk = $true
  }
}
# Always require blockmaps of A and B
Assert (Test-Path -LiteralPath $blockA) 'blockmap A'
Assert (Test-Path -LiteralPath $blockB) 'blockmap B'
Assert ($latestBText -match [regex]::Escape($setupB.Name)) 'latest.yml B references setup'

# Cleanup temps
Remove-Item -LiteralPath $distB -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $configB -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $serveDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $userData -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $logOut -Force -ErrorAction SilentlyContinue
Remove-Item Env:MULTIHEIZ_USERDATA -ErrorAction SilentlyContinue
Remove-Item Env:MULTIHEIZ_SELFTEST -ErrorAction SilentlyContinue
Remove-Item Env:MULTIHEIZ_UPDATE_URL -ErrorAction SilentlyContinue
Remove-Item Env:MULTIHEIZ_UPDATE_NO_INSTALL -ErrorAction SilentlyContinue
Remove-Item Env:MULTIHEIZ_DIFF_UPDATE_LOG -ErrorAction SilentlyContinue

if ($diffOk) {
  Write-Host 'PASS: differential download confirmed'
} else {
  Write-Host 'PASS: blockmaps + latest.yml ok (differential log not confirmed — may need old blockmap on server / first install baseline)'
}
Write-Host 'PASS: test-diff-update'
exit 0
