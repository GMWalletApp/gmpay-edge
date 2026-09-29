# Security notes

[简体中文](../zh-CN/SECURITY.md) · English

## Accounts and permissions

- Public email registration is disabled. A newly deployed instance intentionally
  exposes `/install` so its operator can atomically create the first protected
  `root` user; the flow closes once that user is committed, and all later
  accounts are created from the authenticated user-management screen by an actor
  with the required dynamic RBAC permission. Direct requests to Better Auth's
  email sign-up endpoint are rejected and create no user or credential account.
- Better Auth owns passwords and sessions. Passwords are length-validated but
  never trimmed or otherwise normalized before hashing. Root-user initialization
  is atomic under concurrent requests; ordinary user/credential creation and
  password-update/session-revocation pairs also commit through D1 atomic batches.
  Disabled users cannot create sessions, every disable path revokes existing
  sessions, and re-enabling clears the disable timestamp. Historical audit actors
  and settings editors become `NULL` when a user is deleted, preserving the
  records without dangling foreign keys.
- Sign-in, password-reset requests, and password-reset completion are rate
  limited in the authoritative D1 counter table shared by every instance:
  sign-in allows 5 attempts per minute per client address and 30 per 15 minutes
  per account, reset requests 3 per minute per address, and reset completion 5
  per minute per address. Better Auth's in-memory limiter remains a best-effort
  first layer per isolate. Host, origin, CSRF, and Better Auth trusted-origin
  checks share the validated `security.allowed_hosts` list; non-local hosts
  become HTTPS origins, and localhost loopback entries use HTTP for development.
- Effective access is the union of all enabled roles. Each role-module row stores
  one validated `permission_mask`; module and action registries are code-owned,
  and malformed modules or unknown bits fail closed. Custom roles can be
  disabled without deleting their assignments: server authorization joins only
  enabled roles on every request, so disabling removes effective permissions
  immediately and re-enabling restores the existing bindings. The built-in
  `root` role cannot be edited, deleted, or disabled.
- Editing, disabling, re-enabling, or deleting a root user requires a currently
  enabled root actor, checked inside the same batch as the user, credential, and
  session writes; a concurrent root-role assignment cannot bypass it. Conditional
  D1 mutations prevent concurrent user-disable, user-delete, or role-removal
  requests from eliminating the last enabled `root`.
- A custom role is deleted only while it has no members. The membership check
  runs inside the `DELETE` statement, so a concurrent binding is never cascaded
  away, and the audit row commits in the same batch or not at all.
- `roles:update` and `users:update` are administrator-equivalent grants: a holder
  can widen the custom roles they belong to and assign any non-root role, so
  treat them as full administration rather than delegated operations.
  `settings:read` reveals only whether a runtime secret is configured.
- User and custom-role creation, updates, enable changes, deletion,
  password-change indicators, and role assignments record the authenticated
  actor, request ID, source IP, target, and a sanitized change summary in the
  same batch as the change. Password values and hashes are never written to
  audit metadata.
- TOTP is optional. Setup remains unverified until the first valid authenticator
  code, so an abandoned QR setup cannot lock the user out. Backup codes are
  one-time, disabling TOTP requires the current password, trusted-device cookies
  are signed and bounded to 30 days, and repeated failed challenges trigger the
  15-minute account lockout.
- Password recovery uses Better Auth's one-time 15-minute email link, returns
  the same response for existing and unknown addresses, revokes every existing
  session after reset, and records the completed reset without storing the token
  or password.

## Secrets and sensitive configuration

- API credential Secrets, payment-provider credentials, Telegram Bot Tokens, and
  email channel credentials are encrypted with AES-GCM before storage and never
  returned by list APIs; an API Secret is shown once at creation or rotation.
  Payment connection API keys are stored in the separate encrypted
  `payment_ingress_credentials` table; legacy plaintext values migrate and clear
  on first use. Settings lists return only a configured flag for `runtime.*`
  secrets and email channel lists only whether a credential is stored; an empty
  update preserves the existing value, so secret values are write-only.
