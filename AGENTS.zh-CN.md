# GMPay Edge 工程契约

[English](AGENTS.md) · 简体中文

本文件只维护长期稳定、可提交的产品与工程规则。本地执行计划和证据保持忽略。
每个目标必须明确选择本次清单范围；旧清单或无关清单不得自动成为当前任务。

## 1. 产品边界

- 产品、package、Worker、Node 服务和数据库统一为 `GMPay Edge` / `gmpay-edge`。
- GMPay Edge 是单部署、单租户支付网关。商户只表示外部 API 接入方；内部授权基于
  用户和角色。
- 内部运营统一使用 `/admin`。GMPay 是主商户协议；EPay 只在边界适配到同一订单服务。

## 2. 技术栈与源码归属

- 使用 Bun、严格 TypeScript、React 19、TanStack Start/Router/Query/Table/Form、
  Tailwind CSS 4、shadcn/Radix、Zod、Better Auth、Drizzle、Cloudflare Workers
  （D1、KV、R2、Queues、Cron）、Node.js + Nitro + SQLite、grammY、Paraglide、
  Vitest、Biome 和 Wrangler；Docker 是受支持的 Node 分发方式。
- 禁止引入第二套路由、认证、ORM/数据库层、表单、客户端/服务端缓存、格式化、
  lint 或国际化运行时。
- 领域与运行时归属以 `routes`、`features`、`integrations`、`components`、
  `layouts`、`db`、`lib`、`stores` 和 `server` 为主；框架支持继续使用现有
  `assets`、`context`、`hooks`、`paraglide` 和 `styles`，不得为普通 feature
  代码增加新的顶层层级。
- feature 负责页面、schema、Server Fn、类型和领域行为。route 只负责参数/search、
  loader、鉴权、Request/Response 转换和页面挂载。
- 外部支付适配器固定在 `src/integrations/{chains,exchanges,wallets}`；跨领域运行时
  基础设施放在 `src/server`，领域服务不得放进去。
- 页面表单和表格跟随语义页面。通用表单/表格基础保留在现有 `ui`、`pro`、
  `crypto-icons` 边界；可复用应用壳层可继续位于 `header` 和 `public`。没有具体缺陷
  不得重构大型 `ProTable` 或 `ProForm` 基础。
- 布局使用 `src/layouts/{public,auth,install,dashboard,settings,components}`；Drizzle
  schema 使用 `src/db/schema/{auth,access,payments,webhooks,telegram,settings}.ts`。
- 测试位于 `tests/{unit,integration,security,e2e,fixtures,helpers}`。交付文档保持英文与
  简体中文成对维护；被忽略的本地计划和证据文件不提交。

## 3. 代码质量、简化与风格

- 完成非简单功能、重构或性能优化后，在最终验证前对本次触及 diff 执行保持行为
  不变的代码简化复审。必须保持项目边界，不得为了减少行数扩大范围或格式化无关
  文件；审查后确认无需修改同样是有效结果。
- 以净简化为目标。增加抽象前先删除重复分支、样板、中转层、死状态和死导出。
- 默认就地放置，遵循 YAGNI/Rule of Three。只有至少两个真实调用方共享稳定语义
  且很可能出现第三个，或安全、事务、协议、持久化、单位边界需要独立测试时才抽离。
- 禁止为营造架构感创建通用 `utils`、`services`、`repositories`、`managers`、
  纯转发包装或多余 barrel。新 helper 必须让调用方更短、更直接、更不易误用。
- 不可信输入只在边界用 Zod 或同等明确 parser 校验一次。领域代码信任已建立类型
  与不变量，不在每层重复 trim、parse、判空或猜测性防御。
- 只判断真实可能发生且有明确恢复/失败策略的状态。优先早返回和直接控制流，避免
  深层嵌套、布尔体操、嵌套三元及为未知未来准备的 fallback 链。
- 保持严格类型。禁止向领域代码扩散宽泛 `any`、连续断言、未解析 KV JSON、服务商
  原始响应、URL search、Queue envelope 或浮点金额；边界收窄后使用明确单位命名。
