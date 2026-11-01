#!/usr/bin/env bash
# Workhelm: one-time server setup on a fresh Ubuntu 22.04 / 24.04 VPS.
# Installs Node 22, Caddy (automatic HTTPS), runs Workhelm as a service, opens the firewall,
# and backs up the database every night. Run it from inside the uploaded project folder:
#
#   sudo bash deploy/setup.sh tracker.yourcompany.com you@yourcompany.com
#   sudo bash deploy/setup.sh 203.0.113.10 you@yourcompany.com      (no domain yet: plain HTTP on the IP)
#
# It asks for the owner password (never stored in shell history). Safe to run again.
set -euo pipefail

DOMAIN="${1:-}"; OWNER_EMAIL="${2:-}"
if [[ -z "$DOMAIN" || -z "$OWNER_EMAIL" ]]; then
  echo "Usage: sudo bash deploy/setup.sh <domain> <owner-email>"; exit 1
fi
if [[ $EUID -ne 0 ]]; then echo "Run with sudo."; exit 1; fi
SRC="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$SRC/server/index.js" ]] || { echo "Run this from the Workhelm project folder."; exit 1; }

# quote a value for a systemd EnvironmentFile
q() { local v="${1//\\/\\\\}"; v="${v//\"/\\\"}"; printf '"%s"' "$v"; }

APP=/opt/workhelm; DATA=/var/lib/workhelm; ENVF=/etc/workhelm.env; BK=/var/backups/workhelm

if [[ ! -f "$ENVF" ]]; then
  read -rp  "Owner's full name: " OWNER_NAME
  while :; do
    read -rsp "Owner password (12+ characters): " P1; echo
    read -rsp "Repeat it: " P2; echo
    [[ "$P1" == "$P2" && ${#P1} -ge 12 ]] && break
    echo "Passwords differ or are shorter than 12 characters. Try again."
  done
  read -rp  "Company name shown in the dashboard [Amplify Media Technologies]: " ORG
  ORG="${ORG:-Amplify Media Technologies}"
fi

echo "==> Packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https rsync sqlite3 ufw >/dev/null

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(node -v)"

if ! command -v caddy >/dev/null; then
  echo "==> Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

echo "==> App files"
id workhelm >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin workhelm
mkdir -p "$APP" "$DATA" "$BK"
rsync -a --delete --exclude data --exclude node_modules --exclude desktop --exclude _to_delete --exclude .git "$SRC/" "$APP/"
chown -R root:root "$APP"; chown -R workhelm:workhelm "$DATA"; chmod 750 "$DATA"

if [[ ! -f "$ENVF" ]]; then
  umask 077
  cat > "$ENVF" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DATA_DIR=$DATA
OWNER_EMAIL=$OWNER_EMAIL
OWNER_NAME=$(q "$OWNER_NAME")
OWNER_PASSWORD=$(q "$P1")
ORG_NAME=$(q "$ORG")
TZ_OFFSET_MIN=300
EOF
  chmod 600 "$ENVF"
fi

echo "==> Service"
cat > /etc/systemd/system/workhelm.service <<EOF
[Unit]
Description=Workhelm (built in-house by Amplify Media Technologies)
After=network-online.target
Wants=network-online.target

[Service]
User=workhelm
Group=workhelm
WorkingDirectory=$APP
EnvironmentFile=$ENVF
ExecStart=$(command -v node) --no-warnings server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now workhelm >/dev/null
systemctl restart workhelm

# An IP address (no domain yet): plain HTTP on port 80. A domain: automatic HTTPS.
# To move from the IP to a domain later, point the domain at the server and run this script again with it.
if [[ "$DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "==> Plain HTTP on $DOMAIN (no domain yet, so no HTTPS certificate)"
  SITE=":80"; URL="http://$DOMAIN"
else
  echo "==> HTTPS for $DOMAIN"
  SITE="$DOMAIN"; URL="https://$DOMAIN"
fi
cat > /etc/caddy/Caddyfile <<EOF
$SITE {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
EOF
systemctl reload caddy || systemctl restart caddy

echo "==> Firewall (SSH, HTTP, HTTPS only)"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "==> Nightly database backup (kept 14 days) at $BK"
cat > /etc/cron.daily/workhelm-backup <<EOF
#!/bin/sh
sqlite3 $DATA/tracker.db ".backup '$BK/tracker-\$(date +%F).db'" && find $BK -name 'tracker-*.db' -mtime +14 -delete
EOF
chmod 755 /etc/cron.daily/workhelm-backup

sleep 2
if curl -fsS -o /dev/null http://127.0.0.1:3000/; then
  echo; echo "Workhelm is running. Open $URL and sign in as $OWNER_EMAIL"
  [[ "$URL" == https* ]] && echo "(The certificate is issued on the first visit; give it up to a minute.)"
  [[ "$URL" == http:* ]] && echo "Note: without a domain, traffic is not encrypted. Move to a domain with HTTPS before real use."
else
  echo; echo "The service did not answer. See: journalctl -u workhelm -n 50"; exit 1
fi
