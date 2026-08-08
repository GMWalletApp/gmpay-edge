# Payment methods and receiving methods

[简体中文](../zh-CN/PAYMENT_METHODS.md) · English

## Model

GMPay Edge uses five payment layers:

1. **Rail** — a chain network, exchange, or digital wallet.
2. **Asset** — a currency with decimals and its chain identifier.
3. **Payment access** — HTTPS RPC, WSS, provider API, or inbound provider
   Webhook ingress.
4. **Payment method** — a built-in supported rail and asset combination.
5. **Receiving method** — the operator's checkout target, read-only account
   credentials, asset selection, and limits.

Payment methods are capability records and do not have an operational enable
switch. Checkout exposure comes from enabled, validated receiving methods.
Chain RPC API keys belong to payment access; exchange UID/API
credentials and OKPay Shop ID belong to a receiving method. Built-in exchange
and wallet public connections start enabled and cannot be disabled. They do not
control checkout exposure and do not have chain-node health state.

Fiat amounts use integer minor units, asset amounts use integer unit strings
with explicit decimals, and internal durations use milliseconds. JavaScript
floating-point money arithmetic is prohibited.

Receiving-method minimum and maximum order limits use one fixed currency: USD.
They are stored on the receiving method as USD minor-unit strings and shared by
all assets attached to that method. Orders in another fiat currency are converted
to USD with the current persisted rate before checkout exposure and allocation;
provider- or chain-specific transfer minimums remain adapter validations.

## Scan completeness and provider limits

Production scanners do not assume that one provider response contains every payment. TRON follows TronGrid `meta.fingerprint` cursors, TON Center v3 uses `limit`/`offset`, Aptos Indexer uses GraphQL offsets, Solana follows `getSignaturesForAddress.before`, and OKX Funding Bills follows the official `after=billId` cursor. Binance Pay has no page cursor, so a full 100-row response causes deterministic time-window bisection until every sub-window is complete. EVM ERC-20 log ranges are split into contiguous provider-safe block windows. Every paginated adapter has a bounded request guard and fails visibly instead of silently accepting a truncated result or looping on a repeated cursor.

The scheduled dispatcher orders active payments by `last_payment_scan_at`; it advances that value only after Cloudflare Queues accepts the complete batch. This rotates fairly through more active orders than the configured batch size and retries the same orders if enqueueing fails. Each order also stores a monotonic provider cursor after a complete successful scan. Empty or failed scans do not advance it, and previously detected unconfirmed transactions are refreshed by hash so confirmation and reorganization checks continue after the address cursor moves forward.

Paid and overpaid orders remain in the scan rotation for the configured `payments.reorg_monitor_ms` window (86,400,000 milliseconds, or 24 hours, by default). Confirmed transaction events are refreshed during this period. A first provider miss marks the chain event as `missing` without changing the order; recovery is silent, while a second consecutive miss records a reorganization and atomically removes the payment from the order aggregate.

### Bounded I/O and retry budget

Every adapter operation has one shared deadline: 8,000 ms by default and at most
30,000 ms. Pagination, clock synchronization, a timestamp retry, transaction
enrichment, and direct-lookup stages do not reset it. One payment method exposes
at most eight enabled connections to a scan, ordered by health, priority, and ID;
failover is sequential rather than speculative.

The default hard request-count bounds per adapter operation are:

| Adapter | Default maximum physical requests | Internal retry/concurrency |
| --- | ---: | --- |
| TRON scan | 1,051 | 50 pages, 1,000 rows, at most 3 block requests concurrently |
| EVM token/native scan | 1,004 / 4,001 | 3,000-block lookback, at most 1,000 matching events; sequential ranges |
| EVM direct lookup | 4 | Three initial reads in parallel, one block read, all under one deadline |
| TON / Aptos scan | 50 | Sequential pages, no adapter retry |
| Solana token/native scan | 1,801 / 1,050 | At most 16 token accounts and 1,000 signatures; sequential RPC |
| Binance Pay history | 102 | 100 split windows plus at most one clock read and one timestamp retry |
| OKX funding scan / direct lookup | 52 / 1,602 | 50 pages; direct lookup has at most 32 assets; one clock retry total |
| OKPay create/query | 1 | No adapter retry |

