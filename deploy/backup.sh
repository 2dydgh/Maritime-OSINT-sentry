#!/bin/bash
# Daily PostgreSQL backup
set -euo pipefail

BACKUP_DIR=~/backups
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

echo "Starting backup: $DATE"
docker exec osint_db pg_dump -U "${DB_USER:-osint_user}" "${DB_NAME:-osint_4d}" \
    | gzip > "$BACKUP_DIR/osint_${DATE}.sql.gz"

# 7일 이상된 백업 삭제
find "$BACKUP_DIR" -name "osint_*.sql.gz" -mtime +7 -delete

echo "Backup complete: $BACKUP_DIR/osint_${DATE}.sql.gz"
ls -lh "$BACKUP_DIR/"
