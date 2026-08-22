# GMPay Edge engineering contract

[简体中文](AGENTS.zh-CN.md) · English

This file contains only stable, submit-ready product and engineering rules. Local
execution plans and evidence remain ignored. A goal must explicitly select its
checklist scope; old or unrelated checklist items never become active implicitly.

## 1. Product boundary

- The product, package, Worker, Bun service, and database are `GMPay Edge` /
  `gmpay-edge`.
- GMPay Edge is a single-deployment, single-tenant payment gateway. A merchant is
  an external API client; internal authorization is user-and-role based.
- Internal operations use `/admin`. GMPay is the primary merchant protocol, and
  EPay is a boundary adapter over the same order service.

## 2. Approved stack and source ownership

- Use Bun, strict TypeScript, React 19, TanStack Start/Router/Query/Table/Form,
  Tailwind CSS 4, shadcn/Radix, Zod, Better Auth, Drizzle, Cloudflare Workers
  (D1, KV, R2, Queues, Cron), Bun with Nitro and SQLite, grammY, Paraglide,
  Vitest, Biome, and Wrangler. Docker is the supported Bun distribution.
- Do not introduce a second router, auth system, ORM/database layer, form system,
  client/server cache, formatter, linter, or i18n runtime.
- Domain and runtime ownership remains centered on `routes`, `features`,
  `integrations`, `components`, `layouts`, `db`, `lib`, `stores`, and `server`.
  Framework support stays in the existing `assets`, `context`, `hooks`,
  `paraglide`, and `styles` directories; do not add another top-level layer for
  ordinary feature code.
- A feature owns its page, schema, server functions, types, and domain behavior.
  Routes stay thin: params/search, loader, authorization, Request/Response
  conversion, and mounting only.
- External payment adapters live in
  `src/integrations/{chains,exchanges,wallets}`. Cross-domain runtime plumbing
  belongs in `src/server`; domain services do not.
- Page forms and tables stay with their semantic page. Shared form/table
  foundations stay in the established `ui`, `pro`, and `crypto-icons`
  boundaries; reusable application shells may remain under `header` and
  `public`. Do not refactor large `ProTable` or `ProForm` foundations without a
  concrete defect.
- Layouts live in
  `src/layouts/{public,auth,install,dashboard,settings,components}`; Drizzle
  schemas live in `src/db/schema/{auth,access,payments,webhooks,telegram,settings}.ts`.
- Tests live under `tests/{unit,integration,security,e2e,fixtures,helpers}`.
  Delivery documentation is maintained as paired English and Simplified Chinese
  files. Ignored local planning and evidence files are not submitted.

## 3. Code quality, simplification, and style

- After non-trivial implementation, refactoring, or performance work, perform a
  behavior-preserving simplification review of the touched diff before final
  validation. Preserve project boundaries; do not broaden scope or format
  unrelated files merely to reduce lines. A verified no-change result is valid.
- Optimize for net simplicity. Delete duplicate branches, boilerplate,
  indirection, dead state, and dead exports before adding an abstraction.
- Default to colocation and apply YAGNI/Rule of Three. Extract stable shared
  semantics only when there are at least two real consumers and a likely third,
  or when a security, transaction, protocol, persistence, or unit boundary needs
  isolated tests.
- Do not create generic `utils`, `services`, `repositories`, `managers`,
  pass-through wrappers, or barrel layers to make code look architectural. A new
  helper must make callers shorter, clearer, and harder to misuse.
- Validate untrusted input once at the boundary with Zod or an equally explicit
  parser. Domain code trusts established types and invariants; do not repeat
  `trim`, parsing, null checks, or speculative defensive branches at every layer.
- Handle only states that can occur and have a defined recovery or failure
  policy. Prefer early returns and direct control flow over deep nesting, boolean
  gymnastics, nested ternaries, or fallback chains for unknown futures.
- Keep strict types. Do not add broad `any`, chained assertions, unparsed KV JSON,
  provider payloads, URL search, Queue envelopes, or float money values to domain
  code. Narrow at the boundary and use explicit unit-bearing names.
