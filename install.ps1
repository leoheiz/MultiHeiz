#Requires -Version 5.1
<#
.SYNOPSIS
  Install or update MultiHeiz from GitHub Releases (per-user by default).

.EXAMPLE
  irm https://raw.githubusercontent.com/leoheiz/MultiHeiz/main/install.ps1 | iex

.EXAMPLE
  .\install.ps1 -ReleaseJsonUrl http://127.0.0.1:PORT/releases/latest -AssetPattern 'MultiHeizInstallerTest-*-setup.exe' -ProductName MultiHeizInstallerTest
#>
[CmdletBinding()]
param(
  [string]$ApiBase = 'https://api.github.com',
  [string]$ReleaseJsonUrl,
  [string]$Version,
  [switch]$Force,
  [switch]$AllUsers,
  [string]$Owner = 'leoheiz',
  [string]$Repo = 'MultiHeiz',
  [string]$AssetPattern = 'MultiHeiz-*-setup.exe',
  [string]$ProductName = 'MultiHeiz',
  [string]$SumsName = 'SHA256SUMS.txt'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Info([string]$msg) { Write-Host $msg }
function Write-Warn([string]$msg) { Write-Host "AVISO: $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "ERRO: $msg" -ForegroundColor Red; exit 1 }

function Get-InstalledInfo {
  param([string]$Name)
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  $hits = @()
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($item in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
      try {
        $p = Get-ItemProperty -LiteralPath $item.PSPath -ErrorAction Stop
        $dn = [string]$p.DisplayName
        if (-not $dn) { continue }
        # Exact product or "Product version" style; ignore InstallerTest when looking for MultiHeiz
        if ($Name -eq 'MultiHeiz') {
          if ($dn -eq 'MultiHeiz' -or $dn -like 'MultiHeiz *') {
            if ($dn -like '*InstallerTest*') { continue }
          } else { continue }
        } else {
          if ($dn -ne $Name -and $dn -notlike "$Name *") { continue }
        }
        $scope = if ($item.PSPath -match 'HKEY_LOCAL_MACHINE|HKLM') { 'machine' } else { 'user' }
        $hits += [pscustomobject]@{
          DisplayName = $dn
          DisplayVersion = [string]$p.DisplayVersion
          Scope = $scope
          UninstallString = [string]$p.UninstallString
          QuietUninstallString = [string]$p.QuietUninstallString
          PSPath = $item.PSPath
        }
      } catch { }
    }
  }
  return $hits
}

function Compare-Semver([string]$a, [string]$b) {
  $pa = @($a -split '[^\d]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
  $pb = @($b -split '[^\d]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
  while ($pa.Count -lt 3) { $pa += 0 }
  while ($pb.Count -lt 3) { $pb += 0 }
  for ($i = 0; $i -lt 3; $i++) {
    if ($pa[$i] -gt $pb[$i]) { return 1 }
    if ($pa[$i] -lt $pb[$i]) { return -1 }
  }
  return 0
}

function Get-ReleaseJson {
  if ($ReleaseJsonUrl) {
    Write-Info "Buscando release: $ReleaseJsonUrl"
    return Invoke-RestMethod -Uri $ReleaseJsonUrl -Headers @{ 'User-Agent' = 'MultiHeiz-install.ps1' }
  }
  if ($Version) {
    $url = "$ApiBase/repos/$Owner/$Repo/releases/tags/v$Version"
    if ($Version -match '^v') { $url = "$ApiBase/repos/$Owner/$Repo/releases/tags/$Version" }
    Write-Info "Buscando release: $url"
    return Invoke-RestMethod -Uri $url -Headers @{ 'User-Agent' = 'MultiHeiz-install.ps1' }
  }
  $url = "$ApiBase/repos/$Owner/$Repo/releases/latest"
  Write-Info "Buscando release: $url"
  return Invoke-RestMethod -Uri $url -Headers @{ 'User-Agent' = 'MultiHeiz-install.ps1' }
}

function Find-Asset($release, [string]$pattern) {
  $assets = @($release.assets)
  foreach ($a in $assets) {
    $n = [string]$a.name
    if ($n -like $pattern) { return $a }
  }
  return $null
}

function Get-Sha256File([string]$path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $fs = [System.IO.File]::OpenRead($path)
    try {
      $bytes = $sha.ComputeHash($fs)
      return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
    } finally { $fs.Dispose() }
  } finally { $sha.Dispose() }
}

function Parse-Sums([string]$text) {
  $map = @{}
  foreach ($line in ($text -split '\r?\n')) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    # "hash  file" or "hash *file"
    if ($t -match '^([A-Fa-f0-9]{64})\s+\*?(.+)$') {
      $map[$Matches[2].Trim()] = $Matches[1].ToLowerInvariant()
    }
  }
  return $map
}

# --- main ---
$installed = @(Get-InstalledInfo -Name $ProductName)
$machine = @($installed | Where-Object { $_.Scope -eq 'machine' })
$userHits = @($installed | Where-Object { $_.Scope -eq 'user' })

if ($machine.Count -gt 0 -and -not $AllUsers) {
  $v = $machine[0].DisplayVersion
  Write-Warn "Ha uma instalacao per-machine de $ProductName (versao $v)."
  Write-Info "Para atualizar para todos os usuarios, rode de novo com -AllUsers (pede elevacao)."
  Write-Info "Continuando com instalacao/atualizacao per-user (pode gerar atalhos duplicados)."
}

$release = Get-ReleaseJson
if ($null -eq $release -or ($release -is [string])) {
  Fail "Resposta de release invalida (nao-JSON). Verifique -ReleaseJsonUrl / API."
}
$tag = ''
try { $tag = [string]$release.tag_name } catch { $tag = '' }
if (-not $tag) {
  try { $tag = [string]$release.Tag_name } catch { $tag = '' }
}
$remoteVer = ($tag -replace '^v', '')
if (-not $remoteVer) { Fail 'Nao foi possivel determinar a versao do release.' }
Write-Info "Release remoto: $remoteVer"

$bestLocal = $null
foreach ($h in $installed) {
  if (-not $bestLocal) { $bestLocal = $h; continue }
  if ((Compare-Semver $h.DisplayVersion $bestLocal.DisplayVersion) -gt 0) { $bestLocal = $h }
}

if ($bestLocal -and -not $Force) {
  $cmp = Compare-Semver $bestLocal.DisplayVersion $remoteVer
  if ($cmp -eq 0) {
    Write-Info "$ProductName $remoteVer ja esta instalado. Nada a fazer (use -Force para reinstalar)."
    exit 0
  }
  if ($cmp -gt 0) {
    Write-Info "Versao local ($($bestLocal.DisplayVersion)) e mais nova que o release ($remoteVer). Nada a fazer (use -Force)."
    exit 0
  }
  Write-Info "Atualizando $($bestLocal.DisplayVersion) -> $remoteVer"
}

$setupAsset = Find-Asset $release $AssetPattern
if (-not $setupAsset) {
  Fail "Asset '$AssetPattern' nao encontrado no release $tag"
}

$tempDir = Join-Path $env:TEMP ('mh-install-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tempDir | Out-Null
$setupPath = Join-Path $tempDir $setupAsset.name
$sumsPath = Join-Path $tempDir $SumsName

try {
  Write-Info "Baixando $($setupAsset.name)..."
  Invoke-WebRequest -Uri $setupAsset.browser_download_url -OutFile $setupPath -UseBasicParsing -Headers @{ 'User-Agent' = 'MultiHeiz-install.ps1' }

  $sumsAsset = Find-Asset $release $SumsName
  if ($sumsAsset) {
    Write-Info "Baixando $SumsName..."
    Invoke-WebRequest -Uri $sumsAsset.browser_download_url -OutFile $sumsPath -UseBasicParsing -Headers @{ 'User-Agent' = 'MultiHeiz-install.ps1' }
    $map = Parse-Sums (Get-Content -LiteralPath $sumsPath -Raw -Encoding UTF8)
    $expect = $map[$setupAsset.name]
    if (-not $expect) {
      Fail "$SumsName nao contem entrada para $($setupAsset.name)"
    }
    $actual = Get-Sha256File $setupPath
    if ($actual -ne $expect) {
      Fail "SHA256 nao confere para $($setupAsset.name).`n  esperado: $expect`n  obtido:   $actual"
    }
    Write-Info "SHA256 OK ($actual)"
  } else {
    Write-Warn "Release sem $SumsName - pulando verificacao de integridade."
  }

  $args = @('/S')
  if ($AllUsers) {
    $args += '/allusers'
  } else {
    $args += '/currentuser'
  }

  Write-Info "Instalando ($($args -join ' '))..."
  if ($AllUsers) {
    $p = Start-Process -FilePath $setupPath -ArgumentList $args -Verb RunAs -PassThru -Wait
  } else {
    $p = Start-Process -FilePath $setupPath -ArgumentList $args -PassThru -Wait -WindowStyle Hidden
  }
  if ($null -ne $p.ExitCode -and $p.ExitCode -ne 0) {
    Fail "Instalador saiu com codigo $($p.ExitCode)"
  }

  Start-Sleep -Seconds 1
  $after = @(Get-InstalledInfo -Name $ProductName)
  $ver = $remoteVer
  if ($after.Count -gt 0 -and $after[0].DisplayVersion) {
    $ver = $after[0].DisplayVersion
  }
  Write-Info "Instalado: $ProductName $ver"
  exit 0
} finally {
  try {
    if (Test-Path -LiteralPath $tempDir) {
      Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  } catch { }
}
