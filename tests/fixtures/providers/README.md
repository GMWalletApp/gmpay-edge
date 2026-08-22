# Provider response fixtures

These sanitized fixtures preserve the response shapes consumed by GMPay Edge without containing real account identifiers or credentials. Field names and nesting are based on the provider API contracts used by the adapters:

- Binance Pay transaction history: <https://developers.binance.com/docs/binance-pay/api-order-query>
- OKX funding bills: <https://www.okx.com/docs-v5/en/#funding-account-rest-api-get-bills-details>
- OKPay shop integration: the [official shop API contract](https://docs.okaypay.me/doc.html) for the HMAC-SHA256 `payLink` and `checkTransferByTxid` protocol

Pagination tests generate additional rows around these canonical shapes. Live compatibility is checked separately by the opt-in smoke suite and never by default CI.

Chain fixtures under `tests/fixtures/chains` follow the corresponding official RPC/indexer response contracts. The TRON event fixture intentionally uses the 32-byte TVM event address form to verify the required `41` prefix and Base58Check conversion, and preserves the provider `event_index` for transaction-event uniqueness.