These are request ceilings, not expected request counts; the shared deadline
normally terminates slow scans much earlier. The Payment Queue allows two
concurrent consumer invocations and two concurrent payment messages per
invocation, so at most four orders execute provider operations concurrently.
Within that bound, TRON can issue at most 12 block-enrichment requests and an EVM
scan can have at most eight HTTP/WSS operations in flight; the other adapters are
sequential per order. A payment message has one initial delivery plus at most five
platform retries before DLQ. Adapters do not retry transient failures themselves;
Binance and OKX only repeat one signed request after a timestamp error, under the
same deadline. This prevents adapter, failover, and Queue retry loops from becoming
unbounded multipliers.

## Common workflow

A fresh installation creates every implemented rail/provider, the built-in asset
catalog, payment methods, connection templates, common local
exchange-rate records, and rate-sync settings. It does not invent receiving
addresses or provider accounts; operators create receiving methods explicitly.

1. Review the seeded asset and token contract.
2. Review the matching connection configuration and its RPC or provider API address.
3. Create a receiving method. Enter the chain address, or the exchange/wallet account identifier plus its read-only credentials.
4. Test and enable chain connection configurations as needed. Exchange and wallet public connections remain enabled; provider tests use the encrypted credentials from the receiving method without exposing them in the connections table.
5. Enable the receiving method. The server refuses enablement until the target and provider identity validate and an enabled connection configuration has passed its health check.
6. Check the public status and assets pages, create a small order, and verify detection plus Webhook delivery.

Each receiving method has one enable switch. Disabling the final ready method
immediately removes that asset/network from the public payment catalog while
leaving the system payment method intact. Re-enabling revalidates the stored target
through the current adapter. Active orders keep an immutable payment snapshot;
changing or disabling the method cannot rewrite historical payment details.

## Alchemy inbound notification

Alchemy Address Activity can reduce detection delay for Ethereum, Base, BNB
Smart Chain, and Polygon. It is an optional trigger path, not an accounting
authority: GMPay Edge persists the signed notification in D1, queues only its
internal event ID, then reloads the transaction through the configured EVM RPC
adapter. Network, contract, destination, event index, amount, confirmations,
success, and canonical block state all come from that authoritative lookup
before the normal atomic payment processor runs. Scheduled payment scans remain
the recovery path when Alchemy, Queue delivery, or RPC indexing is delayed.

Configure one dedicated Alchemy webhook per network:

1. Open **Admin → Payment Settings → Payment access** and select **New push**.
   The form generates the final callback URL before anything is saved; copy it.
2. In Alchemy, create a dedicated Address Activity webhook for the matching
   network using that URL. Do not share this webhook with another application:
   reconciliation treats GMPay Edge as the sole owner and removes remote
   addresses that are not enabled receiving targets or retained order locks.
3. Enter Alchemy's Webhook ID, signing key, and Auth Token. GMPay Edge derives
   the official mainnet identifier from the selected internal network. Secrets
   are encrypted at rest and are never returned by list APIs.
4. Save in the default **Shadow** mode, enable the access method, and run **Reconcile
   addresses**. Healthy means the remote webhook exists and its type, network,
   callback URL, active state, and managed addresses all match the local source.
5. Exercise duplicate, delayed, partial, overpayment, and reorganization cases
   with low-value funds. Shadow events perform the complete signed-ingress and
   RPC verification path but do not mutate money state. Switch to **Active**
   only after comparing the results with normal scans.

Incoming signatures are calculated over the exact raw request body. A signing
key rotation automatically retains the old key as the previous verification key;
clear it after Alchemy has completed the cutover. The Auth Token is used only by
the bounded address-management API. Valid deliveries are additionally limited
per source in authoritative D1 to 600 per minute, 2 MiB per raw request, and
2,000 activities per delivery. An access method manages at most 2,000 addresses. When a
remote address list exceeds the bounded paginated read, reconciliation replaces
it with the complete authoritative local list. Disabling the access method schedules
removal of its managed addresses; the signed endpoint returns success without
accepting events while disabled. A signed Alchemy provider-error notification is
acknowledged without creating payment events and degrades source health for
operator review.

