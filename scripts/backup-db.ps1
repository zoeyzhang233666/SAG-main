$ErrorActionPreference = "Stop"

$backupDir = Join-Path (Get-Location) "backups"
$localDump = Join-Path $backupDir "sag_lite.dump"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$timestampDump = Join-Path $backupDir "sag_lite-$timestamp.dump"

New-Item -ItemType Directory -Force $backupDir | Out-Null

Write-Host "[1/4] Starting PostgreSQL container..."
docker compose up -d postgres

Write-Host "[2/4] Creating PostgreSQL dump inside Docker..."
docker exec sag_lite_postgres pg_dump -U sag_lite -d sag_lite -Fc -f /tmp/sag_lite.dump

Write-Host "[3/4] Copying dump to project backups folder..."
docker cp sag_lite_postgres:/tmp/sag_lite.dump $localDump
Copy-Item $localDump $timestampDump -Force

Write-Host "[4/4] Backup complete."
Write-Host "Latest backup: $localDump"
Write-Host "Timestamp backup: $timestampDump"
Write-Host "Wait until your cloud drive finishes syncing before switching computers."