- 使用结构化领域错误，在 HTTP/API 边界统一映射。禁止依赖不稳定错误文案判断，
  也不得向用户暴露 SQL、堆栈、密钥、服务商敏感原文或内部 reference。
- 社区基线采用 TypeScript `strict`、Biome 稳定 recommended、Rules of React 及
  适用的 OWASP ASVS/API Security 控制。更严格规则先审计后启用，不盲开不稳定
  规则，也不制造大规模纯风格修改。
- React 组件与 Hook 必须纯净，副作用不进入 render；props、state、Hook 输入和
  JSX 值视为不可变。先让 React Compiler 优化，不增加猜测性 memo。
- Biome 是唯一格式化/import 排序工具，只格式化触及文件。文件沿用 kebab-case，
  值/函数 camelCase，组件/类型 PascalCase，领域术语保持稳定，单位使用 `Ms`、
  `Minor`、`Units`、`Bps`、`Bytes` 后缀。
- 注释解释不变量和平台取舍，不复述语法。lint/type 问题修复根因，禁止压制规则或
  跳过测试制造通过。
- 删除代码必须按风险提供 `rg`、类型检查、测试和生产构建证据；废弃路由、测试、
  依赖、导出和空目录同步删除。

## 4. 认证、RBAC 与鉴权缓存

- Better Auth 负责用户、credential account、Session、密码和 TOTP；项目 RBAC
  负责动态角色、用户角色、权限模块和权限位。
- 安装首位用户绑定受保护内置 `root`。root 不可编辑或删除；最后一个启用 root
  不得禁用、删除或移除 root。
- 新部署实例由运营者通过公开安装流程自行初始化是既定产品行为。安装事务必须保持
  单次执行，并在首位 root 用户提交后关闭安装入口。
- TOTP 为可选功能；启用后由 Better Auth 恢复码承担 TOTP 恢复。密码恢复使用短时、
  一次性邮件链接，对外返回统一响应，并在重置后撤销已有 Session。
- 有效权限是全部启用角色的并集，不存在当前角色或路由驱动授权状态。
- 基础位为 `read/create/update/delete = 1/2/4/8`，扩展从 `16` 起；数据库按
  角色×模块只保存一个整数 `permission_mask`。
- 权限模块和权限位是独立只读注册表。用户只能配置角色，不能修改代码定义的模块
  ID 或位位置。
- 每个服务端入口校验 Better Auth Session、用户启用状态和结构化
  `{ module, permissionMask }`。未知路由/权限失败关闭，客户端隐藏不能替代服务端。
- 侧栏、命令菜单、模块导航和默认入口共享同一份权限过滤权威数据。
- RBAC 派生结果只有在当前 Better Auth 用户读取返回的权威修订号保护下才可缓存。
  角色/权限 mutation 必须在同一数据库事务或 batch 推进受影响用户修订号；缓存
  delete 或 TTL 不能单独决定授权或撤权。
- 缓存缺失、损坏或版本不符时回源权威数据库；数据库或解析失败必须拒绝访问。
  解密凭证和 Session token 不得进入 RBAC 缓存 key/value。

## 5. 支付模型、单位与状态

- “支付方式”是内置链/交易所/钱包能力目录，不是业务启停开关。
- “连接配置”只保存公共 RPC/API、HTTPS/WSS、优先级、健康和故障转移，不保存
  UID、API Key、Secret、Passphrase、商户 ID、私钥或助记词。
- 内置 HTTPS 连接默认启用用于评估；WSS 默认停用且优先级为 `200`。链上可用仍
  要求健康连接；交易所/钱包公共连接不决定商户暴露。
- “收款方式”保存具体只读账户/目标配置，可绑定多个资产，是运营人员控制收银台
  暴露的入口。禁止保存提现权限、私钥或助记词。
- 汇率分加密与法币，保存原始汇率、调整后汇率和同步时间；USDT/USD、USDC/USD
  固定为 1:1 基准。
- 法币金额使用带 decimals 的 `*_minor` 十进制整数字符串；资产金额使用带 asset
  decimals 的 `*_units` 十进制整数字符串。计算使用 bigint，禁止浮点金额。