- Runtime signing values are generated during installation with a CSPRNG and
  managed in the admin console. The API-credential pepper and the integration
  secret cannot be replaced while any ciphertext encrypted under them exists
  (API credentials, connection credentials, receiving-method configuration,
  Telegram bots, or email channels); the request fails with
  `runtime_secret_in_use`, and those rows must be removed first because there is
  no re-encryption job. The Better Auth secret has no stored ciphertext and may
  be rotated at any time; changing it invalidates existing authentication
  material, so back it up with the database.
- The master secrets live in the same database as the ciphertext they protect.
  Encryption at rest therefore defends against partial disclosure—an exported
  table, a log line, a screenshot—not against a copy of the whole database. A
  Bun backup contains those secrets in plaintext; treat backups as full
  credential material as described in
  [Bun data operations](./NODE_DATA_OPERATIONS.md).
- API credentials use a numeric PID. Rotation updates the same credential row in
  place, preserves its PID, records actor/request/IP metadata without the
  Secret, and makes all later GMPay/EPay deliveries—including retries already
  queued by identifier—resolve the new Secret from D1. No retired credential row
  is retained, and GMPay/EPay callbacks resolve the current Secret by order
  identity; there is no second callback-secret store.
- Credentialed exchange and wallet calls are pinned to their built-in official
  origins. Configurable chain endpoints must be public HTTPS/WSS without user
  information and reject private, reserved, and link-local addresses.
- Audit metadata is recursively redacted when written and sanitized again when
  listed or exported; malformed payloads are never echoed verbatim.
- No receiving method or the simulator requires a private key or mnemonic, and
  exchange credentials must be read-only without withdrawal permission. Live
  provider credentials never enter source control; `.dev.vars` and `.env` files
  are ignored by Git.

## Merchant API and amounts

- Monetary values cross boundaries as decimal strings and are converted to
  integer minor units or asset units represented by `bigint` before arithmetic.
- GMPay requests require an enabled PID credential, a valid sorted-parameter
  HMAC-SHA256 signature, the exact scope, and a rate-limit check. The EPay
  compatibility boundary retains its legacy MD5 signature. D1 is the only
  rate-window counter; no eventually consistent cache decides a limit.
- Merchant authentication verifies the signature and required scope before
  incrementing the credential's D1 rate window, so invalid signatures consume no
  success quota. Failed authentications are counted per submitted PID in a
  separate D1 bucket: after 20 failures within a minute the endpoint answers
  `429` until the window passes, and every failure is logged as
  `merchant_auth_failed` with only the PID and request ID.
- API credentials use explicit scopes: `orders:create`, `orders:read`,
  `orders:update`, and `assets:read`. Unknown or aggregate scopes are rejected,
  and revocation is a one-way, first-writer-wins transition committed with its
  audit in one batch.
- Request validation happens once at the boundary and maps to stable codes:
  `currency` must be an active ISO 4217 fiat code, `amount` a positive decimal
  with at most 18 integer and 8 fraction digits, `notify_url` a public HTTPS
  endpoint, `redirect_url` HTTPS, and `token` and `network` appear together.
  Bodies above 64 KiB answer `413`. Validation failures are 400-class
  responses, never a `500`.
- D1 uniqueness constraints enforce credential PIDs, external order IDs within
  their API-credential scope, uncredentialed internal external-order IDs,
  user-role bindings, transaction events, Webhook events, and deliveries. An
  external order ID is unique within the creating API credential, preventing
  replay without coupling independent credentials.
- A hosted-provider order (OKPay) that the provider fails to create is rolled
  back together with the merchant order created by the same request, so the
  external order ID can be retried; the merchant receives
  `provider_unavailable` (`10003`).

## Webhooks, URLs, and Queues

