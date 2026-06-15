param(
  [string]$VaultPath = $env:OBSIDIAN_VAULT_PATH
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($VaultPath)) {
  Write-Error 'Set OBSIDIAN_VAULT_PATH or pass -VaultPath "C:\Path\To\Vault".'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginId = 'engram-chat'
$pluginDir = Join-Path (Join-Path $VaultPath '.obsidian/plugins') $pluginId

if (-not (Test-Path (Join-Path $VaultPath '.obsidian'))) {
  Write-Error "Vault path is invalid. Expected .obsidian folder in: $VaultPath"
}

New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null

$files = @('main.js', 'manifest.json', 'styles.css')
foreach ($file in $files) {
  $src = Join-Path $repoRoot $file
  if (-not (Test-Path $src)) {
    Write-Error "Build artifact missing: $src"
  }

  $dest = Join-Path $pluginDir $file
  Copy-Item -Path $src -Destination $dest -Force
}

Write-Host "Synced plugin files to: $pluginDir"
