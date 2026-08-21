# GMPay Edge 部署检查清单

简体中文 · [English](../en-US/DEPLOYMENT.md)

本清单用于将一个单租户 GMPay Edge 实例部署到 Cloudflare Workers 或 Node/Nitro。
运营人员统一使用 `/admin`；商户只通过
带签名的 GMPay 主协议或其 EPay 边界适配接入。

## 部署方式

### 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/GMWalletApp/gmpay-edge)

引导流程会复刻仓库并配置 Workers Builds，使用按钮时源仓库必须公开。Build command 配置为 `bun run build`，Deploy command 配置为 `wrangler deploy`。构建命令会精确复用同名 D1、KV、R2 和 Queue，只创建缺失资源；应用 D1 基线后，生成包含已解析 D1/KV ID 的 Vite 产物，整个过程不改写可移植的源码 `wrangler.jsonc`。部署完成后访问 Worker 地址的 `/install`。

### Wrangler CLI

完成 Wrangler 登录后执行 package 部署命令。`predeploy` Hook 会精确复用同名 D1、KV、R2 和 Queue，只创建缺失资源；随后应用 D1 基线，并在发布前生成已解析绑定的 Vite 产物：

```bash
bun install
bunx wrangler login
bun run deploy
```

必要时可以先执行 `bunx wrangler d1 create gmpay-edge`，再执行
`bun run db:migrate:remote` 手动准备 D1；生成的数据库 ID 不写入可移植源码配置。

### Node 与 Docker

完成下述一次性可见性设置后，拉取公开 GHCR 镜像并使用仓库内的 Compose 配置：

```bash
docker compose pull
docker compose up -d
```

镜像支持 `linux/amd64` 与 `linux/arm64`。唯一面向用户的环境变量是
`GMPAY_DATA_DIR`；随附 Compose 将其设为 `/var/lib/gmpay`，并用具名卷持久化整个
目录。不要通过容器环境变量传递 Origin、Allowed Hosts、邮件凭据或应用密钥。

`GET /healthz` 成功后，通过外部可访问 URL 打开 `/install`，创建 root 用户前确认
检测到的 Origin 和 Allowed Hosts。多个服务商统一在一级菜单“后台 → 邮件配置”
中排序维护。Node 与 Workers 显示相同的 Resend、Postmark、SendGrid、Mailgun、
SMTP 和 Cloudflare Email；后者仅在 `EMAIL` binding 可用时投递。SMTP 的 465
端口使用隐式 TLS，587 端口使用
STARTTLS；拒绝 25 端口和非公网主机。

从源码构建 Node 产物使用 `bun run build:node`。Workers 命令保持完全不变，继续
使用 Cloudflare Vite 适配器。备份、恢复和 D1/R2 迁入请遵循
[Node 数据运维](NODE_DATA_OPERATIONS.md)，并使用仓库维护的 `data` package script
及其 `backup`、`restore` 和 `import-cloudflare` 子命令。

## Cloudflare 资源

- [ ] 在“后台 → 邮件配置”至少配置一个服务商。使用 Cloudflare Email 时，将 Email Routing 绑定为 `EMAIL` 并确认该 Workers 专用类型出现；实际发送找回邮件并确认 15 分钟链接可用。投递不可用时登录页仍统一返回通用响应。
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
- [ ] 完成 `/install`，生成认证/签名值和默认支付目录，确认检测到的 Origin，将其写入应用地址与 Allowed Hosts，并确认自动登录后台。
- [ ] 打开“忘记密码”，接收 15 分钟一次性链接并完成重置，确认旧 Session 无法继续认证。
- [ ] 在“后台 → 系统设置 → 认证配置 / 密钥管理”中核对生产 HTTPS Origin，并随 D1 安全备份 `runtime.better_auth_secret`。
- [ ] 按[支付配置](PAYMENT_METHODS.md)配置计划启用的支付方式；交易所只使用只读凭证，并核对资产标识和精度。
- [ ] 配置加密资产与法币汇率同步；在各自设置弹窗中先执行一次“立即执行”，核对原始/最终汇率，再确认每分钟 Cron 遵循每类的自动同步开关和保存周期。

## Node 资源

- [ ] 确认容器以非 root 用户运行，持久化目录仅允许预期的宿主机/容器身份写入。
- [ ] 安装并完成测试上传/订单后，确认卷中包含 `gmpay.sqlite`、私有对象和可靠队列状态。
- [ ] 配置 Node 支持的邮件服务商并测试密码找回；确认服务商列表与 Workers 一致，容器环境中没有邮件 Secret。
- [ ] 重启容器，确认排队中的 Webhook/支付任务和定时任务恢复，且不会重复入账或投递。
- [ ] 停止容器，使用 `bun run data -- backup` 备份到外部路径，再用 `bun run data -- restore` 恢复到新数据目录；校验清单、SQLite 完整性、migration 校验和、登录及私有对象访问。
- [ ] 从 Workers 迁移时，针对明确的 D1 SQL 与可选 R2 导出路径执行 `bun run data -- import-cloudflare`；只导入全新或空目标，随后重新完成签名订单和回调验收。

## 自动发布

semantic-release 会在两个发布通道的质量门通过后运行。`alpha` 从
`1.0.0-alpha.1` 开始，只发布完整版本和滚动 `alpha` 容器标签；验证后合并到
`main`，再发布稳定 `1.0.0` 以及 major、minor、`latest` 标签。它会更新
`package.json` 和 `bun.lock`、创建带自动生成说明的 GitHub Release 与 tag，再调用
独立的 Docker smoke 与多架构发布工作流。稳定镜像及其 provenance 发布成功后，
匹配的 `vX.Y.Z-alpha.N` GitHub 预发布记录、远程 Git tag 与 `X.Y.Z-alpha.N` GHCR
镜像版本会被自动删除。

首次镜像发布后，仓库所有者必须在 GitHub Package settings 中将 `gmpay-edge`
可见性一次性设为 **Public**。工作流不会也不应自动修改 package 可见性。

## 发布门槛

- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] `bun run check`
- [ ] `bun run build`
- [ ] `bun run build:node`
- [ ] 打开登录页，确认未初始化部署会引导到 root 用户初始化。
- [ ] 创建并启用计划使用的支付方式、接入配置和收款方式；开发模拟能力不得误用于生产。
- [ ] 验证零绑定的 `GET/HEAD /healthz`、详细 `/status`、初始化、登录，以及目标支付通道上的一笔签名 GMPay 完整订单。
- [ ] 确认商户回调目标为公共 HTTPS；供应商与 Telegram 入站路径校验各自签名；GMPay/EPay 出站签名与文档一致。
- [ ] 确认仓库未跟踪 `.dev.vars`、私钥、助记词、商户 Secret 或 Cloudflare Token。
- [ ] 对选定生产运行时执行 smoke；发布时从 GitHub Release 核对 GHCR 镜像 digest 与两种架构。
- [ ] 首次容器发布后，将 GitHub Package 可见性设为 **Public**，并验证未登录拉取。