- 绝对时间/时长使用毫秒（`*_at`、`*_ms`），调整使用基点（`*_bps`），文件大小
  使用字节（`*_bytes`）；换算只发生在 API、适配器、迁移或 UI 边界。
- 订单状态转换、支付入账、审计和 Webhook outbox 必须集中、原子/幂等，并覆盖少付、
  多付、迟付、重复、失败、确认变化、重组、重试和退款。

## 6. 商户 API、Webhook 与外部适配

- GMPay 与 EPay 共用订单服务、幂等模型、状态机、收银台、查询、回调和手动重试。
- 签名、scope、解析、归属和限流在边界校验。会改变状态或产生外部副作用的操作必须
  防重放；只读 GMPay/EPay 状态查询保持协议兼容并限流，不凭空增加 nonce 字段。
  当前运行时的权威数据库继续承担原子限流；最终一致缓存不决定安全限额。
- Webhook 端点使用实例内相对路径；部署 host 属于 Allowed Hosts/安全设置。回调
  地址来自商户订单输入，并通过 SSRF 与重试策略校验。
- Webhook event、delivery、attempt、Queue message、锁和手动重试保持幂等可审计；
  已提交 outbox 不能因 Worker 响应结束或部分服务商失败而丢失。
- 链、Binance、OKX、OKPay 适配器具备有界超时、类型校验、确定性签名、错误脱敏、
  分页/cursor 和只读凭证说明。WSS 还要有生命周期、重连退避、回执校验、去重和
  HTTP 恢复。

## 7. Telegram

- Telegram Bot API 全部使用 grammY，禁止拼接 API URL 或维护第二套客户端。
- 指令是不含 `bot_id` 的实例公共目录，键为 `command + scope`。指令和通知订阅
  直接拥有六语言模板内容，不设独立消息模板目录。
- Bot 只拥有 token、username、Webhook secret、启用状态和 Telegram 连接；通知
  订阅保留真实 Bot 归属。
- `/start` 幂等创建默认停用的私聊订阅，等待管理员审核；唯一启用状态同时控制通知
  和 Telegram 订单操作。
- 安装/reconcile 在无 Bot 时初始化四条含六语言回复的指令及 Telegram 通知默认值，
  不创建 Bot、不调用 Telegram，只补缺失项且保留管理员修改。
- 模板 fallback 为目标语言、`en-US`、内置安全格式；模板使用 Markdown 和已文档化
  的非敏感变量。
- 指令可同步单个或全部 Bot，并逐 Bot 返回结果；一个失败不能隐藏其他结果。

## 8. UI、导航与国际化

- 公开、登录、安装、后台和收银台共享站点名称/Logo、设计 token、明暗主题、响应式
  布局和可访问控件。
- 主导航表达稳定领域；模块内部使用语义子路由和共享二级布局，不用 query 模拟。
- 导航 ID、翻译标题、URL、图标、权限、选中和默认子页来自侧栏、命令菜单、模块
  导航共用的单一权威数据。
- 后台列表使用 ProTable 及其内置刷新，表单使用 Pro 表单组件；不增加重复刷新，
  也不在没有真实复用边界时抽离页面表单/表格。
- 所有用户文案使用 Paraglide，支持 `en-US`、`ja-JP`、`ko-KR`、`ru-RU`、
  `zh-TW`、`zh-CN`；日期、金额、状态、事件、单位和名称显式本地化。
- `localeLabels` 是固定原生语言名，不进入翻译资源，也不显示国旗。
- 两种主题都必须支持键盘、accessible name、焦点恢复、reduced motion、移动端和
  父子路由正确选中。

## 9. 运行时、性能与安全

- Workers 与 Node/Nitro 服务通过明确的运行时适配器承载同一全栈。Workers 使用
  D1、KV、R2、Queues 和 Cron；Node 使用 SQLite 权威数据、本地缓存/对象存储、
  SQLite 可靠队列和进程内调度器，全部位于一个 `GMPAY_DATA_DIR` 下。
