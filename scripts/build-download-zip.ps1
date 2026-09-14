# ============================================================
# build-download-zip.ps1 -- regenerates public/RaidLead-Download.zip from
# source. Run this after any change under addon/RaidLead or
# "public/RaidLead Docs" -- the zip is a committed, derived artifact (this
# project has no build step), so it goes stale silently otherwise.
# ============================================================
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

$zipPath = Join-Path $RepoRoot 'public\RaidLead-Download.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath }

Compress-Archive -Path (Join-Path $RepoRoot 'addon\RaidLead'), (Join-Path $RepoRoot 'public\RaidLead Docs') -DestinationPath $zipPath

Write-Host "Built $zipPath"
