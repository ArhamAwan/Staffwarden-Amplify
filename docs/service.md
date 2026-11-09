# Staffwarden as a service

Every company gets its own address (`northwind.staffwarden.com`) and its own database. The plain
address is the website, sign-up (`/signup`) and "find your company" (`/signin`, `/forgot`).
`admin.<domain>` is the owner console. Without `BASE_DOMAIN` the server runs one company, as before.

## Turning it on

1. Cloudflare DNS: `A @` and `A *` to the server, both proxied. SSL/TLS: Full (strict).
2. Cloudflare › SSL/TLS › Origin Server: make a certificate for `staffwarden.com` and `*.staffwarden.com`.
   Save it on the server as `/etc/caddy/origin.pem` and the key as `/etc/caddy/origin-key.pem`.
3. `sudo bash deploy/service.sh staffwarden.com <address-for-the-company-already-here> <console-email>`

The company already on the server keeps its data where it is, at its own address, free and never paused.
Desktop apps that talk to the plain address keep reaching it.

## Settings (`/etc/workhelm.env`)

| Setting | What it is |
| --- | --- |
| `BASE_DOMAIN` | `staffwarden.com`. Set by `service.sh`. |
| `DEFAULT_TENANT` | The address of the company that was on this server first. |
| `PLATFORM_ADMINS` | Emails that may open the console (comma separated). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Email for sign-up codes, invites, password links, receipts and reminders. Required in production: without it, sign-up stays closed (on a test server the code is shown on the page instead). Invite links are shown to whoever invites. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Card payments. |
| `STRIPE_PRICE_<STARTER\|BUSINESS\|PRO>_<YEAR\|MONTH>` | The six Stripe price ids, each priced per person: yearly $48 / $84 / $120, monthly $4.80 / $8.40 / $12. |

Stripe webhook: `https://<domain>/api/platform/stripe/webhook`, with `checkout.session.completed`,
`customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.paid` and `invoice.payment_failed`. Turn on the customer portal (update card, invoices) in Stripe.

## How an account runs

- 14-day trial with every feature. Card at checkout, charged when the trial ends.
- A declined card: 7 days of grace, then tracking pauses. Paused or closed companies are kept 60 days,
  with emails at 30 and 7 days; after that the console offers "Remove", which moves the folder to
  `<data>/removed/` (nothing is erased by the service).
- Moving down a plan waits for the renewal; moving up is charged for the time left.
- People invited but not joined, archived people, clients and the owner are not paid for.
- Payroll pays in the company's own currency (any of 20). Pakistan's income tax and EOBI apply only to
  pay in rupees; other countries add tax as deductions.

## Backups

`deploy/backup.sh` (nightly, and before every update) copies every company's database and the service's
own (`platform/platform.db`). `deploy/offsite-backup.sh` copies them, and each company's files, off the server.
