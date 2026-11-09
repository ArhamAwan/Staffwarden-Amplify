#!/usr/bin/env bash
# Turn this server into Staffwarden as a service: every company at its own address (northwind.staffwarden.com),
# sign-up and "find your company" on the plain address, and your console at admin.<domain>. The company
# already on this server stays exactly as it is, at its own address too, free, and its desktop apps keep working.
#
#   sudo bash deploy/service.sh staffwarden.com amplify you@example.com
#     1st: your domain     2nd: the address for the company already here (amplify.staffwarden.com)
#     3rd: the email(s) that may open the console, comma separated
#
# Before you run it (the domain is at Hostinger, its traffic goes through Cloudflare):
#   1. Cloudflare › DNS: an A record for @ and one for * (the wildcard) to this server's IP, both Proxied.
#   2. Cloudflare › SSL/TLS: Full (strict).
#   3. Cloudflare › SSL/TLS › Origin Server › Create certificate, for "staffwarden.com" and "*.staffwarden.com".
#      Save the certificate as /etc/caddy/origin.pem and the private key as /etc/caddy/origin-key.pem on this server.
# Run it again any time; it only writes the web server's settings and the service's settings, then reloads.
set -euo pipefail
DOMAIN="${1:-}"; SLUG="${2:-}"; ADMINS="${3:-}"
[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
[[ -n "$DOMAIN" && "$DOMAIN" == *.* && -n "$SLUG" && -n "$ADMINS" ]] || { echo "Usage: sudo bash deploy/service.sh <domain> <address-for-this-company> <console-email>"; exit 1; }
[[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$ ]] || { echo "The company address is 3 to 32 lowercase letters, numbers and dashes."; exit 1; }
CERT=/etc/caddy/origin.pem; KEY=/etc/caddy/origin-key.pem
[[ -s "$CERT" && -s "$KEY" ]] || { echo "Put the Cloudflare Origin certificate in $CERT and its key in $KEY first (step 3 above). Nothing was changed."; exit 1; }
chown root:caddy "$CERT" "$KEY" 2>/dev/null || true; chmod 640 "$KEY"
ENVF=/etc/workhelm.env
setenv() { if grep -q "^$1=" "$ENVF" 2>/dev/null; then sed -i "s#^$1=.*#$1=$2#" "$ENVF"; else echo "$1=$2" >> "$ENVF"; fi; }

# every visit arrives from Cloudflare: trust only Cloudflare to say who the person really is
RANGES="$( (curl -fsS https://www.cloudflare.com/ips-v4; echo; curl -fsS https://www.cloudflare.com/ips-v6) | tr -s ' \n' ' ' )"
[[ "$RANGES" == *"/"* ]] || { echo "Couldn't fetch Cloudflare's address list. Nothing was changed."; exit 1; }
IP="$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
SSLIP="${IP//./-}.sslip.io"
# Caddy works out the visitor's real address (from Cloudflare's header, only when the request really comes
# from Cloudflare) and passes exactly that on: whatever X-Forwarded-For a visitor sends is replaced.
PROXY='  encode gzip
  reverse_proxy 127.0.0.1:3000 {
    header_up X-Forwarded-For {client_ip}
    flush_interval -1
  }'
{
  cat <<EOF
{
  servers {
    trusted_proxies static $RANGES
    client_ip_headers CF-Connecting-IP X-Forwarded-For
  }
}

# Staffwarden: the website and sign-up, every company's address and the console
$DOMAIN, *.$DOMAIN {
  tls $CERT $KEY
$PROXY
}

www.$DOMAIN {
  tls $CERT $KEY
  redir https://$DOMAIN{uri} 308
}

# The old plain address: desktop apps from before the domain may only find and download the update
# (which moves them to https://$DOMAIN). Nothing else travels unencrypted: no sign-ins, no data.
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
  if grep -q '^WORKHELM_PROXY_SECRET=' "$ENVF" 2>/dev/null; then printf '\n# The Cloudflare Worker (apps from 0.9.10)\n%s {\n%s\n}\n' "$SSLIP" "$PROXY"; fi
} > /etc/caddy/Caddyfile.new
caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile >/dev/null
[[ -f /etc/caddy/Caddyfile ]] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-service"
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile

bash /opt/workhelm/deploy/backup.sh before-update
setenv BASE_DOMAIN "$DOMAIN"
setenv DEFAULT_TENANT "$SLUG"
setenv PLATFORM_ADMINS "$ADMINS"
setenv WORKHELM_PUBLIC_URL "https://$SLUG.$DOMAIN"
printf '#!/bin/sh\nbash /opt/workhelm/deploy/backup.sh\n' > /etc/cron.daily/workhelm-backup; chmod 755 /etc/cron.daily/workhelm-backup
systemctl restart workhelm
systemctl reload caddy || systemctl restart caddy
sleep 3
for u in "https://$DOMAIN/api/platform/config" "https://$SLUG.$DOMAIN/api/downloads"; do
  if curl -fsS -o /dev/null --resolve "${u#https://}:443:127.0.0.1" -k "$u" 2>/dev/null || curl -fsS -o /dev/null "$u"; then echo "OK  $u"; else echo "Not answering yet: $u"; fi
done
cat <<EOF

Done. Staffwarden is now a service at https://$DOMAIN
  This company:   https://$SLUG.$DOMAIN   (free, never paused)
  Your console:   https://admin.$DOMAIN   (a code is emailed to $ADMINS)

Still to set in $ENVF, then: sudo systemctl restart workhelm
  Email (sign-up codes, invites, receipts):  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
  Card payments (Stripe):  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
    STRIPE_PRICE_STARTER_YEAR, STRIPE_PRICE_STARTER_MONTH, STRIPE_PRICE_BUSINESS_YEAR,
    STRIPE_PRICE_BUSINESS_MONTH, STRIPE_PRICE_PRO_YEAR, STRIPE_PRICE_PRO_MONTH
  Stripe's webhook address: https://$DOMAIN/api/platform/stripe/webhook
    (events: checkout.session.completed, customer.subscription.created/updated/deleted, invoice.paid, invoice.payment_failed)
EOF