- Use structured domain errors and map them at HTTP/API boundaries. Never branch
  on unstable error text or expose SQL, stack traces, secrets, provider-sensitive
  payloads, or internal references.
- Community baselines are TypeScript `strict`, stable Biome recommended rules,
  the Rules of React, and applicable OWASP ASVS/API Security controls. Apply
  stricter rules from measured audits; do not blindly enable unstable rules or
  create large style-only churn.
- Components and Hooks are pure. Side effects stay out of render; props, state,
  hook inputs, and JSX values are immutable. Let React Compiler optimize before
  adding speculative memoization.
- Biome is the only formatter/import organizer. Format touched files only. Follow
  existing kebab-case files, camelCase values/functions, PascalCase components
  and types, stable domain terms, and explicit `Ms`, `Minor`, `Units`, `Bps`, and
  `Bytes` suffixes.
- Comments explain invariants and platform tradeoffs, not syntax. Fix lint/type
  failures at the cause; do not suppress rules or skip tests to manufacture a
  pass.
- Removing code requires proportionate `rg`, typecheck, tests, and production
  build evidence. Delete obsolete routes, tests, dependencies, exports, and
  empty directories together.

## 4. Authentication, RBAC, and authorization caching

- Better Auth owns users, credential accounts, sessions, passwords, and TOTP.
  Project RBAC owns dynamic roles, user-role bindings, permission modules, and
  bit masks.
- Installation creates the protected built-in `root` role for the first user.
  Root cannot be edited or deleted, and the last enabled root cannot be disabled,
  deleted, or stripped of root.
- A newly deployed instance is intentionally initialized by its operator through
  the public installation flow. The installation transaction remains single-use
  and closes the flow once the first root user is committed.
- TOTP is optional. When enabled, Better Auth recovery codes remain the TOTP
  recovery path. Password recovery uses a short-lived, one-time email link,
  returns a generic response, and revokes existing sessions after reset.
- Effective access is the union of all enabled roles. There is no current-role or
  route-driven authorization state.
- Basic bits are `read/create/update/delete = 1/2/4/8`; registered extensions
  start at `16`. Store one integer `permission_mask` per role and module.
- Permission modules and permission bits are separate read-only registries.
  Users configure roles, not code-defined module IDs or bit positions.
- Every server entry validates the Better Auth session, enabled user, and a
  structured `{ module, permissionMask }` requirement. Unknown routes and
  permissions fail closed. Client hiding never replaces server authorization.
- Sidebar, command menu, module navigation, and default routing share one
  permission-filtered authority source.
- Derived RBAC access may be cached only behind an authoritative revision
  returned by the current Better Auth user read. Role/permission mutations bump
  affected user revisions in the same database transaction or batch. Cache
  deletion or TTL alone must never grant or revoke access.
- Corrupt/missing/version-mismatched cache values rebuild from the authoritative
  database; database or parsing failure denies access. Decrypted credentials and
  session tokens never enter RBAC cache keys or values.

## 5. Payment model, units, and state

- “Payment methods” is the built-in chain/exchange/wallet capability catalog; it
  is not an operational enable switch.
- “Connection configuration” stores public RPC/API endpoints, HTTPS/WSS,
  priority, health, and failover. It never stores UID, API key, secret,
  passphrase, merchant ID, private key, or seed phrase.
- Built-in HTTPS connections start enabled for evaluation; WSS starts disabled
  at priority `200`. Chain availability still requires a healthy connection.
  Exchange/wallet public connections do not decide merchant exposure.
- Receiving methods hold concrete read-only account/target configuration, may
  bind multiple assets, and are the operator-controlled checkout exposure.
  Never store withdrawal authority, private keys, or seed phrases.
- Rates are split into crypto and fiat. Persist original and adjusted rates plus
  sync time; USDT/USD and USDC/USD are fixed 1:1 baselines.
- Fiat amounts are decimal integer strings in `*_minor` with currency decimals.
  Asset amounts are decimal integer strings in `*_units` with asset decimals.
  Use `bigint` and centralized conversion; never use floating-point money math.
