<#
.SYNOPSIS
  Create a versioned GitHub release for the Engram Obsidian plugin.
  The release is BRAT-compatible (main.js + manifest.json + styles.css attached).

.PARAMETER Version
  New semantic version string, e.g. "5.1.0". Defaults to auto-incrementing patch.

.PARAMETER Notes
  Optional release notes / changelog text.

.EXAMPLE
  .\scripts\release.ps1 -Version "5.1.0" -Notes "Bug fixes."
  .\scripts\release.ps1   # auto-increments patch version
#>

param(
  [string]$Version = "",
  [string]$Notes   = ""
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# ── gh CLI path ───────────────────────────────────────────────────────────────

$GhExe = "C:\Program Files\GitHub CLI\gh.exe"
if (-not (Test-Path $GhExe)) {
  # Fall back to PATH
  $GhExe = "gh"
}

# ── Repo ──────────────────────────────────────────────────────────────────────

$Remote = git remote get-url (git remote) 2>$null
if ($Remote -match "github\.com[:/](.+?)(?:\.git)?$") {
  $Repo = $Matches[1]
} else {
  Write-Error "Could not determine GitHub repo from remote URL: $Remote"
  exit 1
}

Write-Host "Repo: $Repo"

# ── Load manifest ─────────────────────────────────────────────────────────────

$ManifestPath = Join-Path $Root "manifest.json"
$Manifest = Get-Content $ManifestPath | ConvertFrom-Json

# ── Determine version ─────────────────────────────────────────────────────────

if ($Version -eq "") {
  $Parts = $Manifest.version -split "\."
  $Patch = [int]$Parts[2] + 1
  $Version = "$($Parts[0]).$($Parts[1]).$Patch"
}

# Strip leading 'v' for semver storage, tag matches semver
$SemVer = $Version -replace "^v", ""
$Tag    = $SemVer

Write-Host "Creating release $Tag..."

# ── Update manifest.json ──────────────────────────────────────────────────────

$Manifest.version = $SemVer
$Manifest | ConvertTo-Json -Depth 10 | Set-Content $ManifestPath -Encoding UTF8
Write-Host "Updated manifest.json -> $SemVer"

# ── Update versions.json ──────────────────────────────────────────────────────

$VersionsPath = Join-Path $Root "versions.json"
if (Test-Path $VersionsPath) {
  $Versions = Get-Content $VersionsPath | ConvertFrom-Json
  $Versions | Add-Member -NotePropertyName $SemVer -NotePropertyValue $Manifest.minAppVersion -Force
  $Versions | ConvertTo-Json -Depth 10 | Set-Content $VersionsPath -Encoding UTF8
  Write-Host "Updated versions.json -> $SemVer : $($Manifest.minAppVersion)"
}

# ── Build ─────────────────────────────────────────────────────────────────────

Write-Host "Building..."
npm run build
if ($LASTEXITCODE -ne 0) { Write-Error "Build failed"; exit 1 }

# ── Git commit + tag ──────────────────────────────────────────────────────────

$RemoteName = git remote
git add manifest.json versions.json main.js styles.css
git commit -m "chore: bump version to $SemVer" 2>$null
git tag $Tag
git push $RemoteName main
git push $RemoteName $Tag
Write-Host "Pushed tag $Tag"

# ── GitHub Release ────────────────────────────────────────────────────────────

$ReleaseNotes = if ($Notes -ne "") { $Notes } else { "Release $Tag" }

$Args = @(
  "release", "create", $Tag,
  "main.js", "manifest.json", "styles.css",
  "--repo", $Repo,
  "--title", "$Tag",
  "--notes", $ReleaseNotes
)

& $GhExe @Args

if ($LASTEXITCODE -eq 0) {
  Write-Host ""
  Write-Host "Release $Tag published successfully!" -ForegroundColor Green
  Write-Host "https://github.com/$Repo/releases/tag/$Tag"
} else {
  Write-Error "gh release create failed"
}
