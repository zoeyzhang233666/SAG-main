$ErrorActionPreference = "Stop"

$backupDir = Join-Path (Get-Location) "backups"
$localDump = Join-Path $backupDir "sag_lite.dump"

if (!(Test-Path $localDump)) {
  throw "Backup file not found: $localDump"
}

Write-Host "WARNING: This will overwrite the local SAG database with: $localDump" -ForegroundColor Yellow
Write-Host "Before restoring, stop 'npm run dev' with Ctrl+C on this computer." -ForegroundColor Yellow
$confirm = Read-Host "Type RESTORE to continue"
if ($confirm -ne "RESTORE") {
  Write-Host "Restore cancelled."
  exit 0
}

Write-Host "[1/5] Starting PostgreSQL container..."
docker compose up -d postgres

Write-Host "[2/5] Copying dump into Docker..."
docker cp $localDump sag_lite_postgres:/tmp/sag_lite.dump

Write-Host "[3/5] Closing existing database connections..."
docker exec sag_lite_postgres psql -U sag_lite -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'sag_lite' AND pid <> pg_backend_pid();"

Write-Host "[4/5] Restoring database..."
docker exec sag_lite_postgres pg_restore -U sag_lite -d sag_lite --clean --if-exists --no-owner --no-acl /tmp/sag_lite.dump

Write-Host "[5/5] Restore complete. Applying any pending migrations..."
npm run db:migrate

Write-Host "Database restore complete. You can now run: npm run dev"
