# 安全说明

简体中文 · [English](../en-US/SECURITY.md)

## 账户与权限

- 禁止公开邮箱注册。新部署实例按产品设计公开 `/install` 供运营者原子创建首位受保护的 `root` 用户；安装完成后关闭入口，后续用户只能由具有动态 RBAC 权限的登录用户创建。
- Better Auth 管理密码和 Session；密码在 Hash 前不做 Trim 或规范化。禁用用户会撤销现有 Session，最后一个启用的 root 用户不能被禁用、删除或移除 root 角色。
- 用户最终权限是全部启用角色权限的并集。角色权限以 `module + permission_mask` 保存，未知模块或位值失败关闭；内置 root 角色不能修改、停用或删除。
- 用户、角色、密码变更标记和角色绑定均记录操作者、Request ID、来源 IP 与脱敏摘要，绝不记录密码或 Hash。
- TOTP 必须在首次正确验证码后才完成启用；恢复码一次性使用，关闭 TOTP 需要当前密码，可信设备最长 30 天，连续失败触发锁定。
- TOTP 为可选功能。密码找回使用 Better Auth 的 15 分钟一次性邮件链接；已存在与未知邮箱得到相同响应，重置后撤销全部现有 Session，并审计成功重置而不保存 Token 或密码。

## 密钥与敏感配置

- API 凭证 Secret、支付供应商凭证和 Telegram Bot Token 加密存储，列表接口永不返回明文；API Secret 只在创建或轮换时显示一次。支付连接 API Key 使用独立 AES-GCM 加密凭据表，旧明文值在首次使用时迁移并清空。
- 带凭据的交易所与钱包请求固定访问内置官方 Origin；可配置链节点只接受不含用户信息的公共 HTTPS/WSS，并拒绝私网、保留地址和链路本地地址。
- API 凭证使用数字 PID；轮换原地更新同一行并保留 PID。后续 GMPay/EPay 回调和已入队重试都从 D1 获取当前 Secret。
- 后台运行配置按单部署模型保存在 D1；具有权限的管理员可以查看和轮换，公共接口不会暴露这些值，空提交保留当前值。审计写入、查询和导出都会递归脱敏。
- `runtime.better_auth_secret` 必须随 D1 安全备份；更换它会使认证材料失效。
- 系统不接受钱包私钥或助记词，交易所凭证只能是只读权限，严禁提现权限。

## 商户 API 与金额

- 金额在边界使用十进制字符串，进入计算前转换为法币最小单位整数或资产单位 `bigint`，禁止浮点运算。
- GMPay 必须通过启用的 PID、排序参数 HMAC-SHA256 签名、精确 Scope 与限流检查；EPay 兼容边界保留旧版 MD5 签名。签名先于限流计数验证，无效签名不消耗额度。
- Scope 仅使用显式 CRUD：`orders:create`、`orders:read`、`orders:update`、`assets:read`。
- D1 唯一约束保护 PID、同一 API 凭证范围内的外部订单号、无凭证内部订单号、用户角色、交易事件、Webhook 事件和投递。外部订单号按创建凭证隔离，既阻止同一凭证重放，也允许不同凭证使用各自的业务编号。

## Webhook、URL 与 Queue

- `notify_url` 必须是公共 HTTPS，拒绝私网、回环、链路本地、元数据地址、嵌入凭证和不安全跳转。投递时重新校验 A/AAAA 结果，私有/保留或公私混合解析均失败关闭；投递不跟随重定向，响应摘要最多读取 512 字节且不记录签名材料。
- 商户、供应商、Telegram 和收银台复核入口均按流式字节上限读取请求体。每次入站 HTTP 尝试分配新的服务端 Receipt ID，外部 `X-Request-ID` 仅作为可重复元数据保存。
- Queue/DLQ 使用完整的版本化白名单信封，只携带事件或投递 ID；未知、畸形或不支持版本只有在审计成功后才 Ack。
- 每个订单保存不可变的通知目标和创建凭证身份；手动重发会创建新的事件和投递历史，不存在可变全局目标。
- 所有 JSON API 响应均设置 `Cache-Control: no-store` 与 `X-Request-ID`。

## 支付与收银台

- 支付入账、订单状态转换、Webhook 事件和 Outbox 必须一致且幂等。迟付遵循 `accept`、`review` 或 `reject` 策略。
- 订单只有在待支付、未过期、没有已归属付款/待审凭证且没有活跃托管订单时才能切换支付方式；版本、地址锁和审计一起提交。
- 付款复核上传要求同源 Origin 与限流；服务端按文件字节识别 JPEG/PNG/WebP、校验结构与尺寸、限制 5 MiB 并保存 SHA-256。截图不能直接改变订单状态，批准前必须由适配器拉取并匹配真实交易。

## Telegram

- Bot Token 轮换先调用 `getMe` 验证并在新凭证上注册 secret-token Webhook，再原子更新 D1；旧 Webhook 清理失败会明确提示人工撤销。
- `/start` 会为数值发送者 ID 创建待管理员启用的私人订阅；Inline 查询、回调和“我已付款”仅由所选 Bot 下已启用的私人订阅授权，群组或频道 Chat ID 不授予私人订单权限。
- “我已付款”只会幂等请求一次扫描，不会直接把订单标记为已支付。

## Worker 响应

HTTPS 响应启用 HSTS、禁止 Frame、MIME Sniffing 防护、严格 Referrer Policy、受限 Permissions Policy 与同源资源策略。生产环境还必须配置正确的 Allowed Hosts、Origin/CSRF 校验和登录/API 限流。
