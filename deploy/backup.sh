#!/usr/bin/env bash
# Nightly dump of the database (directory format, zstd), keeping the last $KEEP dumps.
# Restore: pg_restore -d pickleague --jobs=6 --no-owner <dir> (see README, "Backups").
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=${BACKUP_DIR:-/var/backups/pickleague}
KEEP=${KEEP:-3}
name=$(date -u +%Y-%m-%dT%H%MZ)
mkdir -p "$DEST"
docker compose exec -T postgres sh -c "rm -rf /tmp/dump && pg_dump -U pickleague -d pickleague --format=directory --compress=zstd:3 --jobs=4 -f /tmp/dump"
docker compose cp postgres:/tmp/dump "$DEST/$name.partial"
docker compose exec -T postgres rm -rf /tmp/dump
mv "$DEST/$name.partial" "$DEST/$name"
ls -1d "$DEST"/*/ | grep -v partial | sort | head -n -"$KEEP" | xargs -r rm -rf
echo "backup $name done ($(du -sh "$DEST/$name" | cut -f1))"
