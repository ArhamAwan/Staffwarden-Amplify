#!/usr/bin/env bash
# Workhelm: get the server ready for the Cloudflare Worker (see deploy/cloudflare-worker.js).
#   sudo bash deploy/cloudflare.sh
# - gives the server an HTTPS address of its own for Cloudflare to fetch from: <ip-with-dashes>.sslip.io
#   (a free name that always points at this IP), with a certificate that renews itself;
# - keeps http://<IP> working exactly as before, so apps not yet updated carry on;
# - creates the shared secret the Worker sends, so the server can see each person's real address.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
ENVF=/etc/workhelm.env
IP="$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
HOST="${IP//./-}.sslip.io"

if ! grep -q '^WORKHELM_PROXY_SECRET=' "$ENVF"; then
  echo "WORKHELM_PROXY_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)" >> "$ENVF"
fi
SECRET="$(grep '^WORKHELM_PROXY_SECRET=' "$ENVF" | cut -d= -f2-)"

cat > /etc/caddy/Caddyfile <<CADDY
# Old address, unchanged (apps not yet updated, and the IP in a browser)
:80 {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}

# HTTPS address the Cloudflare Worker fetches from
$HOST {
  encode gzip
  reverse_proxy 127.0.0.1:3000 {
    flush_interval -1
  }
}
CADDY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl restart workhelm
systemctl reload caddy || systemctl restart caddy

echo "==> Waiting for the certificate for $HOST"
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "https://$HOST/api/downloads"; then
    echo
    echo "Ready. In the Cloudflare Worker, set:"
    echo "  ORIGIN        = https://$HOST"
    echo "  PROXY_SECRET  = $SECRET      (add it as a Secret)"
    exit 0
  fi
  sleep 2
done
echo "The certificate is not ready yet. Check: journalctl -u caddy --since '5 min ago'"
exit 1
