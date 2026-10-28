#!/usr/bin/env bash
# Nightly backup (devdash-backup.timer), run as root. Installed to /usr/local/libexec/devdash-backup.sh by install.sh.
#
# Keeps 14 daily snapshots in /var/backups/devdash (root-only: they hold the master key):
#   devdash.db       consistent copy of the database (sqlite3 .backup, safe while DevDash runs)
#   etc-devdash.tgz  /etc/devdash: master key, environment, browser settings. Without it, sealed data can't be read.
#   data.tgz         the rest of /var/lib/devdash (push keys, backup status), without share-link file copies
# Off-site: put RESTIC_REPOSITORY and RESTIC_PASSWORD (and the storage credentials restic needs, e.g. B2 or S3 keys)
# in /etc/devdash/backup.env and every snapshot is also sent there with restic, encrypted.
set -euo pipefail
umask 077

ROOT=/var/backups/devdash
DAY=$(date -u +%Y-%m-%d)
OUT=$ROOT/$DAY
STATUS=/var/lib/devdash/backup-status.json
mkdir -p "$OUT"

finish() {
  local ok=$1 note=$2
  printf '{"at":%s,"ok":%s,"snapshot":"%s","bytes":%s,"offsite":%s,"note":"%s"}\n' \
    "$(date +%s)" "$ok" "$DAY" "$(du -sb "$OUT" 2>/dev/null | cut -f1 || echo 0)" "${OFFSITE:-false}" "$note" > "$STATUS"
  chown devdash:devdash "$STATUS"
  chmod 640 "$STATUS"
}
trap 'finish false "the backup stopped with an error; see journalctl -u devdash-backup"' ERR

sqlite3 /var/lib/devdash/devdash.db ".backup '$OUT/devdash.db'"
tar -czf "$OUT/etc-devdash.tgz" -C /etc devdash
# Share-link files are skipped: frozen copies (up to 4 GB each) that would repeat in every snapshot. Their records stay.
tar -czf "$OUT/data.tgz" --exclude='devdash/devdash.db*' --exclude='devdash/shares' -C /var/lib devdash

# Keep two weeks.
find "$ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +

OFFSITE=false
if [[ -f /etc/devdash/backup.env ]] && grep -q '^RESTIC_REPOSITORY=' /etc/devdash/backup.env; then
  set -a; . /etc/devdash/backup.env; set +a
  command -v restic >/dev/null || apt-get install -yq restic >/dev/null
  restic snapshots >/dev/null 2>&1 || restic init
  restic backup --quiet --tag devdash "$OUT"
  restic forget --quiet --tag devdash --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
  OFFSITE=true
fi

finish true "$([[ $OFFSITE == true ]] && echo 'kept here and sent off-site' || echo 'kept on this server only')"
