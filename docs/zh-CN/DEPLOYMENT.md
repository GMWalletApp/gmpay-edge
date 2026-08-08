# GMPay Edge 部署检查清单

简体中文 · [English](../en-US/DEPLOYMENT.md)

本清单用于部署一个单租户 GMPay Edge 实例。运营人员统一使用 `/admin`；商户只通过
带签名的 GMPay 主协议或其 EPay 边界适配接入。

## 部署方式

### 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/GMWalletApp/gmpay-edge)

引导流程会复刻仓库并配置 Workers Builds，使用按钮时源仓库必须公开。Build command 配置为 `bun run build`，Deploy command 配置为 `wrangler deploy`。构建命令会创建或复用具名 D1、R2 和 Queue 资源，应用 D1 基线后再生成 Vite 产物；部署时 Cloudflare 关联 `wrangler.jsonc` 中不含账号 ID 的绑定，整个过程不改写源码配置。部署完成后访问 Worker 地址的 `/install`。

### Wrangler CLI

完成 Wrangler 登录后执行 package 部署命令。`predeploy` Hook 会创建或复用具名 D1、R2 和 Queue 资源，通过 `DB` 应用 D1 基线，并在发布前生成 Vite 产物：

```bash
bun install
bunx wrangler login
bun run deploy
```

必要时可以先执行 `bunx wrangler d1 create gmpay-edge`，再执行
`bun run db:migrate:remote` 手动准备 D1；生成的数据库 ID 不写入可移植源码配置。

## Cloudflare 资源

- [ ] 如需启用密码找回，在 Cloudflare Email Service 中启用发件域名，为已部署 Worker 添加名为 `AUTH_EMAIL` 的 `send_email` 绑定，并在“后台 → 系统设置 → 认证配置”保存发件地址。未配置这一可选绑定时，登录页仍统一返回通用响应。
- [ ] 确认 Workers 构建创建或复用 `gmpay-edge` D1 数据库，并将其关联为 `DB`。
- [ ] 完成一次构建，确认 Wrangler 的 `assets.directory` 发布 `dist/client`；静态文件由 Cloudflare 平台资产处理提供，不向应用代码暴露 `ASSETS` 绑定，应用和 API 路由继续进入 Worker。
- [ ] 确认部署日志读取 `dist/server/wrangler.json`，其中 `main` 为 `index.js` 且 `no_bundle` 为 `true`；Wrangler 不得重新打包 `src/server-entry.ts`，也不得再出现 `#tanstack-router-entry` 或 `#tanstack-start-entry` 无法解析。
- [ ] 确认 Workers 构建创建或复用私有 R2 Bucket `gmpay-edge-files` 并关联为 `FILES`；为付款复核凭证配置生命周期策略，凭证只能通过需要登录的 Worker 路由访问。
- [ ] 确认 Workers 构建创建或复用 `gmpay-edge-cache` KV Namespace，并将其关联为 `CACHE`。
- [ ] 验证具有 `audit:create` 权限的用户可以导出审计日志；R2 的 `exports/audit-logs/` 中应出现 NDJSON 文件，结构化敏感字段必须脱敏，导出行为本身也必须被审计。
- [ ] 使用公共 HTTPS `notify_url` 创建签名测试订单，验证 GMPay JSON 与 EPay Query 回调签名；手动重发通知后应保留一条新的投递记录。
- [ ] 修改测试 RPC 凭证后，确认节点自动停用且旧健康结果被清除；重新测试成功后才能启用。
- [ ] 停用某资产最后一个可用收款方式，确认它立即从公共/API 资产目录消失；目标和接入重新验证通过后再启用。
- [ ] 修改 Binance、OKX 或 OKPay 收款方式的只读账户配置，确认新账户身份与访问验证通过前该收款方式保持停用。
- [ ] 使用一个故意不可用的数据源执行“同步汇率”，确认其他汇率仍可更新，失败项保留原过期时间，审计摘要不保存供应商响应正文。
- [ ] 为测试角色仅授予 `operations:read`，确认它只能查看健康状态；授予 `operations:update` 后分别测试每个有界运维任务。
- [ ] 轮换测试 Telegram Bot Token，确认原订阅保留、新 Bot 使用 secret-token Webhook，旧 Token 已撤销或旧 Webhook 已删除。
- [ ] 确认 Workers 构建创建或复用 `gmpay-edge-webhooks`、`gmpay-edge-webhooks-dlq`、`gmpay-edge-payments`、`gmpay-edge-payments-dlq` 四个 Queue；生产者分别关联为 `WEBHOOK_QUEUE` 和 `PAYMENT_QUEUE`。
- [ ] 同一版本部署 Queue 生产者与消费者；消息必须使用显式的 `webhook.delivery`、`payment.scan` 或 `payment.provider_event` 类型以及 `version: 1`。
- [ ] 每个已启用的 Alchemy 事件源使用专用 Address Activity Webhook；核对复制的 HTTPS 回调 URL 与 Allowed Host，并确认只有远端类型、网络、URL、启用状态和地址都通过对账后才报告健康。
- [ ] 在启用入账前完成一次 Alchemy 影子模式低价值演练；检查供应商事件记录，演练一次符合条件的手动重试，并确认重复或内容变化的投递不能创建额外支付事件。
- [ ] 保持 Worker 崩溃时的 Queue 重试/DLQ 策略；应用级 Webhook 尝试由 D1 独立持久化和调度。
- [ ] 确认 `bun run deploy` 创建或复用 `gmpay-edge`，并在发布前应用 D1 基线；`bun run db:migrate:remote` 仅用于明确的“仅数据库”操作。
- [ ] 完成 `/install`，生成认证/签名值和默认支付目录，将当前 Origin 写入应用地址与 Allowed Hosts，并确认自动登录后台。
- [ ] 打开“忘记密码”，接收 15 分钟一次性链接并完成重置，确认旧 Session 无法继续认证。
- [ ] 在“后台 → 系统设置 → 认证配置 / 密钥管理”中核对生产 HTTPS Origin，并随 D1 安全备份 `runtime.better_auth_secret`。
- [ ] 按[支付配置](PAYMENT_METHODS.md)配置计划启用的支付方式；交易所只使用只读凭证，并核对资产标识和精度。
- [ ] 配置加密资产与法币汇率同步；在各自设置弹窗中先执行一次“立即执行”，核对原始/最终汇率，再确认每分钟 Cron 遵循每类的自动同步开关和保存周期。

## 发布门槛

- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] `bun run check`
- [ ] `bun run build`
- [ ] 打开登录页，确认未初始化部署会引导到 root 用户初始化。
- [ ] 创建并启用计划使用的支付方式、接入配置和收款方式；开发模拟能力不得误用于生产。
- [ ] 验证零绑定的 `GET/HEAD /healthz`、详细 `/status`、初始化、登录，以及目标支付通道上的一笔签名 GMPay 完整订单。
- [ ] 确认商户回调目标为公共 HTTPS；供应商与 Telegram 入站路径校验各自签名；GMPay/EPay 出站签名与文档一致。
- [ ] 确认仓库未跟踪 `.dev.vars`、私钥、助记词、商户 Secret 或 Cloudflare Token。
