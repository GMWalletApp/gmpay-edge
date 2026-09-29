# GMPay Edge deployment checklist

[简体中文](../zh-CN/DEPLOYMENT.md) · English

This checklist deploys one single-tenant GMPay Edge instance on Cloudflare
Workers or Bun/Nitro. Operators use
`/admin`; merchants integrate only through the signed GMPay protocol or its
EPay boundary adapter.

## Deployment paths

### Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/GMWalletApp/gmpay-edge)

The guided flow forks the repository and configures Workers Builds. The source
repository must be public when the button is used. Configure `bun run build` as
the Build command and the auto-detected `bun run deploy` as the Deploy command. The build command
reuses exact named D1, KV, R2, and Queue resources, creates only missing ones,
applies the D1 baseline, and compiles a Vite artifact containing the resolved
D1/KV IDs. The deploy lifecycle skips rebuilding inside Workers Builds and uploads
that generated artifact. The portable source `wrangler.jsonc` is never rewritten.
When deployment finishes, open `/install` on the Worker URL.

### Wrangler CLI

Authenticate Wrangler and run the package deployment command. Its `predeploy`
hook reuses exact named D1, KV, R2, and Queue resources, creates only missing
ones, applies the D1 baseline, and builds the resolved Vite artifact before
publication:

```bash
bun install
bunx wrangler login
bun run deploy
```

If necessary, prepare D1 manually with `bunx wrangler d1 create gmpay-edge`
and then `bun run db:migrate:remote`. Keep the generated database ID out of the
portable source configuration.

### Bun and Docker

