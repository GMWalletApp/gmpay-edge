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

## Delivery semantics

- Only HTTP `200` with a plain-text `ok` acknowledgement is success.
- Delivery state and each attempt are persisted in D1.
- Queue messages contain identifiers, not secrets.
- Failures use bounded exponential backoff and the configured maximum attempts.
- Outbox recovery requeues stranded initial and retry deliveries idempotently.
- Manual retry uses the same event payload with a new delivery attempt.
- An administrator may explicitly resend the current order state; this creates a
  new manual event and delivery while preserving earlier successful history.
- JSON response capture and audit records are bounded and redact sensitive
  fields. Opaque non-JSON response bodies are never persisted verbatim.

The **Outbound notifications** table exposes a delivery detail dialog with the
event payload and newest-first attempt history. New attempts retain the exact
request method, target, headers, and body or query parameters used for delivery,
but signing values are stored as `[REDACTED]` and decrypted credentials are never
persisted. An unavailable or invalid snapshot is shown as unavailable rather
than reconstructed from mutable current state.

Payment accounting, order transition, Webhook event creation, and delivery
outbox insertion are committed together. Duplicate chain/provider events cannot
create duplicate business events or callback deliveries.

## Production verification

1. Use an HTTPS receiver that records the raw body and headers.
2. Verify a valid signature and reject modified callback parameters.
3. Return `500`, timeout, and redirect responses to verify retries and SSRF
   controls.
4. Replay the same event ID and verify application-level deduplication.
5. Recover a stopped Queue consumer and confirm outbox delivery resumes once.
