# Webhooks

[简体中文](../zh-CN/WEBHOOKS.md) · English

GMPay Edge distinguishes system inbound endpoints from order-level outbound
notifications.

## Inbound endpoints

Inbound endpoints are an installed path-only catalog for provider callbacks and
Telegram. They never persist a deployment domain. The admin endpoint detail
page derives an example URL from the current Origin and shows redacted receipts,
signature result, processing status, duration, and safe error code.

Allowed deployment hosts are configured once under **Security → Allowed Hosts**
and enforced by global middleware for normal requests and callbacks.

Every provider endpoint claims a fixed-window budget of 600 requests per minute
per endpoint and client address in the authoritative database before it reads
the body, decrypts a credential, or writes a receipt; excess requests receive
`429` without a receipt. Authenticated outcomes and server failures are always
recorded. Unauthenticated rejections (`4xx` before the signature verified) are
recorded only for the first 20 requests of a client window, so junk traffic
cannot fill the receipt table. A receipt's external request ID is the validated
identifier echoed in the `x-request-id` response header. The OKPay endpoint
answers an unknown order exactly like a bad signature. The Telegram Webhook
applies its own per-Bot and per-address budgets and acknowledgement policy; see
[Telegram](./TELEGRAM.md#webhook-processing-policy).

## Order notification URL

The merchant may pass `notify_url` when creating an order. GMPay Edge validates
that it is a public HTTPS URL and stores it immutably with the order and the API
credential identity that created that order. There is no global callback-target
configuration and an order event is never broadcast to another order's URL.
Private, loopback, link-local, metadata, credential-bearing, and unsafe redirect
targets are rejected.

## Signature verification

GMPay delivery JSON includes `signature`, calculated as lowercase HMAC-SHA256
over the sorted non-empty callback fields with the API Secret as the HMAC key. EPay delivery uses a GET
query with `sign` and `sign_type=MD5`. Rotation updates the credential in place:
PID and order references remain stable, while all later deliveries and explicit
resends use the new Secret. Compare signatures in constant time and deduplicate
by the transaction or order identity appropriate to the integration.

The runnable Bun verification example in
[`MERCHANT_API.md`](./MERCHANT_API.md#gmpay-notifications) reads the raw JSON
from stdin, performs a constant-time comparison, and prints the required plain
text `ok` acknowledgement. Production handlers should persist the event/order
identity before acknowledging so a repeated delivery is harmless.

The GMPay and EPay callback formats are fixed by protocol compatibility: the
signature covers only the business fields, and there is no signed timestamp or
nonce. The event and delivery identifiers travel in the unsigned
`x-gmpay-event-id` and `x-gmpay-delivery-id` headers. A captured callback can
therefore be replayed within TLS-protected transport; receivers must treat
deliveries as at-least-once and deduplicate by the trade/order identity and
status they already persisted rather than relying on freshness of the message.

## Delivery semantics

- Only HTTP `200` with a plain-text `ok` acknowledgement is success.
- Delivery state and each attempt are persisted in D1.
- Queue messages contain identifiers, not secrets.
- Failures use bounded exponential backoff and the configured maximum attempts.
- Outbox recovery requeues stranded initial and retry deliveries idempotently,
  including a delivery left in `delivering` whose consumer lease expired without
  a recorded outcome; that delivery continues with the next attempt number.
- Infrastructure failures before the merchant request (database read, DNS
  pre-check) hand the claim back and let the Queue redeliver the same attempt;
  they neither consume an attempt nor record one.
- Manual retry uses the same event payload and continues the attempt numbering
  (attempt N+1), so earlier attempt history is never overwritten. It is accepted
  for `dead` deliveries and for `failed` or stranded `delivering` deliveries
  with no scheduled or leased attempt; otherwise it answers "retry in
  progress". When the manual attempt fails and the configured maximum is
  reached, the delivery is dead again and can be retried once more.
- An administrator may explicitly resend the current order state; this creates a
  new manual event and delivery while preserving earlier successful history.
- JSON response capture and audit records are bounded and redact sensitive
  fields. A plain-text response excerpt is kept (at most 512 bytes) with obvious
  `key=value` secrets masked.

The **Outbound notifications** table exposes a delivery detail dialog with the
event payload and newest-first attempt history. New attempts retain the exact
request method, target, headers, and body or query parameters used for delivery,
but signing values are stored as `[REDACTED]` and decrypted credentials are never
persisted. An unavailable or invalid snapshot is shown as unavailable rather
than reconstructed from mutable current state.

Payment accounting, order transition, Webhook event creation, and delivery
outbox insertion are committed together. Duplicate chain/provider events cannot
create duplicate business events or callback deliveries.

Terminal delivery history follows the audit retention setting. Retention runs
on every maintenance tick in bounded chunks while expired rows remain, so a
steady stream of deliveries, receipts, and task runs never outgrows the cleanup.

## Runtime notes

- Workers egress cannot reach private networks. On Bun, the DNS pre-check
  resolves the callback host over DNS-over-HTTPS immediately before the request,
  but `fetch` resolves the name again through the system resolver, so a
  rebinding DNS server keeps a narrow window. Run Bun deployments behind an
  egress policy that blocks private ranges when this residual matters.
- The Bun durable queue mirrors Cloudflare's delivery budget (one delivery plus
  the configured retries) and leases a message long enough for the slowest
  handler. Dead-lettered rows are counted on the **Queue monitoring** page and
  purged after seven days from an idle poll.

## Production verification

1. Use an HTTPS receiver that records the raw body and headers.
2. Verify a valid signature and reject modified callback parameters.
3. Return `500`, timeout, and redirect responses to verify retries and SSRF
   controls.
4. Replay the same event ID and verify application-level deduplication.
5. Recover a stopped Queue consumer and confirm outbox delivery resumes once.
