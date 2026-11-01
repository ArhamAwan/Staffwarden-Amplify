#!/usr/bin/env bash
# Workhelm: move from http://<server IP> to https://<domain> (encrypted, with a free certificate that
# renews itself). Point the domain at this server first (an A record), then run on the server:
#
#   sudo bash deploy/https.sh workhelm.yourcompany.com
#
# After this, the dashboard is at https://<domain>, and http://<IP> only does two things for desktop apps
# that still use the old address: it tells them a new version is out and serves the installer (so they
# update themselves to the HTTPS build). Everything else on the plain address is sent to the HTTPS site,
# so nothing about people's work travels unencrypted. Remove the IP block later with: --no-legacy
set -euo pipefail
DOMAIN="${1:-}"; LEGACY=yes
[[ "${2:-}" == "--no-legacy" ]] && LEGACY=no
[[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^[0-9.]+$ ]] || { echo "Usage: sudo bash deploy/https.sh <domain> [--no-legacy]"; exit 1; }
[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }

IP="$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
RESOLVED="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')"
if [[ "$RESOLVED" != "$IP" ]]; then
  echo "$DOMAIN points to '${RESOLVED:-nothing}', but this server is $IP."
  echo "Add an A record: $DOMAIN -> $IP, wait a few minutes, then run this again."
  exit 1
fi

{
  echo "$DOMAIN {"
  echo "  encode gzip"
  echo "  reverse_proxy 127.0.0.1:3000"
  echo "}"
  if [[ "$LEGACY" == yes ]]; then
    cat <<EOF

# Older desktop apps still use http://$IP: only let them find and download the update.
http://$IP {
  @update path /api/app/latest /downloads/*
  handle @update {
    reverse_proxy 127.0.0.1:3000
  }
  handle {
    redir https://$DOMAIN{uri} 308
  }
}
EOF
  fi
} > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy || systemctl restart caddy

echo "==> Waiting for the certificate"
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "https://$DOMAIN/"; then
    echo "Done. Workhelm is now at https://$DOMAIN (encrypted)."
    [[ "$LEGACY" == yes ]] && echo "Old desktop apps on http://$IP can still update themselves. Once everyone is on the new version: sudo bash deploy/https.sh $DOMAIN --no-legacy"
    exit 0
  fi
  sleep 2
done
echo "The certificate is not ready yet. Check: journalctl -u caddy --since '5 min ago'"
exit 1