- Absolute timestamps and durations use milliseconds (`*_at`, `*_ms`), rate
  adjustments use basis points (`*_bps`), and file sizes use bytes (`*_bytes`).
  Conversion occurs only at API, adapter, migration, or UI boundaries.
- Order transitions, payment ingestion, audit entries, and Webhook outbox writes
  are centralized, atomic/idempotent, and cover partial, over, late, duplicate,
  failed, confirmation-changing, reorg, retry, and refund behavior.

## 6. Merchant APIs, Webhooks, and integrations

- GMPay and EPay share one order service, idempotency model, status machine,
  checkout, query, callback, and manual callback retry path.
- Signatures, credential scopes, request parsing, ownership, and rate limits are
  verified at the boundary. Replay protection is required for state-changing or
  external-side-effect operations; protocol-compatible read-only GMPay/EPay
  status queries remain rate-limited without inventing nonce fields. The runtime's
  authoritative database remains the atomic rate limiter; eventually consistent
  caches do not decide security limits.
- Webhook endpoint paths are instance-relative. Deployment hosts belong to
  Allowed Hosts/security settings. Callback destinations originate from merchant
  order input and are validated against SSRF and retry policy.
- Webhook events, deliveries, attempts, Queue messages, locks, and manual retries
  remain idempotent and auditable. A committed outbox event must survive Worker
  response completion and partial provider failure.
- Chain, Binance, OKX, and OKPay adapters use bounded timeouts, typed validation,
  deterministic signing, redacted errors, pagination/cursors, and documented
  read-only credentials. WSS includes bounded lifetime, reconnect/backoff,
  receipt validation, deduplication, and HTTP recovery.

## 7. Telegram

- All Telegram Bot API access uses grammY. Do not concatenate Telegram API URLs
  or maintain a second client.
- Commands are an instance-wide public catalog without `bot_id` and use
  `command + scope`. Commands and notification subscriptions own their six-locale
  template content directly; there is no standalone message-template catalog.
- Bots own token, username, Webhook secret, enabled state, and Telegram
  connectivity. Notification subscriptions retain their real Bot.
- `/start` idempotently creates a disabled private subscription for administrator
  review. Its single enabled state controls notifications and Telegram order use.
- Install/reconcile creates four commands with six-locale replies and Telegram
  notification defaults without creating a Bot or calling Telegram.
  Reconcile only fills missing defaults and preserves administrator edits.
- Template fallback is selected locale, `en-US`, then a safe built-in format.
  Templates use Markdown and documented non-secret variables only.
- Command synchronization can target one or all Bots and reports each result;
  one failure never hides other Bot outcomes.

## 8. UI, navigation, and internationalization

- Public, auth, install, admin, and checkout surfaces share site name/logo,
  design tokens, light/dark behavior, responsive layout, and accessible controls.
- Main navigation expresses stable domains; semantic subroutes use the shared
  module layout. Do not simulate subroutes with query parameters.
- Navigation ID, localized title, URL, icon, permission, selection, and default
  child come from one authority used by sidebar, command menu, and module nav.
- ProTable handles admin lists and its built-in refresh. Pro form components
  handle forms. Do not add duplicate refresh controls or detach forms/tables from
  their page without a real reuse boundary.
- All user-facing text uses Paraglide and supports `en-US`, `ja-JP`, `ko-KR`,
  `ru-RU`, `zh-TW`, and `zh-CN`. Dates, amounts, status, events, units, and names
  are localized explicitly.
- `localeLabels` is a fixed native-name identifier map and is neither translated
  nor rendered with flags.
- Keyboard access, accessible names, focus restoration, reduced motion, mobile
  behavior, and parent/child route selection are required in both themes.

## 9. Runtimes, performance, and security

- Workers and the Bun/Nitro service run the same full stack behind explicit
  runtime adapters. Workers use D1, KV, R2, Queues, and Cron. Bun uses SQLite as
  authoritative data plus local cache/object storage, durable SQLite queues, and
  an in-process scheduler under one `GMPAY_DATA_DIR`.