- 现有 Workers 命令和 Cloudflare Vite 适配器保持不变：`bun run build`、
  `bun run predeploy`、`bun run deploy` 仅用于 Workers。Node 使用独立的
  `bun run build:node`，并通过 GitHub Container Registry 分发单容器多架构镜像。
- KV 按最终一致设计：不可变版本 key、有限 TTL、防击穿、payload 校验和 D1 回退。
  解密 secret 不得进入 KV，也不得用 KV 决定原子授权或金额状态。
- D1 使用 batch 与有证据的索引，遵守单 invocation 并发限制；用
  `EXPLAIN QUERY PLAN`/rows read 验证，索引变化后执行 `PRAGMA optimize`。分页、
  导出、Cron 和 Queue 必须有界。
- TanStack Query freshness 按数据波动性配置，保留 Router 外部缓存集成，避免水合
  重取、宽泛 invalidation 和隐藏页面轮询。
- Scalar/editor/chart/provider 重代码只由所属语义路由或事件加载；先验证自动路由/
  CSS splitting，再考虑手工 chunk。
- 记录隐私安全的 timing、D1 rows、KV 命中、Queue age/retry、服务商延迟、bundle、
  冷/热行为。只按前后证据优化，不把本地时间冒充线上延迟。
- CSRF、Origin/Host、安全头、限流、审计、SSRF、防泄密及可选管理员 TOTP 是必需
  能力；启用 TOTP 时必须提供恢复码确认/复制/下载。
- 运行时 secret 按当前产品设置契约在安装时初始化。禁止提交真实 secret、
  `.dev.vars`、Bot token、私钥、助记词、交易所 secret 或 Cloudflare token。
- Node/Docker 对外环境变量契约只有 `GMPAY_DATA_DIR`。Origin、Allowed Hosts、邮件
  通道等产品设置在 `/install` 确认或由认证后的后台维护。邮件通道按顺序故障切换；
  Node 与 Workers 显示同一组服务商类型；Cloudflare Email 仅在 `EMAIL` binding
  可用时投递。SMTP 拒绝 25 端口及非公网主机，并启用 TLS 证书校验。
- Node 备份、恢复和 Cloudflare 到 Node 的导入必须使用仓库维护的 package scripts，
  校验清单/校验和，并拒绝破坏性覆盖。

## 10. 证据与交付

- 修改前读取本次明确选择且被忽略的本地清单，并只选择当前目标项。保留用户无关
  修改；完成项记录文件、测试、命令、query plan、运行输出或浏览器证据。
- mock/fixture 只证明逻辑，不证明真实服务商就绪。真实链、交易所、钱包、Telegram
  和商户 Webhook smoke 只保留为人工资产并无条件跳过；凭证或环境变量不得启用它们，
  也不得阻塞自动化交付。
- Vite/Paraglide 负责消息生成。schema 未变化时，普通 dev 启动不重复生成 Drizzle
  migration。
- 开发过程中只运行与改动契约直接相关的专项测试和检查，不在仍有可执行 TODO 时反复
  运行全量质量门。所有本地可执行 TODO 完成后，才在同一最终代码树统一运行一次：

```bash
bun run typecheck
bun run test
bun run check
bun run build
bun run build:node
```

- 完成还要求当前浏览器/运行时、迁移、权限路径和文档证据。局部测试、历史结果或
  被跳过的真实平台套件都不能证明整个项目完成。
- 发布由 semantic-release 驱动。`alpha` 从 `1.0.0-alpha.1` 开始，只更新完整版本和
  `alpha` 容器标签；验证完成后合并到 `main`，再发布稳定 `1.0.0` 以及 major、minor、
  `latest` 标签。发布会更新 `package.json` 和 `bun.lock`、创建带自动生成说明的 GitHub
  Release 与 tag，再调用 Docker 工作流；原生 x64 与 Arm64 runner 会并行构建并 smoke
  各自平台镜像，然后发布组合 manifest 与 provenance。稳定版发布后，工作流会删除匹配
  的 alpha 预发布、Git tag 和 GHCR 版本。首次发布
  后由仓库所有者一次性设为 Public，工作流不修改 package 可见性。
