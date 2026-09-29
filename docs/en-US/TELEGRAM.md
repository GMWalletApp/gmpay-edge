# Telegram integration

English · [简体中文](../zh-CN/TELEGRAM.md)

GMPay Edge uses grammY to manage multiple Telegram Bots for Inline ordering, order lookup, payment checks, operational notifications, and configurable commands. Bots are platform connections; commands are instance-wide while notification subscriptions belong to a concrete Bot.

## Configure a Bot

1. Create a Bot with BotFather and enable Inline Mode.
2. Add its Token under **Admin → Telegram → Bots**. GMPay Edge verifies it with `getMe`, creates a per-Bot Webhook Secret, and registers `/api/telegram/:botId/webhook`. One Bot username maps to one row; adding the same Bot twice is rejected. If the command sync after creation fails, the Bot is still saved and the page asks you to run **Sync commands**.
3. Inbound requests must pass `X-Telegram-Bot-Api-Secret-Token` verification.
4. Tokens and Webhook Secrets are encrypted, never returned by list APIs, and never included in audit payloads.

Telegram API outcomes in administration surface as stable codes: an invalid Token is reported as `telegram_token_invalid`, any other Telegram rejection as `telegram_api_rejected`, and a network failure as `telegram_unreachable`. Raw Telegram responses never reach the browser.

The Webhook accepts `message`, `inline_query`, `chosen_inline_result`, `callback_query`, and `my_chat_member` updates.

### Webhook processing policy

- Malformed, unknown, and disabled Bot ids receive the same `404` and are not recorded.
- Requests are rate limited per Bot (600 per minute) and per client address (1 800 per minute) before anything is written; the limiter is the authoritative database. Over-limit requests receive `429`, which Telegram retries later.
- A secret mismatch answers `401`; like every other inbound endpoint, only the first 20 rejected requests per client address and minute are stored as inbound receipts, so a leaked webhook URL cannot flood the receipt table.
- The Webhook Secret is verified before the update body is read; bodies above 256 KiB are rejected with `413`.
- A Telegram Bot API rejection with a permanent `4xx` (for example a blocked chat, an expired callback query, or an unparsable template) is acknowledged with `200` and recorded in the inbound receipt with its error code (`telegram_api_rejected_403`), so Telegram does not redeliver it and later updates of the same chat are not delayed. Network failures, timeouts, `429`, and `5xx` still return `5xx` so that Telegram retries.
- A Markdown reply that Telegram cannot parse is re-sent once as plain text.
- A private chat that blocks the Bot (`403 bot was blocked by the user` on a reply, or `my_chat_member` with status `kicked`) has its subscription disabled once with a `telegram_target.auto_disabled` audit; unblocking never re-enables it.

## Notification subscriptions and Telegram access

When a user sends `/start` in a private chat, the system idempotently creates a disabled `private` notification subscription. It automatically records the Telegram User ID, username, display name, and locale for administrator review.

When a Bot joins a group, supergroup, or channel, `my_chat_member` creates a disabled subscription automatically; supergroups normalize to `group`. Removing or kicking the Bot disables the subscription, and rejoining never silently re-enables it.

Administrators may also create subscriptions manually and enter the name, Bot, target type, target ID, locale, events, and six-locale content.

Each subscription has one enabled switch:

- a private subscription controls notifications, Inline ordering, Inline quotes, order lookup, and **I have paid** checks together;
- group and channel subscriptions control notification delivery;
- a disabled private subscription never authorizes Telegram order operations; an unbound user receives a single "not bound" Inline result instead of quotes.

GMPay Edge is single-tenant, and an enabled private subscription is an operator trust decision: that Telegram user can look up any order of the instance by order id or external order id and create orders through Inline mode. Enable private subscriptions only for operators.

## Message content

There is no standalone message-template catalog. Every notification subscription and command owns its `en-US`, `ja-JP`, `ko-KR`, `ru-RU`, `zh-TW`, and `zh-CN` content directly. Default subscription settings store the default events and six-locale notification content used for automatically discovered targets.

Content uses Telegram Markdown and only documented non-secret variables:

- `{{orderId}}`, `{{externalOrderId}}`, and `{{status}}`;
- `{{amount}}` and `{{currency}}`;
- `{{payment.amount}}`, `{{payment.asset}}`, and `{{payment.network}}`.

Delivery falls back from the selected locale to `en-US`, then to a safe built-in format whose labels are localized Paraglide messages. Dynamic values are escaped, and failure audits never contain message bodies, Tokens, or Secrets.

### Delivery

Order notifications are dispatched after the order event is committed and run outside the request path: on Workers through `waitUntil`, on Bun through the in-process background task set. Checkout, merchant, and provider callback responses never wait for Telegram. Queue consumers and Cron have no `waitUntil` and await the fan-out inline.

Each fan-out decrypts every Bot Token once, sends to at most four subscriptions concurrently, and honors Telegram flood control: a `429` with `retry_after` is retried at most twice while the wait still fits the delivery budget. Every failed subscription is recorded as a `telegram.delivery_failed` audit with the event type and a stable error code such as `telegram_api_rejected_403` or `telegram_transport_error`. There is no durable retry beyond flood control; a subscription that blocked the Bot is disabled automatically.

## Commands and Inline

The instance initializes `/start`, `/help`, `/new`, and `/status`. Their built-in behavior is system-owned; administrator-created commands always reply with their six-locale content and do not expose a handler selector. Commands are unique by `command + scope` and can be synchronized to one or all Bots.

**Restore missing defaults** under **Admin → Telegram → Commands** (permission `telegram:update`) runs the reconcile step for an existing deployment: it inserts built-in commands that were deleted, fills missing locale replies and missing default notification content, never overwrites administrator edits, reports how many entries were filled, and writes a `telegram.defaults_reconciled` audit. Run **Sync commands** afterwards to push restored commands to Telegram.

Telegram accepts one `zh` language code, so the `zh-CN` command descriptions are synchronized for both Simplified and Traditional Chinese clients; `zh-TW` descriptions are used only inside GMPay Edge replies.

Inline drafts do not reserve receiving methods. An order is created only after Telegram returns `chosen_inline_result` and the matching private subscription is enabled. **I have paid** only requests one idempotent adapter scan and never marks an order paid directly.

Automated quality gates never contact Telegram. Production verification must cover the final HTTPS Webhook, automatic target discovery, subscription review, Inline authorization, six-locale content, command synchronization, Token rotation, and redacted failure audits.
