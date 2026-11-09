#!/usr/bin/env bash
# Sauvegarde quotidienne sur le VPS : base de données + fichiers (déjà chiffrés).
# Cron (tous les jours à 2 h) :  0 2 * * * /opt/akili/deploy/backup.sh >> /var/log/akili-backup.log 2>&1
# Étape suivante (directive 4.4) : copie chiffrée vers un autre fournisseur (restic).
set -euo pipefail
cd "$(dirname "$0")/.."
dest="${BACKUP_DIR:-/var/backups/akili}"
stamp="$(date +%Y-%m-%d_%H%M)"
mkdir -p "$dest"
chmod 700 "$dest"
docker compose exec -T db pg_dump -U akili -d akili --format=custom > "$dest/db-$stamp.dump"
docker run --rm -v akili_app_data:/data:ro -v "$dest":/backup alpine:3.20 tar czf "/backup/files-$stamp.tar.gz" -C /data .
# Garder 14 jours.
find "$dest" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'files-*.tar.gz' \) -mtime +14 -print -delete
echo "sauvegarde ok : $dest ($stamp)"
