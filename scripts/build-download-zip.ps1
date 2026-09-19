# ============================================================
# build-download-zip.ps1 -- regenerates public/RaidLead-Download.zip from
# source. Run this after any change under addon/RaidLead -- the zip is a
# committed, derived artifact (this project has no build step), so it goes
# stale silently otherwise.
#
# Used to also bundle "public/RaidLead Docs" (the bridge-folder template),
# but that mechanism was retired once the Companion app got its own login
# and started talking to RaidLead directly -- see companion/src/auth.js and
# api/companion.js. Nothing reads that folder anymore.
# ============================================================
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

$zipPath = Join-Path $RepoRoot 'public\RaidLead-Download.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath }

Compress-Archive -Path (Join-Path $RepoRoot 'addon\RaidLead') -DestinationPath $zipPath

Write-Host "Built $zipPath"
