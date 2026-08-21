# GMPay Edge deployment checklist

[简体中文](../zh-CN/DEPLOYMENT.md) · English

This checklist deploys one single-tenant GMPay Edge instance on Cloudflare
Workers or Node/Nitro. Operators use
`/admin`; merchants integrate only through the signed GMPay protocol or its
EPay boundary adapter.

## Deployment paths

### Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/GMWalletApp/gmpay-edge)

The guided flow forks the repository and configures Workers Builds. The source
repository must be public when the button is used. Configure `bun run build` as
the Build command and `wrangler deploy` as the Deploy command. The build command
reuses exact named D1, KV, R2, and Queue resources, creates only missing ones,
applies the D1 baseline, and compiles a Vite artifact containing the resolved
D1/KV IDs. The portable source `wrangler.jsonc` is never rewritten.
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

### Node and Docker

After completing the one-time visibility step below, pull the public GHCR image
and use the included Compose definition:

```bash
docker compose pull
docker compose up -d
```

The image supports `linux/amd64` and `linux/arm64`. Its only user-facing
environment variable is `GMPAY_DATA_DIR`; the supplied Compose file sets it to
`/var/lib/gmpay` and persists that directory in a named volume. Do not pass
Origin, Allowed Hosts, email credentials, or application secrets as container
environment variables.

After `GET /healthz` succeeds, open `/install` on the externally reachable URL.
Confirm the detected Origin and Allowed Hosts before creating the root user.
Maintain ordered providers under the top-level **Admin → Email delivery** page.
Node and Workers show the same provider types. Cloudflare Email delivers only
when the `EMAIL` binding is available. SMTP port 465 uses implicit TLS, port 587
uses STARTTLS, and port 25 or a non-public hostname is rejected.

To build the Node artifact from source, run `bun run build:node`. The Workers
commands remain exactly as above and continue to use the Cloudflare Vite adapter.
For backups, restores, and D1/R2 migration, follow
[Node data operations](NODE_DATA_OPERATIONS.md) and use the maintained
the `data` package script with its `backup`, `restore`, and `import-cloudflare` subcommands.

## Cloudflare resources

- [ ] Configure at least one provider under **Admin → Email delivery**. To use Cloudflare Email, bind Email Routing as `EMAIL` and confirm that the Workers-only provider appears. Send a live recovery email and confirm the 15-minute link works; the sign-in page deliberately returns a generic response when delivery is unavailable.
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

## Node resources

- [ ] Confirm the container runs as its non-root user and the persisted directory is writable only by the intended host/container identity.
- [ ] Confirm the volume contains `gmpay.sqlite`, private objects, and durable queue state after installation and a test upload/order.
- [ ] Configure a supported Node email provider and send a password-recovery test. Confirm the provider list matches Workers and no email secret appears in the container environment.
- [ ] Restart the container and confirm queued Webhook/payment work and scheduled jobs resume without duplicate accounting or delivery.
- [ ] Stop the container, run `bun run data -- backup` to an external location, restore with `bun run data -- restore` into a new data directory, and verify manifest, SQLite integrity, migration checksum, sign-in, and private-object access.
- [ ] When migrating from Workers, run `bun run data -- import-cloudflare` against explicit D1 SQL and optional R2 export paths; import only into a new or empty target, then repeat signed order and callback acceptance tests.

## Automated releases

Semantic-release runs after the quality gate on both release channels. `alpha`
starts at `1.0.0-alpha.1` and publishes only full-version and moving `alpha`
container tags. Once verified and merged, `main` publishes stable `1.0.0` plus
major, minor, and `latest` tags. It updates `package.json` and `bun.lock`, creates
the GitHub Release with generated notes and a tag, then calls the independent
Docker smoke and multi-architecture publish workflow. Native x64 and Arm64
runners build and smoke-test their platform images in parallel before the
workflow assembles the published manifest. After a stable image and its
provenance are published, matching alpha GitHub prereleases, remote Git tags,
and GHCR image versions are deleted automatically.

After the first image publish, a repository owner must open GitHub Package
settings for `gmpay-edge` and set its visibility to **Public** once. The workflow
does not and should not mutate package visibility automatically.

## Release gate

- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] `bun run check`
- [ ] `bun run build`
- [ ] `bun run build:node`
- [ ] Open sign-in and verify an uninitialized deployment redirects to root-user initialization.
- [ ] Create and enable the intended asset, channel, and receiving address; development-only mock channels must never be enabled unintentionally in production.
- [ ] Verify binding-free `GET/HEAD /healthz`, detailed `/status`, root-user initialization, sign-in, and one signed GMPay end-to-end order in the intended channel.
- [ ] Confirm merchant notification targets use public HTTPS, provider/Telegram inbound paths validate their provider-specific signatures, and GMPay/EPay outbound signatures match the documented canonical parameters.
- [ ] Confirm no `.dev.vars`, wallet keys, merchant secrets, or Cloudflare tokens are tracked.
- [ ] Smoke-test the selected production runtime; when releasing, verify the GHCR image digest and both architectures from the GitHub Release.
- [ ] After the first container release, set the GitHub Package visibility to **Public** and verify an unauthenticated pull.
