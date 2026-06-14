<#
.SYNOPSIS
  Create a versioned GitHub release for the LLAMA Chat Obsidian plugin.
  The release is BRAT-compatible (main.js + manifest.json + styles.css attached).

.PARAMETER Version
  New semantic version string, e.g. "1.1.0". Defaults to auto-incrementing patch.

.PARAMETER Notes
  Optional release notes / changelog text.

.EXAMPLE
  .\scripts\release.ps1 -Version "1.2.0" -Notes "Bug fixes and performance improvements."
  .\scripts\release.ps1   # auto-increments patch version
#>

param(
  [string]$Version  = "",
  [string]$Notes    = ""
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

Set-Location $Root

# ── 1. Check prerequisites ───────────────────────────────────────────────────

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Error "GitHub CLI (gh) is not installed. Install from https://cli.github.com/ then run: gh auth login"
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error "npm is not installed."
}

# ── 2. Resolve version ───────────────────────────────────────────────────────

$manifest = Get-Content "$Root\manifest.json" | ConvertFrom-Json
$current  = [version]$manifest.version

if ([string]::IsNullOrWhiteSpace($Version)) {
  # Auto-increment patch  (1.0.0 -> 1.0.1)
  $Version = "$($current.Major).$($current.Minor).$($current.Build + 1)"
  Write-Host "Auto-incrementing patch: $current -> $Version"
}

if ($Version -eq $current.ToString()) {
  Write-Error "New version ($Version) is the same as current ($current). Bump the version."
}

Write-Host ""
Write-Host "Releasing version: $Version"
Write-Host ""

# ── 3. Update manifest.json ──────────────────────────────────────────────────

$manifest.version = $Version
$manifest | ConvertTo-Json -Depth 5 | Set-Content "$Root\manifest.json" -Encoding UTF8
Write-Host "Updated manifest.json -> $Version"

# ── 4. Update versions.json ──────────────────────────────────────────────────

$versions = Get-Content "$Root\versions.json" | ConvertFrom-Json
$versions | Add-Member -NotePropertyName $Version -NotePropertyValue $manifest.minAppVersion -Force
$versions | ConvertTo-Json -Depth 5 | Set-Content "$Root\versions.json" -Encoding UTF8
Write-Host "Updated versions.json -> $Version: $($manifest.minAppVersion)"

# ── 5. Production build ──────────────────────────────────────────────────────

Write-Host ""
Write-Host "Building production bundle..."
npm run build
Write-Host "Build complete."

# ── 6. Git commit + tag ──────────────────────────────────────────────────────

Write-Host ""
Write-Host "Committing version bump..."
git add manifest.json versions.json main.js
git commit -m "chore: bump version to $Version"
git tag $Version
git push
git push --tags
Write-Host "Pushed commit and tag $Version."

# ── 7. Create GitHub release with BRAT assets ────────────────────────────────

Write-Host ""
Write-Host "Creating GitHub release..."

$releaseArgs = @(
  "release", "create", $Version,
  "--title", "v$Version",
  "--notes", ($Notes -ne "" ? $Notes : "Release v$Version"),
  "$Root\main.js",
  "$Root\manifest.json",
  "$Root\styles.css"
)

gh @releaseArgs

Write-Host ""
Write-Host "Done! BRAT users can now install or update using:"
Write-Host ""

# Get repo info for display
$remote = git remote get-url origin
if ($remote -match "github\.com[:/](.+?)(?:\.git)?$") {
  Write-Host "  Repository: $($Matches[1])"
  Write-Host "  BRAT URL:   https://github.com/$($Matches[1])"
}

Write-Host ""
Write-Host "In Obsidian -> BRAT -> Add Beta Plugin -> paste the URL above."
