#!/usr/bin/env bash
# Workhelm: copy the nightly backups to a second place, so losing the server does not lose the data.
# Works with any S3-compatible storage: Contabo Object Storage, Backblaze B2, Cloudflare R2, AWS S3.
#
#   sudo bash deploy/offsite-backup.sh            # one-time setup (asks for the storage details)
#   sudo bash deploy/offsite-backup.sh --now      # copy right now and show the result
#
# Every night after the local backup: the database backups and task attachments are copied, and
# (optionally) screenshots. Nothing is ever deleted from the storage by this script except database
# backups older than 30 days.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
DATA=/var/lib/workhelm; BK=/var/backups/workhelm; CONF=/etc/workhelm-offsite.env; REMOTE=workhelm-offsite

run_copy() {
  # shellcheck disable=SC1090
  source "$CONF"
  local dest="$REMOTE:$BUCKET/workhelm"
  # make sure today's local backup exists first
  [[ -x /etc/cron.daily/workhelm-backup ]] && /etc/cron.daily/workhelm-backup || true
  rclone copy "$BK" "$dest/db" --include 'tracker-*.db' --include 'before-update-*.db' --transfers 2
  rclone delete "$dest/db" --min-age 30d --include 'tracker-*.db' || true
  [[ -d "$DATA/files" ]] && rclone copy "$DATA/files" "$dest/files" --transfers 4
  # each company's own files (on Staffwarden as a service)
  if [[ -d "$DATA/companies" ]]; then for d in "$DATA"/companies/*/files; do [[ -d "$d" ]] && rclone copy "$d" "$dest/companies/$(basename "$(dirname "$d")")/files" --transfers 4; done; fi
  if [[ "${SCREENSHOTS:-no}" == "yes" && -d "$DATA/screenshots" ]]; then rclone copy "$DATA/screenshots" "$dest/screenshots" --transfers 8; fi
  echo "Copied to $BUCKET at $(date)."
}

if [[ "${1:-}" == "--now" ]]; then
  [[ -f "$CONF" ]] || { echo "Not set up yet. Run: sudo bash deploy/offsite-backup.sh"; exit 1; }
  run_copy; rclone lsl "$REMOTE:$(. "$CONF"; echo "$BUCKET")/workhelm/db" | tail -5; exit 0
fi

if ! command -v rclone >/dev/null; then
  echo "==> Installing rclone"
  apt-get install -y -qq rclone >/dev/null || curl -fsSL https://rclone.org/install.sh | bash
fi

echo "Off-site backup. Create a PRIVATE bucket and an access key in your storage provider first."
echo "  Contabo Object Storage endpoint looks like: https://eu2.contabostorage.com"
echo "  Backblaze B2 (S3) endpoint looks like:     https://s3.eu-central-003.backblazeb2.com"
read -rp  "S3 endpoint URL: " ENDPOINT
read -rp  "Bucket name: " BUCKET
read -rp  "Access key ID: " KEY
read -rsp "Secret access key: " SECRET; echo
read -rp  "Also copy screenshots? They take the most space (yes/no) [no]: " SHOTS
SHOTS=${SHOTS:-no}

rclone config create "$REMOTE" s3 provider Other endpoint "$ENDPOINT" access_key_id "$KEY" secret_access_key "$SECRET" acl private >/dev/null
chmod 600 /root/.config/rclone/rclone.conf
umask 077
cat > "$CONF" <<EOF
BUCKET=$BUCKET
SCREENSHOTS=$SHOTS
EOF

cat > /etc/cron.daily/zz-workhelm-offsite <<'EOF'
#!/bin/sh
# runs after workhelm-backup (cron.daily runs scripts in name order)
bash /opt/workhelm/deploy/offsite-backup.sh --now >> /var/log/workhelm-offsite.log 2>&1
EOF
chmod 755 /etc/cron.daily/zz-workhelm-offsite

echo "==> Test copy"
run_copy
echo "Done. Every night the backups are copied to $BUCKET. Log: /var/log/workhelm-offsite.log"
echo "To restore: rclone copy $REMOTE:$BUCKET/workhelm/db/<file>.db . then see README > Restoring."