Provider event deliveries are unique by source, provider event ID, and activity
index. A committed D1 event survives Worker response completion and Queue
failure; scheduled maintenance recovers due rows and expired processing leases.
Concurrent orders sharing a receiving address are resolved by an existing
transaction owner or a unique exact remaining amount. Ambiguous transfers are
retained for operations instead of being guessed into an order. **Admin →
Webhooks → Inbound records → Payment events** lists verification status, attempts, and redacted
error codes. Operators with `webhooks:update` may manually requeue only failed,
dead, ambiguous, or explicitly recoverable ignored events; successful and
in-flight events cannot be replayed from the UI.

## Local exchange rates

Exchange-rate rows in D1 are authoritative for order quotes. USD, USDT, and
USDC use built-in 1:1 parity and are not stored as redundant snapshots. Crypto
asset rates store asset/USDT observations; fiat rates store USD/fiat
observations.

Each rate page has its own sync settings. Crypto settings select Binance or OKX
and an automatic interval. Fiat settings select a provider (currently
`exchangerate.host`), its API Key, an automatic interval, and an adjustment in
basis points. Each category has an independent automatic-sync switch. The
one-minute Cron skips disabled categories and otherwise executes only when the
saved interval is due. **Run now** first saves the current settings and then
bypasses both the automatic-sync switch and due-time check.

A fresh database seeds the pairs that can be synchronized, not a fabricated
zero quote. Before the first successful observation, `raw_rate` and `rate` are
null, the admin lists render `—`, and order quoting ignores the row.

Every synchronized row stores both `raw_rate` from the provider and final
`rate`. Synchronization applies the configured basis-point adjustment with exact
decimal arithmetic before writing the final value. Both lists display “Original
rate” and “Rate”, without source or basis-point columns. Manually editing either
category changes only the final `rate`; it preserves the last provider raw value,
source, and observation time. The next successful synchronization updates both
values again. There is no independent rate-policy or sync-source table.

Provider API addresses belong to exchange/wallet connection configurations. Account
identifiers and read-only credentials belong to each receiving method and are
encrypted together; changing them keeps that method disabled until its target
and provider identity pass validation again. Blockchain endpoint and RPC API-key
configuration is accepted only on chain connection configurations.

When scheduled detection is delayed, the payer can choose **Paid but not confirmed?** in checkout and submit the provider transaction identifier. The server does not trust this claim: it loads the transaction from the configured adapter, verifies the order's receiving target, network, and asset, and only then sends the normalized event through the normal idempotent accounting path. Submissions are bounded to five attempts per order and client address per minute when KV is available.

Required confirmations belong to the payment method. Provider-account adapters normally use `1`. Never use a withdrawal-enabled exchange key; GMPay Edge only needs account identity and incoming-history access.

## TRON, TRX, and TRC20

- Adapter: `tron`
- Seeded RPC: `https://api.trongrid.io`
- Receiving target: a Base58Check address beginning with `T`
- Native asset: TRX, 6 decimals
- Seeded token: USDT TRC20, 6 decimals

RPC node fields:

```json
{
  "url": "https://api.trongrid.io",
  "apiKey": "optional TronGrid API key"
}
```

New RPC nodes are saved disabled. Test the node from its row action before
enabling it; enablement itself repeats the live health check and is rejected on
failure. Enabled nodes are checked again by scheduled maintenance, with current
latency and healthy/unhealthy state shown in the RPC table.

The built-in HTTPS templates are enabled at installation so scheduled health
checks can evaluate them immediately. They are not exposed to orders until a
check reports healthy and an enabled, validated receiving method selects the
corresponding payment method. Built-in WSS templates remain disabled at
priority 200. Reconciliation fills missing catalog defaults and preserves
operator-edited rows.