- Merchant `notify_url` values require public HTTPS and reject local/private
  literals and embedded credentials before they are snapshotted with the order.
  The blocklist covers trailing-dot hostnames, IPv4-mapped and -compatible IPv6,
  6to4, NAT64, and Teredo ranges. Delivery rechecks resolved A/AAAA addresses,
  fails closed on private/reserved or mixed answers, does not follow redirects,
  streams at most 512 response bytes, and never logs signing material. On Bun
  the DNS pre-check uses DNS-over-HTTPS while `fetch` resolves again through the
  system resolver, leaving a narrow rebinding window; block private egress at
  the network layer when that residual matters.
- Every inbound provider endpoint claims a D1 fixed-window budget of 600
  requests per minute per endpoint and client address before reading the body,
  decrypting a credential, or writing a receipt; excess requests receive `429`
  without a receipt. Unauthenticated rejections are recorded only for the first
  20 requests of a client window. Bodies have streaming byte limits, every
  attempt receives a new server receipt ID, and a provider-supplied
  `X-Request-ID` is kept only after validation as non-unique metadata. The
  OKPay endpoint answers an unknown order exactly like a bad signature.
- The Telegram Webhook applies its own limits (600 updates per Bot and 1 800
  requests per client address per minute, 256 KiB bodies) and answers `200` to
  permanent Telegram API `4xx` rejections so a blocked chat cannot stall
  delivery; see [Telegram](./TELEGRAM.md#webhook-processing-policy).
- Queue and DLQ messages use explicit allowlisted `kind`/`version` envelopes and
  contain only delivery/event identifiers. Consumers validate the complete
  envelope before dispatch; unknown, malformed, or unsupported messages are
  audited without their body or credentials and acknowledged only after that
  audit succeeds, so poison messages neither loop nor disappear.
- The D1 attempt counter is authoritative and each failed application attempt
  schedules a fresh delayed Queue message, so the configurable application
  maximum is independent of a single Cloudflare message's retry limit.
  Cron-driven outbox recovery re-enqueues initial queued deliveries, due failed
  deliveries, and deliveries stranded in `delivering` after their lease expired.
  Manual retry continues the attempt numbering and answers `409`
  (`webhook_delivery_retry_in_progress`) while an attempt is scheduled or
  leased.
- Each order owns its immutable notification target and creating API credential
  identity. Explicit notification resend creates a new event/delivery history
  row without creating a mutable global destination or broadcasting across
  orders. The callback formats carry no signed timestamp or nonce (protocol
  compatibility), so receivers must deduplicate by order identity and status.
- Every JSON API success and error response sets `Cache-Control: no-store` and
  carries an `X-Request-ID`, preventing order, credential-state, validation, or
  infrastructure responses from being retained by browsers or intermediary
  caches.

## Payments and checkout

- Payment accounting, order transition, Webhook event creation, and delivery
  outbox insertion commit together and are idempotent. Confirmation growth on an
  already confirmed payment is a duplicate observation: it refreshes the stored
  confirmations, never emits another order event, and never rewrites `paid_at`.
- Late payments follow the configured `accept`, `review`, or `reject` policy.
  Review payments are stored as `pending_review`, remain outside the order
  balance until an authorized administrator explicitly accepts them, and every
  decision is audited. An order already covered by payments (`confirming`) is
  never expired, and confirmation updates of an attributed payment bypass the
  late-payment policy.
- Payment review approval, payment accounting, approval audit, and notification
  outbox commit together. A concurrent rejection rolls back the approval's
  payment writes; failed verification or persistence leaves the review pending
  for retry.
- Administrator cancellation/refund commits the order, audit, and durable outbox
  atomically; Queue dispatch is post-commit and recoverable from the outbox.
  Cancellation is recoverably idempotent: the guarded state transition,
  receiving-target release, and attributed audit record commit in one D1 batch,
  a failed optimistic update writes none of them, and retrying an
  already-cancelled order persists any missing Webhook event without a second
  transition or audit entry.
- Payment scans use the order snapshot's asset and target, with a cache keyed by
  receiving method, asset, and target; connection failover never changes the
  asset. Only network, authentication, rate-limit, and invalid-response faults
  change a connection's health. TRC20 transfers are accepted only from the
  seeded token contract, TON execution success is read from toncenter's own
  fields, every history walk is bounded below by the order's creation time, and
  a transfer that cannot be attributed to one shared-address order is written to
  the audit log as `payment.scan_unattributed` instead of being dropped.
- Adapter responses are read with bounded timeouts and an 8 MiB body cap before
  parsing, and provider payloads are validated with typed schemas at the
  boundary. Binance and OKX public exchange-rate polling requires no private
  credential, and a stale observation past its `expires_at` is never used for a
  new order.
- Checkout can change an asset/network only while the order is pending,
  unexpired, has no attributed payment or pending payer review, and has no
  active hosted-provider order. The D1 update is guarded by the order version
  and target-address availability; address reservation, old-address release,
  and audit rows are tied to the successful new version, so concurrent orders
  cannot acquire the same final address, and a version conflict is reported as
  `order_conflict` rather than retried as an amount collision.
- Payer-submitted transaction identifiers (**Paid but not confirmed?**) are
  limited to 5 per order and client address per minute in D1. The server loads
  the transaction from the configured adapter and verifies the order's target,
  network, and asset before the normal idempotent accounting path runs.
- Payment-review uploads require an exact same-origin `Origin` header and are
  limited to 3 per order and client address per hour in D1. The server ignores
  the browser MIME claim, recognizes bounded JPEG/PNG/WebP bytes, validates
  basic image structure and dimensions, rejects files above 5 MiB, and records a
  SHA-256 digest.
- Review evidence uses private R2 object keys. Only an enabled user with
  `payment_reviews:read` can access the evidence route; unauthenticated and
  unauthorized requests receive `401`/`403`, and successful responses carry
  `private, no-store`, `nosniff`, and a sandboxed CSP. Approval requires the
  configured payment adapter to retrieve and match a transaction; screenshots
  never authorize a direct order-status override.
- Review descriptions and evidence can contain personal information. Restrict
  `payment_reviews:read`, define a deployment-specific R2 lifecycle retention
  policy, and remove retained objects when decommissioning the instance.

## Telegram

- Telegram Bot Tokens can be rotated without deleting subscriptions. A
  replacement is verified through `getMe`; enabled bots receive the existing
  secret-token Webhook on the new credential before D1 changes atomically, and
  the old credential's Webhook is removed afterward. If Telegram cannot clean up
  the old Webhook, the admin UI reports the partial cleanup and operators must
  revoke the old token with BotFather. Tokens are never returned by list APIs or
  written to audit metadata.
- Creating an enabled Telegram Bot verifies `getMe` and registers its
  secret-token Webhook before the Bot and audit row commit atomically. Telegram
  rejection leaves no hidden D1 record; if the D1 commit fails after
  registration, GMPay Edge compensates by deleting the new external Webhook.
  Enable and disable requests are idempotent, and a failed commit after a
  Webhook change restores the previous external state.
- `/start` creates a disabled private subscription for the numeric sender ID.
  Telegram order search, Inline quotes, Inline creation, callbacks, and **I have
  paid** checks authorize the sender against an enabled private subscription for
  the selected Bot; a group or channel Chat ID never grants private order access,
  and an unbound user receives a single "not bound" Inline result. Payment-check
  callbacks use the Telegram update ID as a D1 idempotency key before enqueueing
  a provider scan, so retries cannot amplify queue work. The button is only a
  scan request and never marks an order paid.
- Amount-only Inline queries expose only enabled and ready receiving methods
  with a usable current quote. The selected method is encoded in the chosen
  result, validated again by the normal order service, and is not locked until
  Telegram sends `chosen_inline_result`. Forged or stale option IDs fail closed.
- Notifications are dispatched after the order event commits and outside the
  request path, honor Telegram flood control, and automatically disable a
  private subscription that blocked the Bot. Telegram API outcomes reach
  administrators only as stable error codes. An enabled private subscription is
  an operator trust decision in this single-tenant deployment: that user can
  look up any order of the instance.

## Runtime, network, and responses

- Responses apply HSTS on HTTPS, frame denial, MIME sniffing protection, a
  strict referrer policy, a restrictive Permissions Policy, same-origin resource
  policy, and a Content Security Policy. Allowed Hosts, Origin/CSRF validation,
  and the login and API rate limits are mandatory in production.
- On Cloudflare Workers the client address is the platform-set
  `cf-connecting-ip`. On Bun the only authoritative fact is the TCP peer:
  forwarded headers are honored only when the peer is a loopback, private, or
  link-local address, the right-most `X-Forwarded-For` hop becomes the client
  address, `X-Forwarded-Proto: https` marks the request as HTTPS (enabling HSTS
  and secure cookies), and any inbound `cf-connecting-ip` is replaced. Public
  peers count as the client and their forwarded headers are discarded, so
  per-address rate limits and audit records cannot be spoofed. The proxy
  contract is described in the
  [deployment guide](./DEPLOYMENT.md#reverse-proxy-and-tls).
- SMTP channels reject port 25 and non-public hosts, always validate TLS
  certificates, connect with implicit TLS on port 465, and on any other port
  first probe `EHLO` and refuse delivery unless `STARTTLS` is advertised, so
  credentials and messages never travel in plaintext. Test emails require
  `settings:update`, are audited, and are limited to 5 per user per hour.
- The public `/status` and `/assets` loaders serve a 10-second per-isolate
  snapshot so anonymous bursts share one query round.
- Two third-party assets are loaded from `cdn.jsdmirror.com`: the Scalar API
  reference on `/docs` (pinned version, `sha384` Subresource Integrity, and a
  route-specific CSP `script-src` allowlist) and the crypto icon set (images,
  with jsDelivr and GitHub fallbacks). This is a supply-chain trust point.
  Deployments that cannot accept it should self-host both assets from their own
  origin and remove the CDN from the CSP.
- The Bun durable queue mirrors Cloudflare's delivery budget (one delivery plus
  the configured retries), leases messages long enough for the slowest handler,
  and purges dead-lettered rows after seven days from an idle poll.

## Operations, audit, and migrations

- Manual operations tasks require `operations:update` independently from the
  read-only health dashboard. Operators run exactly one bounded task—order
  expiration, Webhook outbox recovery, RPC health refresh, or exchange-rate
  synchronization—per request. Successful results are attributed to
  actor/request/IP; failures store only a stable error code and never the
  underlying provider response or exception text.
- Request IDs written to audit rows and echoed in `X-Request-ID` must match
  `^[A-Za-z0-9._:-]{1,128}$`; a missing or invalid client value is replaced by
  a server-generated UUID.
- Retention cleanup runs on every maintenance tick in bounded chunks (250 rows
  per statement, at most 2,000 rows or two seconds per tick) and continues on
  the next tick while expired rows remain, so a steady stream of deliveries,
  receipts, and task runs never outgrows the cleanup.
- Provider-event migration `0007_sparkling_wallflower.sql` adds a nullable lease
  token without rewriting existing rows. A claim lasts five minutes (eight
  bounded 30-second EVM lookups plus headroom). Token and expiry checks fence
  accounting, completion, failure, and source-health updates; recovery
  invalidates old owners, and old processing rows remain recoverable after their
  existing lease expires.
- Migration `0009_audit_hardening.sql` widens the outbox partial index to
  `delivering` deliveries, adds order-scoped indexes for deliveries, events, and
  receiving-method locks, moves late payments that were awaiting review under
  the old `detected` status to `pending_review`, and removes the unused
  `runtime.retention_schedule` setting. Apply the normal D1 migrations before
  deploying the Worker; Bun applies migrations on startup.
