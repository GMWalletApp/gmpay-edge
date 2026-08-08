# Merchant API

[简体中文](../zh-CN/MERCHANT_API.md) · English

GMPay is the primary merchant protocol. EPay is a compatibility adapter over
the same API credential, order service, checkout, payment processor, and
Webhook outbox.

## API credential

Each credential contains a numeric `pid` and an API Secret. The Secret is shown
only when the credential is created or rotated. Rotation updates the credential
in place: the PID remains stable and every later delivery uses the new Secret.
Grant `orders:create` for transaction creation and `orders:read` for queries.
Scopes are checked independently and fail closed when stored scope data is invalid.

## GMPay create transaction

Send JSON or `application/x-www-form-urlencoded` to:

```text
POST /payments/gmpay/v1/order/create-transaction
```

Fields:

- `pid`, `order_id`, `currency`, `amount`, `notify_url`, `signature`;
- `amount` accepts a positive JSON number or decimal string such as `12.5` or
  `"12.50"`; strings preserve formatting exactly, while JSON numbers use their
  parsed decimal representation for signing and minor-unit conversion.
- optional `token` and `network`, which must be provided together;
- optional `redirect_url` and `name`.

Omitting both `token` and `network` creates a `pending` selectable order. It
does not silently default to TRON or USDT. The checkout uses the returned
`payment_url` to let the payer select an available receiving method.

Create, query, and checkout responses expose the epusdt-compatible integer
`status`: `1` means waiting for payment, `2` paid, `3` closed, and `4` waiting
for payment method selection. `status_detail` retains the finer GMPay Edge
state such as `confirming`, `partially_paid`, or `overpaid`.

## GMPay HMAC-SHA256 signature

1. Exclude `signature`.
2. Exclude null and empty-string values.
3. Convert numbers to their normal decimal representation.
4. Sort field names in ASCII ascending order.
5. Join `key=value` pairs with `&` without URL encoding.
6. Calculate HMAC-SHA256 using the API Secret as the HMAC key.
7. Encode the result as 64-character lowercase hexadecimal text.

```ts
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const parameters = {
  pid: "100000000001",
  order_id: "invoice-1001",
  currency: "USD",
  amount: "12.50",
  notify_url: "https://merchant.example/notify",
};
const source = Object.entries(parameters)
  .filter(([, value]) => value !== "")
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([key, value]) => `${key}=${value}`)
  .join("&");
const signature = bytesToHex(
  hmac(
    sha256,
    utf8ToBytes(process.env.GMPAY_API_SECRET ?? ""),
    utf8ToBytes(source),
  ),
);
```

Save the snippet as `sign.ts`, set `GMPAY_API_SECRET`, and run it with
`bun sign.ts`. A complete request can then be sent without any SDK:

```bash
curl --fail-with-body \
  -H 'content-type: application/json' \
  --data '{"pid":"100000000001","order_id":"invoice-1001","currency":"USD","amount":"12.50","notify_url":"https://merchant.example/notify","signature":"<lowercase-hmac-sha256>"}' \
  https://pay.example.com/payments/gmpay/v1/order/create-transaction
```

The authoritative implementation and vectors are in
`src/features/api-keys/server/gmpay-signature.ts` and
`tests/unit/auth/gmpay-signature.test.ts`.

## GMPay order query

Query an order created by the same API credential using exactly one selector:

```text
GET /payments/gmpay/v1/order/query?pid=100000000001&trade_id=<trade-id>&signature=<lowercase-hmac-sha256>
```

Use `order_id` instead of `trade_id` when querying by the external order ID.
The signature uses the same sorted non-empty query fields and secret as order
creation. A credential can only query orders created with that credential.

## GMPay notifications

GMPay Edge POSTs JSON to the order's immutable `notify_url`. The payload uses
the epusdt-compatible integer status (`1` waiting, `2` paid, `3` closed) and contains `pid`, `trade_id`,
`order_id`, order/payment amounts, target, token, transaction ID, status, and
`signature`. Verify it with the same sorted-parameter HMAC-SHA256 algorithm and return
plain text `ok` with HTTP 200. Any other response is retried.
Persist the order/event identity before returning `ok`, because automatic and
manual delivery retries can send the same logical status more than once.

This Bun handler verifies a received JSON payload using the exact same
canonicalization rule:

```ts
import { timingSafeEqual } from "node:crypto";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const payload = await Bun.stdin.json() as Record<string, string | number>;
const received = String(payload.signature ?? "");
const source = Object.entries(payload)
  .filter(([key, value]) => key !== "signature" && value != null && value !== "")
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([key, value]) => `${key}=${value}`)
  .join("&");
const expected = bytesToHex(hmac(
  sha256,
  utf8ToBytes(process.env.GMPAY_API_SECRET ?? ""),
  utf8ToBytes(source),
));
const valid = received.length === expected.length && timingSafeEqual(
  Buffer.from(received),
  Buffer.from(expected),
);
if (!valid) throw new Error("invalid signature");
process.stdout.write("ok");
```

## EPay compatibility

EPay clients may use GET query parameters or form POST at:

```text
/payments/epay/v1/order/create-transaction/submit.php
```

The adapter accepts `pid`, `money`, `out_trade_no`, `notify_url`, optional
`return_url`, `name`, `type`, plus `sign` and optional `sign_type=MD5`.
Signature calculation excludes `sign` and `sign_type`. `type=asset.network`
selects a payment method; empty or `alipay` creates a selectable order without
defaulting to a chain. Success returns the same order envelope as GMPay. Open
`data.payment_url` once to enter the unified GMPay Edge checkout; the create
endpoint does not issue an intermediate redirect.

The EPay adapter signs its GET callback query with the same Secret and requires
plain text `ok`. EPay field names and `trade_status` exist only at this boundary;
the database and application continue using the GMPay Edge order state machine.

## Errors and idempotency

Responses use `status_code`, `message`, `data`, and `request_id`. An external
order ID is unique within the creating API credential. Repeating it with the
same credential cannot create a second order, while independent credentials may
use their own business numbering. API scope and D1 rate-limit checks are
enforced before order creation.

| `status_code` | Meaning |
| --- | --- |
| `10002` | External order ID already exists |
| `10003` | Requested receiving method is unavailable |
| `10004` | Amount is invalid |
| `10009` | Request parameters are invalid |
| `10016` | Requested asset/network is unavailable |
| `401` | PID, scope, or signature verification failed |
| `429` | API credential rate limit exceeded |
| `500` | Unexpected gateway failure; use `request_id` when investigating |

Treat a timeout as an unknown outcome: query your own persisted result before
choosing a new external order ID. Retrying the same `order_id` is safe from
duplicate creation because the database unique constraint is authoritative,
but returns `10002` rather than silently creating or replacing an order.

The authoritative contract is [`public/openapi.yaml`](../../public/openapi.yaml)
and is rendered at `/docs`.