RPC nodes can be edited without deleting references. Leaving the API Key field
blank preserves the stored value; the explicit clear switch removes it. Changes
to the network, endpoint URL, or API Key invalidate the previous health result,
disable the node atomically, and require a new successful test before it can be
enabled. Name and priority-only changes keep the current enabled and health
state. Audit metadata records whether a credential changed but never its value.

The adapter reads TRX transactions and TRC20 transfers, validates destination, asset and amount, tracks block confirmations, rejects failed transactions, and identifies canonical block changes. Each observed transfer resolves the `blockID` at its own block height (deduplicated per scan), rather than using the moving chain-head hash, so confirmation growth cannot be mistaken for a reorganization. The API key belongs to the RPC node, not the global runtime settings.

## Ethereum, Base, BNB Smart Chain, and Polygon

- Adapter: `evm`
- Receiving target: a 20-byte `0x` address
- Supported native assets: ETH, BNB, and MATIC as seeded
- Supported tokens: seeded USDT/USDC contracts

Configure one JSON-RPC connection configuration for each network. The runtime constructs the adapter from the selected asset, seeded contract/decimals, network code, and healthy enabled endpoint.

```json
{
  "url": "https://your-network-rpc.example",
  "apiKey": "optional provider key"
}
```

The shared EVM adapter scans native transfers and ERC20/BEP20 `Transfer` logs. A payer-submitted transaction hash is resolved against the payment method's configured token contract, receiving address, and optional log index instead of trusting the receipt's first `Transfer` event; native payments ignore unrelated token logs. Verify every token contract and decimal value against the issuer before production use. Built-in HTTPS templates start enabled for health evaluation but remain unavailable to orders until they are healthy and an enabled, validated receiving method exists. EVM connections also support secure `wss://` JSON-RPC. WSS templates start disabled at priority 200; when enabled, the selected WSS subscription runs concurrently with the authoritative HTTP poll. A rejected or dropped subscription records WSS health without discarding the HTTP result, and the next bounded queue scan reconnects from the persisted cursor.

## TON

- Adapter: `ton`
- Default API: `https://toncenter.com/api/v3`
- Receiving target: an `EQ…` or `UQ…` user-friendly address
- Native asset: GRAM, 9 decimals
- Seeded token: Jetton USDT

Configure the TON Center v3 endpoint and optional API key on the RPC node. Native inbound messages and Jetton transfers are normalized separately. Confirm the Jetton master stored on the asset before enabling the channel.

## Aptos

- Adapter: `aptos`
- Default indexer: `https://api.mainnet.aptoslabs.com/v1/graphql`
- Receiving target: a `0x` account address up to 64 hexadecimal digits
- Seeded native asset: APT, 8 decimals
- Seeded tokens: USDT and USDC fungible-asset types

The RPC node URL is used as the GraphQL indexer endpoint. The adapter scans successful fungible-asset activities, treats the transaction version as the transaction lookup identifier, and uses the Indexer's stable `event_index` for chain-event idempotency. Query result positions are never used as payment identity. Confirm the asset type and decimals before production use.

## Solana

- Adapter: `solana`
- Default RPC: `https://api.mainnet-beta.solana.com`
- Receiving target: a Base58 wallet address
- Seeded native asset: SOL, 9 decimals
- Seeded tokens: SPL USDT and USDC mints

The adapter discovers token accounts owned by the receiving wallet, scans signatures, parses SPL transfers, and requires finalized commitment by default. Production traffic should use a dedicated RPC provider; the built-in HTTPS template starts enabled for evaluation but does not expose Solana at checkout without a healthy connection and an enabled receiving method.

## Binance

- Adapter: `exchange`
- Provider/network code: `binance`
- Receiving target: the numeric Binance account UID
- Supported assets: USDT and USDC

The connection configuration stores the API address. Each receiving method stores:

```json
{
  "apiKey": "read-only API key",
  "secretKey": "API secret",
  "receiverUid": "numeric Binance UID"
}
```

The default API address is `https://api-gcp.binance.com`. Before enablement, the adapter verifies access to the exact signed Pay-history endpoint used by detection. Binance does not expose the receiver UID through an unrelated Spot-account probe, so GMPay Edge validates the numeric configured UID and accepts only Pay-history rows whose `receiverInfo.binanceId` and asset match that receiving method. Restrict the key by IP and grant only the Pay-history read permission; the adapter never performs trades or withdrawals.