- Existing Workers commands and the Cloudflare Vite adapter remain unchanged:
  `bun run build`, `bun run predeploy`, and `bun run deploy` are Workers-only.
  Bun uses the separate `bun run build:bun` build and is distributed as one
  multi-architecture Docker image through GitHub Container Registry.
- Treat KV as eventually consistent. Use immutable versioned keys, bounded TTL,
  cache-stampede control, validated payloads, and D1 fallback. Do not store
  decrypted secrets or use KV for atomic authorization or money state.
- Use D1 batches and evidence-backed indexes. Respect the per-invocation D1
  concurrency limit, verify indexes with `EXPLAIN QUERY PLAN`/rows read, and run
  `PRAGMA optimize` after index changes. Bound pagination, exports, Cron, and Queue
  work.
- Configure TanStack Query freshness by data volatility. Preserve Router's
  external-cache integration, avoid hydration refetch storms and broad query
  invalidation, and poll only visible/online live pages.
- Heavy Scalar/editor/chart/provider code loads only from its semantic route or
  event. Verify automatic route/CSS splitting before adding manual chunks.
- Instrument privacy-safe timing, D1 rows, KV hit/miss, Queue age/retry, provider
  latency, bundle size, and cold/warm behavior. Optimize only from before/after
  evidence; do not present local timing as production latency.
- CSRF, trusted Origin/Host, secure headers, rate limits, audit logging, SSRF
  protection, secret redaction, optional administrator TOTP, and recovery-code
  acknowledgement/copy/download when TOTP is enabled are mandatory.
- Runtime secrets are initialized during installation and stored according to
  the current product settings contract. Never commit real secrets, `.dev.vars`,
  Bot tokens, private keys, seed phrases, exchange secrets, or Cloudflare tokens.
- The public Bun/Docker environment contract contains only `GMPAY_DATA_DIR`.
  Origin, Allowed Hosts, email channels, and other product settings are confirmed
  during `/install` or maintained in authenticated administration. Ordered email
  channels support provider fallback. Bun and Workers expose the same provider
  types; Cloudflare Email delivers only when the `EMAIL` binding is available.
  SMTP rejects port 25 and non-public hosts and validates TLS certificates.
- Bun backups, restores, and Cloudflare-to-Bun imports must use the maintained
  package scripts, validate manifests/checksums, and refuse destructive overwrite.

## 10. Evidence and delivery

- Read the explicitly selected ignored local checklist before changes and select
  only the active goal items. Preserve unrelated user changes and record concrete
  files, tests, commands, query plans, runtime output, or browser evidence.
- Mocks and deterministic fixtures prove logic, not live provider readiness.
  Real chain, exchange, wallet, Telegram, and merchant Webhook smoke suites are
  retained as manual assets but remain unconditionally skipped; credentials or
  environment variables must not enable them or block the automated delivery.
- Vite/Paraglide owns message generation. Do not regenerate Drizzle migrations
  on every normal dev start when schema is unchanged.
- During active development, run focused tests and checks for the changed
  contract. Do not repeatedly run the full quality gate while executable TODOs
  remain. After all locally executable TODOs are complete, run once on the same
  final current tree:

```bash
bun run typecheck
bun run test
bun run check
bun run build
bun run build:bun
```

- Completion additionally requires current browser/runtime evidence, migration
  evidence, permission-path coverage, and documentation. A partial gate, old
  result, or skipped live platform suite is not completion evidence.
- Releases use semantic-release. `alpha` starts with `1.0.0-alpha.1` and only
  updates full-version and `alpha` container tags; verified changes merge to
  `main` for stable `1.0.0` and major, minor, and `latest` tags. A release updates
  `package.json` and `bun.lock`, creates the GitHub Release with generated notes
  and a tag, then calls the Docker workflow for `linux/amd64` and `linux/arm64`.
  Native x64 and Arm64 runners build and smoke-test their platform images in
  parallel before the workflow publishes the combined manifest and provenance.
  After a stable publish, the workflow removes matching alpha prereleases, Git
  tags, and GHCR versions.
  Package visibility is set to public once by a repository owner after the first
  publish, not mutated by workflow.
