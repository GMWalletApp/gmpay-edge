# GMPay Edge 部署检查清单

简体中文 · [English](../en-US/DEPLOYMENT.md)

本清单用于将一个单租户 GMPay Edge 实例部署到 Cloudflare Workers 或 Bun/Nitro。
运营人员统一使用 `/admin`；商户只通过
带签名的 GMPay 主协议或其 EPay 边界适配接入。

## 部署方式

### 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/GMWalletApp/gmpay-edge)

引导流程会复刻仓库并配置 Workers Builds，使用按钮时源仓库必须公开。Build command 配置为 `bun run build`，Deploy command 使用自动检测的 `bun run deploy`。构建命令会精确复用同名 D1、KV、R2 和 Queue，只创建缺失资源；应用 D1 基线后，生成包含已解析 D1/KV ID 的 Vite 产物。部署生命周期在 Workers Builds 中不会重复构建，只上传该产物；整个过程不改写可移植的源码 `wrangler.jsonc`。部署完成后访问 Worker 地址的 `/install`。

### Wrangler CLI

完成 Wrangler 登录后执行 package 部署命令。`predeploy` Hook 会精确复用同名 D1、KV、R2 和 Queue，只创建缺失资源；随后应用 D1 基线，并在发布前生成已解析绑定的 Vite 产物：

```bash
bun install
bunx wrangler login
bun run deploy
```

必要时可以先执行 `bunx wrangler d1 create gmpay-edge`，再执行
`bun run db:migrate:remote` 手动准备 D1；生成的数据库 ID 不写入可移植源码配置。

### Bun 与 Docker

