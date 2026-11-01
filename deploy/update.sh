#!/usr/bin/env bash
# Workhelm: install a new version on the server. Run from inside the new project folder:
#   sudo bash deploy/update.sh
# Takes a database backup first. Data, settings and the owner login are untouched.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$SRC/server/index.js" ]] || { echo "Run this from the Workhelm project folder."; exit 1; }
sqlite3 /var/lib/workhelm/tracker.db ".backup '/var/backups/workhelm/before-update-$(date +%F-%H%M).db'"
rsync -a --delete --exclude data --exclude node_modules --exclude desktop --exclude _to_delete --exclude .git "$SRC/" /opt/workhelm/
systemctl restart workhelm
sleep 2
curl -fsS -o /dev/null http://127.0.0.1:3000/ && echo "Updated and running." || { echo "Not answering. See: journalctl -u workhelm -n 50"; exit 1; }
