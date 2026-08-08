# Telegram 集成

简体中文 · [English](../en-US/TELEGRAM.md)

GMPay Edge 使用 grammY 管理多个 Telegram Bot，支持 Inline 下单、查单、支付检查、运维通知和可配置指令。Bot 是平台连接；指令属于实例公共目录，通知订阅属于具体 Bot。

## 配置 Bot

1. 使用 BotFather 创建 Bot 并启用 Inline Mode。
2. 在“后台 → Telegram → Bot”添加 Token。系统通过 `getMe` 验证 Token，生成每 Bot 独立的 Webhook Secret，并注册 `/api/telegram/:botId/webhook`。
3. 入站请求必须通过 `X-Telegram-Bot-Api-Secret-Token`。
4. Token 和 Webhook Secret 加密保存，不由列表接口返回，也不进入审计载荷。

Webhook 接收 `message`、`inline_query`、`chosen_inline_result`、`callback_query` 和 `my_chat_member`。

## 通知订阅与 Telegram 权限

用户在私聊中发送 `/start` 时，系统幂等创建一条默认停用的 `private` 通知订阅。订阅自动保存 Telegram User ID、用户名、显示名称和语言，等待管理员审核。

Bot 加入群组、超级群组或频道时，`my_chat_member` 自动创建默认停用的订阅；超级群组统一记为 `group`。Bot 被移除或踢出时订阅自动停用，重新加入不会自动恢复启用状态。

管理员也可以手动新建订阅，并填写名称、Bot、目标类型、目标 ID、语言、事件和六语言模板内容。

每条订阅只有一个启用开关：

- 私聊订阅同时控制通知、Inline 下单、查单和“我已付款”检查；
- 群组和频道订阅控制通知发送；
- 关闭的私聊订阅不能授权 Telegram 订单操作。

## 模板内容

不设独立消息模板目录。每条通知订阅和每条指令直接拥有 `en-US`、`ja-JP`、`ko-KR`、`ru-RU`、`zh-TW`、`zh-CN` 六语言内容。默认订阅设置保存自动发现目标使用的默认事件和默认六语言通知内容。

内容使用 Telegram Markdown，只允许文档化的非敏感变量：

- `{{orderId}}`、`{{externalOrderId}}`、`{{status}}`；
- `{{amount}}`、`{{currency}}`；
- `{{payment.amount}}`、`{{payment.asset}}`、`{{payment.network}}`。

发送时按订阅语言、`en-US`、内置安全格式回退。动态变量值会被转义，失败审计不会记录消息正文、Token 或 Secret。

## 指令与 Inline

实例初始化 `/start`、`/help`、`/new`、`/status`。四条内置指令的处理行为由系统固定；管理员新建的指令统一回复其六语言内容，不需要选择“处理方式”。指令以 `command + scope` 唯一，可同步到单个或全部 Bot。

Inline 草稿不会预占收款方式；只有 Telegram 返回 `chosen_inline_result` 且对应私聊订阅已启用时才创建订单。“我已付款”只请求一次幂等的适配器扫描，不会直接把订单标记为已支付。

自动化质量门不会访问 Telegram。生产发布需人工验证最终 HTTPS Webhook、自动目标发现、订阅审核、Inline 权限、六语言内容、指令同步、Token 轮换和脱敏失败审计。
