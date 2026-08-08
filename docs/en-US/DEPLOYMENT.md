# GMPay Edge deployment checklist

[简体中文](../zh-CN/DEPLOYMENT.md) · English

This checklist deploys one single-tenant GMPay Edge instance. Operators use
`/admin`; merchants integrate only through the signed GMPay protocol or its
EPay boundary adapter.

## Deployment paths

### Deploy button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/GMWalletApp/gmpay-edge)

The guided flow forks the repository and configures Workers Builds. The source
repository must be public when the button is used. Configure `bun run build` as
the Build command and `wrangler deploy` as the Deploy command. The build command
creates or reuses the named D1, R2, and Queue resources, applies the D1 baseline,
and then compiles the Vite artifact. Cloudflare links the ID-free bindings from
`wrangler.jsonc` during deployment; the source configuration is never rewritten.
When deployment finishes, open `/install` on the Worker URL.

### Wrangler CLI

Authenticate Wrangler and run the package deployment command. Its `predeploy`
hook creates or reuses the named D1, R2, and Queue resources, applies the D1
baseline through `DB`, and builds the Vite artifact before publication:

```bash
bun install
bunx wrangler login
bun run deploy
```

If necessary, prepare D1 manually with `bunx wrangler d1 create gmpay-edge`
and then `bun run db:migrate:remote`. Keep the generated database ID out of the
portable source configuration.

## Cloudflare resources

- [ ] To enable password recovery, onboard the sender domain in Cloudflare Email Service, add a `send_email` binding named `AUTH_EMAIL` to the deployed Worker, and save that sender address under **Admin → System settings → Authentication**. The sign-in page deliberately returns a generic response while this optional binding is absent.
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
- [ ] Complete `/install`; it generates authentication/signing values and payment defaults, stores the current Origin as the application URL and an Allowed Host, and signs the root user in automatically.
- [ ] Open **Forgot password**, receive the 15-minute one-time link, reset the password, and confirm previous sessions no longer authenticate.
- [ ] Review **Admin → System settings → Authentication** and **Secret management**; verify the production HTTPS origin and back up `runtime.better_auth_secret` with D1.
- [ ] Configure each intended provider according to [PAYMENT_METHODS.md](PAYMENT_METHODS.md); use read-only exchange credentials and verify token identifiers and decimals.
- [ ] Configure crypto and fiat rate sync settings; use **Run now** in each settings dialog once, verify raw/final observations, then confirm the one-minute Cron respects each category's automatic-sync switch and saved interval.

## Release gate

- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] `bun run check`
- [ ] `bun run build`
- [ ] Open sign-in and verify an uninitialized deployment redirects to root-user initialization.
- [ ] Create and enable the intended asset, channel, and receiving address; development-only mock channels must never be enabled unintentionally in production.
- [ ] Verify binding-free `GET/HEAD /healthz`, detailed `/status`, root-user initialization, sign-in, and one signed GMPay end-to-end order in the intended channel.
- [ ] Confirm merchant notification targets use public HTTPS, provider/Telegram inbound paths validate their provider-specific signatures, and GMPay/EPay outbound signatures match the documented canonical parameters.
- [ ] Confirm no `.dev.vars`, wallet keys, merchant secrets, or Cloudflare tokens are tracked.
