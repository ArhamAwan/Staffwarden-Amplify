#!/usr/bin/env bash
# Put the dashboard on your own domain, with HTTPS (a free certificate that renews itself):
#
#   sudo bash deploy/domain.sh staffwarden.com
#   sudo bash deploy/domain.sh staffwarden.com --cloudflare   (the domain is proxied by Cloudflare: faster
#                                                              from Pakistan; run this BEFORE switching it)
#
# First, at your domain company, point the domain at this server: an A record for @ (and one for www)
# to this server's IP. This script checks that before changing anything.
#
# The older addresses keep working until everyone's desktop app has updated to one that uses the
# domain, so nobody is cut off:
#   - http://<IP>                      (the oldest apps)
#   - https://<ip-with-dashes>.sslip.io (the Cloudflare Worker, used by the apps since 0.9.10)
# Run it again any time; it only writes the web server's settings and reloads it.
set -euo pipefail
DOMAIN="${1:-}"; CF=no
[[ "${2:-}" == "--cloudflare" ]] && CF=yes
[[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^[0-9.]+$ && "$DOMAIN" == *.* ]] || { echo "Usage: sudo bash deploy/domain.sh <domain>   e.g. staffwarden.com"; exit 1; }
[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
ENVF=/etc/workhelm.env

IP="$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
resolves() { [[ "$(getent ahostsv4 "$1" | awk 'NR==1{print $1}')" == "$IP" ]]; }
if [[ "$CF" == no ]] && ! resolves "$DOMAIN"; then
  echo "$DOMAIN points to '$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')', but this server is $IP."
  echo "At your domain company add an A record: @ -> $IP (and remove any other A record for @),"
  echo "wait a few minutes, then run this again. Nothing was changed."
  exit 1
fi
WWW=no; resolves "www.$DOMAIN" && WWW=yes
[[ "$CF" == yes ]] && WWW=yes

# Behind Cloudflare every visit arrives from a Cloudflare address: trust those (and only those) to say who
# the person really is, so sign-in limits and the audit log see each person, not Cloudflare.
GLOBAL=""
if [[ "$CF" == yes ]]; then
  RANGES="$( (curl -fsS https://www.cloudflare.com/ips-v4; echo; curl -fsS https://www.cloudflare.com/ips-v6) | tr -s ' \n' ' ' )"
  [[ "$RANGES" == *"/"* ]] || { echo "Couldn't fetch Cloudflare's address list. Nothing was changed."; exit 1; }
  GLOBAL="{
  servers {
    trusted_proxies static $RANGES
    client_ip_headers CF-Connecting-IP X-Forwarded-For
  }
}
"
fi

SSLIP="${IP//./-}.sslip.io"
{
  [[ -n "$GLOBAL" ]] && echo "$GLOBAL"
  echo "# The dashboard, the desktop apps and the client portal"
  echo "$DOMAIN {"
  echo "  encode gzip"
  echo "  reverse_proxy 127.0.0.1:3000 {"
  echo "    header_up X-Forwarded-For {client_ip}"
  echo "    flush_interval -1"
  echo "  }"
  echo "}"
  if [[ "$WWW" == yes ]]; then
    echo
    echo "www.$DOMAIN {"
    echo "  redir https://$DOMAIN{uri} 308"
    echo "}"
  fi
  if grep -q '^WORKHELM_PROXY_SECRET=' "$ENVF" 2>/dev/null; then
    cat <<EOF

# The Cloudflare Worker fetches from here (apps from 0.9.10 until they update to the domain)
$SSLIP {
  encode gzip
  reverse_proxy 127.0.0.1:3000 {
    header_up X-Forwarded-For {client_ip}
    flush_interval -1
  }
}
EOF
  fi
  cat <<EOF

# The old plain address: the oldest apps may only find and download the update (which moves them to
# https://$DOMAIN). Nothing else travels unencrypted: no sign-ins, no data.
http://$IP {
  @update path /api/app/latest /downloads/*
  handle @update {
    reverse_proxy 127.0.0.1:3000 {
      header_up X-Forwarded-For {client_ip}
    }
  }
  handle {
    redir https://$DOMAIN{uri} 308
  }
}
EOF
} > /etc/caddy/Caddyfile.new
caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile >/dev/null
[[ -f /etc/caddy/Caddyfile ]] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-$DOMAIN"
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile

# links in notifications and pushes use the domain from now on
if grep -q '^WORKHELM_PUBLIC_URL=' "$ENVF" 2>/dev/null; then sed -i "s#^WORKHELM_PUBLIC_URL=.*#WORKHELM_PUBLIC_URL=https://$DOMAIN#" "$ENVF"; else echo "WORKHELM_PUBLIC_URL=https://$DOMAIN" >> "$ENVF"; fi
systemctl restart workhelm
systemctl reload caddy || systemctl restart caddy

echo "==> Waiting for the certificate for $DOMAIN"
for i in $(seq 1 45); do
  if curl -fsS -o /dev/null "https://$DOMAIN/api/downloads"; then
    echo "Done. The dashboard is at https://$DOMAIN"
    [[ "$WWW" == no ]] && echo "(www.$DOMAIN isn't pointed here; add an A record for www -> $IP and run this again if you want it.)"
    echo "The old addresses still work for apps that haven't updated yet."
    exit 0
  fi
  sleep 2
done
echo "The certificate isn't ready yet. Check: journalctl -u caddy --since '5 min ago'"
echo "The previous settings are saved in /etc/caddy/Caddyfile.before-$DOMAIN"
exit 1