The public [GHCR package](https://github.com/orgs/GMWalletApp/packages/container/package/gmpay-edge)
supports `linux/amd64` and `linux/arm64`. No registry login is required.

| Tag | Recommended use |
| --- | --- |
| `latest` | Latest stable release |
| `1.0.0` | Fixed release for reproducible deployment |

#### Docker Compose

Save the following as `compose.yml`:

```yaml
services:
  gmpay-edge:
    image: ghcr.io/gmwalletapp/gmpay-edge:latest
    restart: unless-stopped
    # Plain HTTP for a reverse proxy on this host; see "Reverse proxy and TLS".
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      GMPAY_DATA_DIR: /var/lib/gmpay
    volumes:
      - gmpay-data:/var/lib/gmpay

volumes:
  gmpay-data:
```

```bash
docker compose pull
docker compose up -d
```

#### Docker command

If Compose is not available, run the container directly:

```bash
docker volume create gmpay-data
docker run --detach --name gmpay-edge --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  --env GMPAY_DATA_DIR=/var/lib/gmpay \
  --volume gmpay-data:/var/lib/gmpay \
  ghcr.io/gmwalletapp/gmpay-edge:latest
```

#### Reverse proxy and TLS

The container speaks plain HTTP, and the examples above publish it only on the
host's loopback interface. Production traffic must reach it through a
TLS-terminating reverse proxy on the same host or private network, or through
TLS terminated by Bun itself.

GMPay Edge derives the client address from the TCP peer of each connection.
When the peer is a loopback, private, or link-local address (`127.0.0.0/8`,
`::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`,
`fc00::/7`, `fe80::/10`), the right-most `X-Forwarded-For` hop becomes the
client address and `X-Forwarded-Proto: https` marks the request as HTTPS, which
enables HSTS and secure cookies. Forwarded headers from any other peer are
discarded, and an inbound `cf-connecting-ip` header is always replaced, so
per-IP rate limits and audit records cannot be spoofed by clients. The proxy
must therefore:

- preserve the original `Host` header, which Allowed Hosts validates;
- set `X-Forwarded-Proto` to the client-facing scheme (overwrite, do not append);
- append the connecting client address to `X-Forwarded-For`;
- when a CDN such as Cloudflare fronts the proxy, place the real client address
  in the right-most position (for example nginx `set_real_ip_from` with the CDN
  ranges and `real_ip_header CF-Connecting-IP`); otherwise every visitor shares
  the CDN address.

Caddy does all of this by default:

```caddyfile
pay.example {
    reverse_proxy 127.0.0.1:3000
}
```

nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

To terminate TLS in Bun without a proxy, set `NITRO_SSL_CERT` and
`NITRO_SSL_KEY` to PEM file paths (or PEM contents) and publish the port
directly; every peer is then public, and its socket address is the client
address.

`HOST`, `PORT`, and `NODE_ENV` are Nitro server variables baked into the image
(`0.0.0.0`, `3000`, `production`); together with `NITRO_SSL_CERT` and
`NITRO_SSL_KEY` they only shape the listener. Product behavior is configured
exclusively by `GMPAY_DATA_DIR` and the authenticated admin settings.

#### First-time setup

Wait for `GET /healthz` to succeed, then open `/install` on the public URL.
Confirm the detected address and Allowed Hosts before creating the first root
user. Configure application, security, and email settings in the admin
interface; do not add them as container environment variables.

`GMPAY_DATA_DIR` points to the persistent directory. It contains SQLite,
uploaded files, private objects, queue state, and all other runtime data. Back
up and preserve the named volume whenever the container is updated or recreated.

#### Common commands

Verify and operate a Compose deployment with:

```bash
curl --fail http://127.0.0.1:3000/healthz
docker compose ps
docker compose logs --follow gmpay-edge
docker compose pull
docker compose up -d
```

The final two commands update the selected tag and recreate the container while
keeping the named volume.

To build the Bun artifact from source, run `bun run build:bun`. The Workers
commands remain exactly as above and continue to use the Cloudflare Vite adapter.
For backups, restores, and D1/R2 migration, follow
[Bun data operations](NODE_DATA_OPERATIONS.md) and use the maintained `data`
package script with its `backup`, `restore`, and `import-cloudflare` subcommands.

## Cloudflare resources

- [ ] Configure at least one provider under **Admin → Email delivery**. To use Cloudflare Email, bind Email Routing as `EMAIL` and confirm that the Workers-only provider appears. Send a live recovery email and confirm the 15-minute link works; the sign-in page deliberately returns a generic response when delivery is unavailable. SMTP channels connect with implicit TLS on port 465; on any other port GMPay Edge first probes `EHLO` and refuses delivery unless `STARTTLS` is advertised, so credentials and messages never travel in plaintext, and certificate validation cannot be disabled. Prefer port 465 when the provider offers it.
- [ ] Confirm the Workers build creates or reuses the `gmpay-edge` D1 database and links it as `DB`.
- [ ] Build once and verify the Wrangler `assets.directory` publishes `dist/client`; static files are served by Cloudflare's platform asset handling without exposing an `ASSETS` binding to application code, while application and API routes continue through the Worker.
- [ ] Confirm the deploy log reads `dist/server/wrangler.json` with `main: index.js` and `no_bundle: true`; Wrangler must not rebundle `src/server-entry.ts` or report unresolved `#tanstack-router-entry`/`#tanstack-start-entry` modules.
- [ ] Confirm the Workers build creates or reuses the private R2 bucket `gmpay-edge-files` and links it as `FILES`.
- [ ] Keep `gmpay-edge-files` private and configure an R2 lifecycle policy for payer-submitted review evidence; evidence is served only through the authenticated Worker route.
- [ ] Confirm the Workers build creates or reuses the `gmpay-edge-cache` KV namespace and links it as `CACHE`.
- [ ] Verify an `audit:create` user can export audit logs and that an NDJSON artifact appears under `exports/audit-logs/` in R2. Structured secret fields are redacted and the export action is itself audited.
- [ ] Create a signed test order with a public HTTPS `notify_url`; verify GMPay JSON/EPay query signatures with the creating API credential's current Secret, then explicitly resend the order notification and confirm a new delivery record is retained.
- [ ] Edit a test RPC credential and confirm the node is disabled with its previous health result cleared; test it successfully before enabling it again.
- [ ] Disable the final ready receiving method for a test asset and confirm it disappears from the public/API catalog; re-enable it only after target and access validation succeed.
- [ ] Edit a Binance, OKX, or OKPay receiving method's read-only account configuration and confirm the receiving method remains disabled until its replacement identity and access pass validation.
- [ ] Trigger **Sync rates** with one intentionally unavailable test source; verify other pairs update, the failed observation keeps its prior expiry, and the audit summary contains no provider response body.
- [ ] Grant a test role `operations:read` without `operations:update`; verify it can inspect health but cannot run manual recovery tasks. Then grant update and test each bounded task separately.
- [ ] Rotate a test Telegram Bot Token and confirm its existing subscriptions remain, the new bot receives the secret-token Webhook, and the old token is revoked or its Webhook removed.
- [ ] Confirm the Workers build creates or reuses `gmpay-edge-webhooks`, `gmpay-edge-webhooks-dlq`, `gmpay-edge-payments`, and `gmpay-edge-payments-dlq`; producers are linked as `WEBHOOK_QUEUE` and `PAYMENT_QUEUE`.
- [ ] Deploy Queue producers and consumers from the same release; payloads require the explicit `webhook.delivery`, `payment.scan`, or `payment.provider_event` kind with `version: 1`.
- [ ] For each enabled Alchemy event source, use a dedicated Address Activity webhook, verify the copied HTTPS callback URL and Allowed Host, and confirm reconciliation validates the remote type, network, URL, active state, and addresses before reporting healthy.
- [ ] Complete an Alchemy shadow-mode low-value drill before activating accounting; inspect the provider-event row, exercise one eligible manual retry, and confirm a duplicate or changed delivery cannot create extra payment events.
- [ ] Keep the Webhook consumer retry/DLQ policy enabled for Worker crashes. GMPay Edge persists and schedules application-level Webhook attempts separately in D1, so `webhooks.max_attempts` may exceed one Queue message's `max_retries` without leaving deliveries stuck in `failed`.
- [ ] Confirm `bun run deploy` creates or reuses `gmpay-edge` and applies the D1 baseline before publication; use `bun run db:migrate:remote` only for an explicit database-only run.
- [ ] Complete `/install`; it generates authentication/signing values and payment defaults, requires confirmation of the detected Origin, stores it as the application URL and an Allowed Host, and signs the root user in automatically.
- [ ] Open **Forgot password**, receive the 15-minute one-time link, reset the password, and confirm previous sessions no longer authenticate.
- [ ] Review **Admin → System settings → Authentication** and **Secret management**; verify the production HTTPS origin and back up `runtime.better_auth_secret` with D1.
- [ ] Configure each intended provider according to [PAYMENT_METHODS.md](PAYMENT_METHODS.md); use read-only exchange credentials and verify token identifiers and decimals.
- [ ] Configure crypto and fiat rate sync settings; use **Run now** in each settings dialog once, verify raw/final observations, then confirm the one-minute Cron respects each category's automatic-sync switch and saved interval.

## Latency on Cloudflare

Every D1 statement is a network round trip to the database's primary region, so
request latency on Workers is governed by how many statements run in sequence
and how far the Worker is from D1. An authenticated admin call performs the
Allowed Hosts settings read and the Better Auth session lookup concurrently and
then its own queries; a checkout quotes every payment option from a single
exchange-rate read. Three checks close the remaining gap:

- **Smart Placement.** `wrangler.jsonc` enables it, but Cloudflare only applies
  it after observing traffic. Confirm the status under Workers & Pages →
  the Worker → Settings → Placement; it should report that Smart Placement is
  active so the Worker runs near the D1 primary.
- **D1 read replication.** Enable it once per database under D1 → the
  database → Settings → Read replication (or through the REST API). Lists,
  dashboards, operations views, and checkout reads then run on a session that
  may be served by a replica near the Worker; authorization, settings, and every
  write stay on the primary. After a mutation the response sets the
  `gmpay_d1_bookmark` cookie (HttpOnly, five minutes) so the same browser's next
  reads are anchored at least at that write. Without read replication the
  session resolves to the primary and nothing changes.
- **Measure before tuning.** Every response carries a `Server-Timing` header
  with `authority` (settings read), `session` (Better Auth lookup), `rbac`
  (permission cache), `app`, and `total` in milliseconds. Compare it with the
  D1 metrics page (query latency, rows read) to see which segment dominates for
  your users before changing regions or caching.

## Bun resources

- [ ] Confirm the container runs as its non-root user and the persisted directory is writable only by the intended host/container identity.
- [ ] Confirm the volume contains `gmpay.sqlite`, private objects, and durable queue state after installation and a test upload/order.
- [ ] Configure a supported Bun email provider and send a password-recovery test. Confirm the provider list matches Workers and no email secret appears in the container environment.
- [ ] Restart the container and confirm queued Webhook/payment work and scheduled jobs resume without duplicate accounting or delivery.
- [ ] Stop the container, run `bun run data -- backup` to an external location, restore with `bun run data -- restore` into a new data directory, and verify manifest, SQLite integrity, migration checksum, sign-in, and private-object access.
- [ ] When migrating from Workers, run `bun run data -- import-cloudflare` against explicit D1 SQL and optional R2 export paths; import only into a new or empty target, then repeat signed order and callback acceptance tests.

## Automated releases

Every push to `main` runs the quality gate; semantic-release then publishes a
stable release such as `1.0.0` when Conventional Commits require one. There is
no prerelease channel. A release updates `package.json` and `bun.lock`, creates
the GitHub Release with generated notes and a tag, then calls the independent
Docker smoke and multi-architecture publish workflow. Native x64 and Arm64
runners build and smoke-test their platform images in parallel before the
workflow assembles the published manifest with the exact version plus moving
major, minor, and `latest` tags. Dependency ranges are carets, so the release
step's lockfile-only install records the new package version without
re-resolving dependencies. Pull requests run the same gate in the `CI`
workflow.

The `gmpay-edge` GHCR package is public. Release acceptance verifies an
unauthenticated pull.

## Release gate

`bun run typecheck` generates Paraglide messages first, so the list is
reproducible from a clean clone; the `CI` workflow runs the same five commands
for every pull request and push to `main`.

- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] `bun run check`
- [ ] `bun run build`
- [ ] `bun run build:bun`
- [ ] Open sign-in and verify an uninitialized deployment redirects to root-user initialization.
- [ ] Create and enable the intended asset, channel, and receiving address; development-only mock channels must never be enabled unintentionally in production.
- [ ] Verify binding-free `GET/HEAD /healthz`, detailed `/status`, root-user initialization, sign-in, and one signed GMPay end-to-end order in the intended channel.
- [ ] Confirm merchant notification targets use public HTTPS, provider/Telegram inbound paths validate their provider-specific signatures, and GMPay/EPay outbound signatures match the documented canonical parameters.
- [ ] Confirm no `.dev.vars`, wallet keys, merchant secrets, or Cloudflare tokens are tracked.
- [ ] Smoke-test the selected production runtime; when releasing, verify the GHCR image digest and both architectures from the GitHub Release.
- [ ] Verify the public GHCR image can be pulled without authentication.
