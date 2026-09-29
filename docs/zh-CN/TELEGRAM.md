# Telegram 集成

简体中文 · [English](../en-US/TELEGRAM.md)

GMPay Edge 使用 grammY 管理多个 Telegram Bot，支持 Inline 下单、查单、支付检查、运维通知和可配置指令。Bot 是平台连接；指令属于实例公共目录，通知订阅属于具体 Bot。

## 配置 Bot

1. 使用 BotFather 创建 Bot 并启用 Inline Mode。
2. 在“后台 → Telegram → Bot”添加 Token。系统通过 `getMe` 验证 Token，生成每 Bot 独立的 Webhook Secret，并注册 `/api/telegram/:botId/webhook`。一个 Bot 用户名只对应一行记录，重复添加同一个 Bot 会被拒绝。创建后的指令同步若失败，Bot 仍会保存，页面会提示使用“同步指令”重试。
3. 入站请求必须通过 `X-Telegram-Bot-Api-Secret-Token`。
4. Token 和 Webhook Secret 加密保存，不由列表接口返回，也不进入审计载荷。

后台流程中的 Telegram API 结果以稳定错误码呈现：Token 无效为 `telegram_token_invalid`，其他 Telegram 拒绝为 `telegram_api_rejected`，网络故障为 `telegram_unreachable`。Telegram 的原始响应不会到达浏览器。

Webhook 接收 `message`、`inline_query`、`chosen_inline_result`、`callback_query` 和 `my_chat_member`。

### Webhook 处理策略

- 格式错误、不存在和已停用的 Bot ID 统一返回 `404`，且不记录入站记录。
- 在写入任何数据之前，请求按 Bot（每分钟 600 次）和客户端地址（每分钟 1 800 次）限流，限流器以权威数据库为准。超限请求返回 `429`，Telegram 会稍后重试。
- Secret 不匹配返回 `401`；与其他入站端点一致，每个客户端地址每分钟只有前 20 条被拒请求会写入入站记录，泄露的 Webhook 地址无法灌满记录表。
- 先校验 Webhook Secret，再读取更新正文；超过 256 KiB 的正文返回 `413`。
- Telegram Bot API 返回永久性 `4xx`（例如聊天已拉黑、回调查询已过期、模板无法解析）时，Webhook 返回 `200` 并在入站记录中写入错误码（如 `telegram_api_rejected_403`），避免 Telegram 重投递并阻塞同一聊天的后续更新。网络故障、超时、`429` 和 `5xx` 仍返回 `5xx`，由 Telegram 重试。
- Telegram 无法解析的 Markdown 回复会以纯文本重发一次。
- 私聊用户拉黑 Bot（回复时收到 `403 bot was blocked by the user`，或 `my_chat_member` 状态为 `kicked`）时，对应订阅只停用一次并写入 `telegram_target.auto_disabled` 审计；解除拉黑不会自动恢复启用。

## 通知订阅与 Telegram 权限

用户在私聊中发送 `/start` 时，系统幂等创建一条默认停用的 `private` 通知订阅。订阅自动保存 Telegram User ID、用户名、显示名称和语言，等待管理员审核。

Bot 加入群组、超级群组或频道时，`my_chat_member` 自动创建默认停用的订阅；超级群组统一记为 `group`。Bot 被移除或踢出时订阅自动停用，重新加入不会自动恢复启用状态。

管理员也可以手动新建订阅，并填写名称、Bot、目标类型、目标 ID、语言、事件和六语言模板内容。

每条订阅只有一个启用开关：

- 私聊订阅同时控制通知、Inline 下单、Inline 报价、查单和“我已付款”检查；
- 群组和频道订阅控制通知发送；
- 关闭的私聊订阅不能授权 Telegram 订单操作；未绑定用户在 Inline 中只会看到一条“未绑定”提示，不会收到报价。

GMPay Edge 是单租户部署，启用私聊订阅是运营者的信任决策：该 Telegram 用户可以按订单号或外部订单号查询实例内任意订单，并通过 Inline 创建订单。只为运营人员启用私聊订阅。

## 模板内容

不设独立消息模板目录。每条通知订阅和每条指令直接拥有 `en-US`、`ja-JP`、`ko-KR`、`ru-RU`、`zh-TW`、`zh-CN` 六语言内容。默认订阅设置保存自动发现目标使用的默认事件和默认六语言通知内容。

内容使用 Telegram Markdown，只允许文档化的非敏感变量：

- `{{orderId}}`、`{{externalOrderId}}`、`{{status}}`；
- `{{amount}}`、`{{currency}}`；
- `{{payment.amount}}`、`{{payment.asset}}`、`{{payment.network}}`。

发送时按订阅语言、`en-US`、内置安全格式回退，内置格式的标签使用本地化的 Paraglide 文案。动态变量值会被转义，失败审计不会记录消息正文、Token 或 Secret。

### 发送方式

订单通知在订单事件提交后发出，并在请求路径之外执行：Workers 通过 `waitUntil`，Bun 通过进程内后台任务集合。结账、商户和服务商回调响应不会等待 Telegram。队列消费者和 Cron 没有 `waitUntil`，会内联等待发送完成。

每次发送对每个 Bot 的 Token 只解密一次，最多同时向四个订阅发送，并遵守 Telegram 流控：收到带 `retry_after` 的 `429` 时最多重试两次，且等待时间必须在发送预算内。每个失败的订阅都会写入 `telegram.delivery_failed` 审计，包含事件类型和稳定错误码（如 `telegram_api_rejected_403`、`telegram_transport_error`）。除流控重试外没有持久化重试；拉黑 Bot 的订阅会自动停用。

## 指令与 Inline

实例初始化 `/start`、`/help`、`/new`、`/status`。四条内置指令的处理行为由系统固定；管理员新建的指令统一回复其六语言内容，不需要选择“处理方式”。指令以 `command + scope` 唯一，可同步到单个或全部 Bot。

“后台 → Telegram → 指令”中的“补齐缺失的默认项”（权限 `telegram:update`）为已有部署执行 reconcile：补回被删除的内置指令、缺失的语言回复和缺失的默认通知内容，不覆盖管理员编辑，报告补齐条目数，并写入 `telegram.defaults_reconciled` 审计。补齐后请使用“同步指令”推送到 Telegram。

Telegram 只接受一个 `zh` 语言代码，因此简体与繁体客户端都同步 `zh-CN` 的指令描述；`zh-TW` 描述仅用于 GMPay Edge 自身的回复。

Inline 草稿不会预占收款方式；只有 Telegram 返回 `chosen_inline_result` 且对应私聊订阅已启用时才创建订单。“我已付款”只请求一次幂等的适配器扫描，不会直接把订单标记为已支付。

自动化质量门不会访问 Telegram。生产发布需人工验证最终 HTTPS Webhook、自动目标发现、订阅审核、Inline 权限、六语言内容、指令同步、Token 轮换和脱敏失败审计。
