#!/usr/bin/env bash
# The nightly backup (and the one taken before each update): every database, copied safely while the
# server runs. With companies on their own addresses that is the first company's database, each other
# company's under companies/<address>/, and the service's own accounts and billing (platform/).
#   bash deploy/backup.sh              # tonight's backups, kept 14 days
#   bash deploy/backup.sh before-update
set -euo pipefail
DATA=/var/lib/workhelm; BK=/var/backups/workhelm
KIND="${1:-tracker}"; DAY="$(date +%F)"; [[ "$KIND" == before-update ]] && DAY="$(date +%F-%H%M)"
mkdir -p "$BK"
[[ -f "$DATA/tracker.db" ]] && sqlite3 "$DATA/tracker.db" ".backup '$BK/$KIND-$DAY.db'"
if [[ -f "$DATA/platform/platform.db" ]]; then sqlite3 "$DATA/platform/platform.db" ".backup '$BK/$KIND-platform-$DAY.db'"; fi
if [[ -d "$DATA/companies" ]]; then
  for db in "$DATA"/companies/*/tracker.db; do
    [[ -f "$db" ]] || continue
    slug="$(basename "$(dirname "$db")")"
    sqlite3 "$db" ".backup '$BK/$KIND-co-$slug-$DAY.db'"
  done
fi
[[ "$KIND" == tracker ]] && find "$BK" -name 'tracker-*.db' -mtime +14 -delete
[[ "$KIND" == before-update ]] && find "$BK" -name 'before-update-*.db' -mtime +30 -delete
exit 0
