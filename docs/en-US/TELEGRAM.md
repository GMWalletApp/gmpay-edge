# Telegram integration

English · [简体中文](../zh-CN/TELEGRAM.md)

GMPay Edge uses grammY to manage multiple Telegram Bots for Inline ordering, order lookup, payment checks, operational notifications, and configurable commands. Bots are platform connections; commands are instance-wide while notification subscriptions belong to a concrete Bot.

## Configure a Bot

1. Create a Bot with BotFather and enable Inline Mode.
2. Add its Token under **Admin → Telegram → Bots**. GMPay Edge verifies it with `getMe`, creates a per-Bot Webhook Secret, and registers `/api/telegram/:botId/webhook`.
3. Inbound requests must pass `X-Telegram-Bot-Api-Secret-Token` verification.
4. Tokens and Webhook Secrets are encrypted, never returned by list APIs, and never included in audit payloads.

The Webhook accepts `message`, `inline_query`, `chosen_inline_result`, `callback_query`, and `my_chat_member` updates.

## Notification subscriptions and Telegram access

When a user sends `/start` in a private chat, the system idempotently creates a disabled `private` notification subscription. It automatically records the Telegram User ID, username, display name, and locale for administrator review.

When a Bot joins a group, supergroup, or channel, `my_chat_member` creates a disabled subscription automatically; supergroups normalize to `group`. Removing or kicking the Bot disables the subscription, and rejoining never silently re-enables it.

Administrators may also create subscriptions manually and enter the name, Bot, target type, target ID, locale, events, and six-locale content.

Each subscription has one enabled switch:

- a private subscription controls notifications, Inline ordering, order lookup, and **I have paid** checks together;
- group and channel subscriptions control notification delivery;
- a disabled private subscription never authorizes Telegram order operations.

## Message content

There is no standalone message-template catalog. Every notification subscription and command owns its `en-US`, `ja-JP`, `ko-KR`, `ru-RU`, `zh-TW`, and `zh-CN` content directly. Default subscription settings store the default events and six-locale notification content used for automatically discovered targets.

Content uses Telegram Markdown and only documented non-secret variables:

- `{{orderId}}`, `{{externalOrderId}}`, and `{{status}}`;
- `{{amount}}` and `{{currency}}`;
- `{{payment.amount}}`, `{{payment.asset}}`, and `{{payment.network}}`.

Delivery falls back from the selected locale to `en-US`, then to a safe built-in format. Dynamic values are escaped, and failure audits never contain message bodies, Tokens, or Secrets.

## Commands and Inline

The instance initializes `/start`, `/help`, `/new`, and `/status`. Their built-in behavior is system-owned; administrator-created commands always reply with their six-locale content and do not expose a handler selector. Commands are unique by `command + scope` and can be synchronized to one or all Bots.

Inline drafts do not reserve receiving methods. An order is created only after Telegram returns `chosen_inline_result` and the matching private subscription is enabled. **I have paid** only requests one idempotent adapter scan and never marks an order paid directly.

Automated quality gates never contact Telegram. Production verification must cover the final HTTPS Webhook, automatic target discovery, subscription review, Inline authorization, six-locale content, command synchronization, Token rotation, and redacted failure audits.