公开的 [GHCR Package](https://github.com/orgs/GMWalletApp/packages/container/package/gmpay-edge)
支持 `linux/amd64` 与 `linux/arm64`，无需登录 Registry。

| 标签 | 推荐用途 |
| --- | --- |
| `latest` | 最新稳定版 |
| `1.0.0` | 用于可复现部署的固定版本 |

#### Docker Compose

将以下内容保存为 `compose.yml`：

```yaml
services:
  gmpay-edge:
    image: ghcr.io/gmwalletapp/gmpay-edge:latest
    restart: unless-stopped
    # 明文 HTTP，供同一主机上的反向代理使用；参见“反向代理与 TLS”。
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      GMPAY_DATA_DIR: /var/lib/gmpay
    volumes:
      - gmpay-data:/var/lib/gmpay

volumes:
  gmpay-data:
```

```bash
docker compose pull
docker compose up -d
```

#### Docker 命令

无法使用 Compose 时，可以直接运行容器：

```bash
docker volume create gmpay-data
docker run --detach --name gmpay-edge --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  --env GMPAY_DATA_DIR=/var/lib/gmpay \
  --volume gmpay-data:/var/lib/gmpay \
  ghcr.io/gmwalletapp/gmpay-edge:latest
```

#### 反向代理与 TLS

容器只提供明文 HTTP，上面的示例也只把端口发布到宿主机的回环地址。生产流量必须经由
同一主机或内网中终止 TLS 的反向代理进入，或者由 Bun 自身终止 TLS。

GMPay Edge 以每个连接的 TCP 对端地址推导客户端地址。当对端是回环、私有或链路本地
地址（`127.0.0.0/8`、`::1`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、
`169.254.0.0/16`、`fc00::/7`、`fe80::/10`）时，`X-Forwarded-For` 最右侧的一跳成为
客户端地址，`X-Forwarded-Proto: https` 将请求标记为 HTTPS，从而启用 HSTS 与安全
Cookie。来自其他对端的转发头一律丢弃，入站的 `cf-connecting-ip` 始终被覆盖，因此
客户端无法伪造按 IP 的限流与审计记录。代理必须：

- 保留原始 `Host` 头，Allowed Hosts 会校验它；
- 将 `X-Forwarded-Proto` 设置为面向客户端的协议（覆盖而非追加）；
- 把连接方地址追加到 `X-Forwarded-For`；
- 当 Cloudflare 等 CDN 位于代理之前时，把真实客户端地址放在最右侧（例如 nginx 使用
  `set_real_ip_from` 配置 CDN 网段并设置 `real_ip_header CF-Connecting-IP`），否则
  所有访问者都会共享 CDN 地址。

Caddy 默认满足以上全部要求：

```caddyfile
pay.example {
    reverse_proxy 127.0.0.1:3000
}
```

nginx：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

如需不经代理直接由 Bun 终止 TLS，将 `NITRO_SSL_CERT` 与 `NITRO_SSL_KEY` 指向 PEM
文件路径（或 PEM 内容）并直接发布端口；此时所有对端都视为公网，其 socket 地址即
客户端地址。

`HOST`、`PORT` 和 `NODE_ENV` 是镜像内置的 Nitro 服务变量（`0.0.0.0`、`3000`、
`production`），与 `NITRO_SSL_CERT`/`NITRO_SSL_KEY` 一样只影响监听方式。产品行为只由
`GMPAY_DATA_DIR` 和需要登录的后台设置决定。

#### 首次安装

等待 `GET /healthz` 成功后，通过公网地址打开 `/install`。创建首位 root 用户前，
确认检测到的地址和 Allowed Hosts。应用、安全和邮件设置均在后台维护，不要将其
添加为容器环境变量。

`GMPAY_DATA_DIR` 指向持久化目录，其中包含 SQLite、上传文件、私有对象、队列状态和
全部运行数据。更新或重新创建容器时，必须备份并保留该具名卷。

#### 常用命令

使用以下命令检查和维护 Compose 部署：

```bash
curl --fail http://127.0.0.1:3000/healthz
docker compose ps
docker compose logs --follow gmpay-edge
docker compose pull
docker compose up -d
```

最后两条命令会更新所选标签并重新创建容器，同时保留具名卷。

从源码构建 Bun 产物使用 `bun run build:bun`。Workers 命令保持完全不变，继续
使用 Cloudflare Vite 适配器。备份、恢复和 D1/R2 迁入请遵循
[Bun 数据运维](NODE_DATA_OPERATIONS.md)，并使用仓库维护的 `data` package script
及其 `backup`、`restore` 和 `import-cloudflare` 子命令。

## Cloudflare 资源

- [ ] 在“后台 → 邮件配置”至少配置一个服务商。使用 Cloudflare Email 时，将 Email Routing 绑定为 `EMAIL` 并确认该 Workers 专用类型出现；实际发送找回邮件并确认 15 分钟链接可用。投递不可用时登录页仍统一返回通用响应。SMTP 通道在 465 端口使用隐式 TLS；其他端口会先探测 `EHLO`，服务器未宣告 `STARTTLS` 时拒绝投递，凭据与邮件内容不会以明文传输，证书校验不可关闭。服务商支持时优先使用 465 端口。
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

## Cloudflare 上的延迟

每条 D1 语句都是一次到数据库主区域的网络往返，因此 Workers 上的请求延迟取决于串行执行的语句数量，以及
Worker 与 D1 之间的距离。已认证的管理端调用会并行执行 Allowed Hosts 设置读取与 Better Auth 会话查询，
然后再执行自身查询；结账页只用一次汇率读取为全部支付选项报价。剩余差距由三项检查收敛：

- **Smart Placement。** `wrangler.jsonc` 已启用，但 Cloudflare 需要观察到流量后才会生效。请在 Workers &
  Pages → 该 Worker → Settings → Placement 中确认状态显示 Smart Placement 已激活，使 Worker 运行在 D1
  主库附近。
- **D1 读复制。** 在 D1 → 该数据库 → Settings → Read replication 中（或通过 REST API）为数据库启用一次。
  之后列表、仪表盘、运营视图与结账读取会在一个可能由 Worker 附近副本提供服务的会话上执行；授权、设置与所有
  写入仍走主库。变更请求的响应会设置 `gmpay_d1_bookmark` cookie（HttpOnly，五分钟），使同一浏览器随后的读取
  至少锚定在该次写入之后。未启用读复制时该会话回落到主库，行为不变。
- **先测量再调优。** 每个响应都带有 `Server-Timing` 响应头，包含 `authority`（设置读取）、`session`（Better
  Auth 查询）、`rbac`（权限缓存）、`app` 与 `total`，单位为毫秒。结合 D1 指标页（查询延迟、读取行数）判断
  对你的用户而言哪一段占主导，再决定是否更换区域或增加缓存。

## Bun 资源

- [ ] 确认容器以非 root 用户运行，持久化目录仅允许预期的宿主机/容器身份写入。
- [ ] 安装并完成测试上传/订单后，确认卷中包含 `gmpay.sqlite`、私有对象和可靠队列状态。
- [ ] 配置 Bun 支持的邮件服务商并测试密码找回；确认服务商列表与 Workers 一致，容器环境中没有邮件 Secret。
- [ ] 重启容器，确认排队中的 Webhook/支付任务和定时任务恢复，且不会重复入账或投递。
- [ ] 停止容器，使用 `bun run data -- backup` 备份到外部路径，再用 `bun run data -- restore` 恢复到新数据目录；校验清单、SQLite 完整性、migration 校验和、登录及私有对象访问。
- [ ] 从 Workers 迁移时，针对明确的 D1 SQL 与可选 R2 导出路径执行 `bun run data -- import-cloudflare`；只导入全新或空目标，随后重新完成签名订单和回调验收。

## 自动发布

每次推送到 `main` 都会运行质量门；随后 semantic-release 按 Conventional Commits
判断是否发布 `1.0.0` 这样的稳定版本，不存在预发布通道。发布会更新 `package.json`
和 `bun.lock`、创建带自动生成说明的 GitHub Release 与 tag，再调用独立的 Docker
smoke 与多架构发布工作流。原生 x64 与 Arm64 runner 会并行构建并 smoke 各自平台
镜像，再组装发布 manifest，写入精确版本以及滚动的 major、minor 与 `latest` 标签。
依赖范围均为 caret，因此发布步骤的 lockfile-only 安装只记录新的包版本，不会重新
解析依赖。Pull Request 由 `CI` 工作流运行同一质量门。

`gmpay-edge` GHCR Package 已公开；发布验收只需验证未登录拉取，无需再执行一次性
可见性修改。

## 发布门槛

`bun run typecheck` 会先生成 Paraglide 消息，因此该清单可在全新 clone 上复现；
`CI` 工作流对每个 Pull Request 和 `main` 推送运行同样的五条命令。

- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] `bun run check`
- [ ] `bun run build`
- [ ] `bun run build:bun`
- [ ] 打开登录页，确认未初始化部署会引导到 root 用户初始化。
- [ ] 创建并启用计划使用的支付方式、接入配置和收款方式；开发模拟能力不得误用于生产。
- [ ] 验证零绑定的 `GET/HEAD /healthz`、详细 `/status`、初始化、登录，以及目标支付通道上的一笔签名 GMPay 完整订单。
- [ ] 确认商户回调目标为公共 HTTPS；供应商与 Telegram 入站路径校验各自签名；GMPay/EPay 出站签名与文档一致。
- [ ] 确认仓库未跟踪 `.dev.vars`、私钥、助记词、商户 Secret 或 Cloudflare Token。
- [ ] 对选定生产运行时执行 smoke；发布时从 GitHub Release 核对 GHCR 镜像 digest 与两种架构。
- [ ] 验证无需登录即可拉取公开的 GHCR 镜像。