## OKX

- Adapter: `exchange`
- Provider/network code: `okx`
- Receiving target: the numeric OKX account UID
- Supported assets: USDT and USDC

The connection configuration stores the API address. Each receiving method stores:

```json
{
  "apiKey": "read-only API key",
  "secretKey": "API secret",
  "passphrase": "API passphrase",
  "accountUid": "numeric account UID"
}
```

The default API address is `https://www.okx.com`. The signed account response must match `accountUid`. Only positive funding bills for the requested asset are accepted. Use a read-only key, disable withdrawal permission, and apply provider-side IP restrictions.

Use the regional API domain assigned to the account when it differs from the global default (for example `us.okx.com` or `eea.okx.com`).

## OKPay

- Adapter: `wallet`
- Provider/network code: `okpay`
- Receiving target: the shop ID
- Supported assets: USDT and TRX

The connection configuration stores the API address. Each receiving method stores:

```json
{
  "shopId": "shop identifier",
  "apiKey": "shop signing API key"
}
```

The default API address is `https://api.okaypay.me/shop`. GMPay Edge creates a hosted payment URL, stores the provider order ID, validates signed callbacks, and also polls transfer status. The public callback is `/api/providers/okpay/notify`. The callback does not trust order status, amount, asset, shop identity, or signature supplied by the client without adapter validation.

Built-in connection templates without verified credentials remain disabled. Configure any required API key, run the live health check, and only then enable an operational receiving method. Seeded support metadata is not evidence that a deployment is ready to accept funds.

Receiving-method amount locks also have a reuse quarantine. Completing, cancelling,
or expiring an order releases its active reservation, but the same target, asset,
and expected asset-unit amount cannot be assigned again until the original expiry plus
the configured reorganization-monitoring window. This prevents a delayed payment
for an old order from being attributed to a newer order that reused the same amount.
Changing the monitoring window affects newly allocated orders; immutable order
snapshots and existing lock deadlines are not rewritten.

If an existing development installation predates a newly added default, run **Admin → Operations → Reset payment defaults**. The operation uses insert-if-missing semantics, restores missing rails, assets, connection templates, payment methods, rates, and sync settings without re-enabling or overwriting operator configuration. It is safe to run repeatedly.

## Exchange-rate synchronization

Binance Spot and OKX Spot observations use bounded concurrency so one slow
ticker does not serialize every pair. Each crypto pair is isolated: a failed or
malformed provider response never overwrites its previous observation. Fiat
sync normalizes the provider's USD quote table and upserts valid three-letter
currency rows while preserving both raw and adjusted values.

Every refresh returns configured, updated, and failed counts. Partial failures
write one structured audit summary containing only the source, pair, and stable
error code; provider response bodies are not persisted. Successful scheduled
runs do not create per-minute audit noise, while administrator-triggered runs
are always attributed to their actor, request ID, and source IP.

## Secrets and logs

Exchange and wallet credentials are encrypted with their receiving method; provider API addresses and chain RPC API keys live in connection configuration. API responses and audit logs never expose provider secrets, signing keys, or Webhook secrets. Wallet private keys and seed phrases are not accepted by any adapter.

## Production verification checklist

- Confirm network, token contract/mint/master/type, and decimals from the issuer.
- Confirm the receiving target belongs to the deployment operator.
- Use read-only provider credentials and IP allowlists.
- Run the adapter health check and a low-value live payment.
- Verify pending, confirmation, paid, underpaid, overpaid, expiry, and late-arrival behavior.
- Verify Webhook signature validation, retry, and duplicate-event handling.
- Review audit logs after every configuration change.

## Live platform validation

The automated quality gates use sanitized fixtures and never require network credentials, external accounts, or live funds. The chain, exchange, wallet, and Telegram smoke suites are retained as manually inspectable assets but are unconditionally skipped; environment variables cannot enable them. Production validation remains an explicit operator-run acceptance activity and is not reported as automated evidence.
