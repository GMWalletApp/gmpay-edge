# Bun 数据运维

Bun 部署将 SQLite 数据库保存在 `$GMPAY_DATA_DIR/gmpay.sqlite`，私有对象保存在
`$GMPAY_DATA_DIR/objects`。仓库维护的 CLI 与应用服务均使用 Bun 及其原生 SQLite
驱动。

## 备份与恢复

备份或恢复前先停止 GMPay Edge 容器，确保数据库与对象文件处在同一个业务时间点。

```bash
GMPAY_DATA_DIR=/srv/gmpay bun run data -- backup --output /srv/backups/gmpay-2026-08-20
GMPAY_DATA_DIR=/srv/gmpay-restored bun run data -- restore --input /srv/backups/gmpay-2026-08-20
```

发布镜像内置同一个 CLI。例如停止服务后，挂载外部备份目录并执行：

```bash
docker compose stop gmpay-edge
docker compose run --rm --no-deps \
  --volume "$PWD/backups:/backups" \
  gmpay-edge bun run data -- backup --output /backups/gmpay-2026-08-20
```

输入或输出路径始终需要显式指定，备份输出还必须位于数据目录之外。恢复只接受全新或
空目标目录，不会覆盖非空目录。清单会校验每个文件；恢复还会执行 SQLite 完整性、
外键和迁移校验和检查。

备份属于机密材料。数据库副本以明文包含运行时主密钥：`runtime.better_auth_secret`
（会话签名）、`runtime.api_key_pepper`（商户 Secret 保护）和
`runtime.integration_config_secret`（服务商、Telegram 与邮件凭据加密），以及它们保护的
全部加密凭据、所有用户与支付记录和私有上传。任何能读取备份的人都可以伪造管理员会话
并解密全部已存储凭据。`backup` 命令写出的目录未加密，因此备份离开主机前必须加密、只
允许运维身份读取、不得以明文放在共享存储上、及时删除过期副本，并把任何泄露视为全部
凭据失陷。例如：

```bash
tar --create --directory /srv/backups gmpay-2026-08-20 |
  gpg --symmetric --cipher-algo AES256 --output /srv/backups/gmpay-2026-08-20.tar.gpg
```

请定期从解密后的归档演练恢复。

## 迁入 Cloudflare 导出数据

先将 D1 导出为 SQL，并将 R2 对象导出到本地目录；对象在该目录中的相对路径必须保持
原始 R2 key。然后把数据导入全新或空的 Bun 数据目录：

```bash
wrangler d1 export DB --remote --output ./d1-export.sql
GMPAY_DATA_DIR=/srv/gmpay bun run data -- import-cloudflare \
  --d1-sql ./d1-export.sql \
  --r2-dir ./r2-export \
  --r2-manifest ./r2-metadata.json
```

实例没有对象时可以省略 `--r2-dir`。`--r2-manifest` 也是可选参数，但必须与
`--r2-dir` 一起使用；它用于保留 R2 HTTP 元数据和自定义元数据。文件是一个以原始 R2
对象 key 为键的 JSON 对象：

```json
{
  "evidence/receipt.txt": {
    "httpMetadata": {
      "contentType": "text/plain; charset=utf-8",
      "cacheExpiry": "2026-09-01T00:00:00.000Z"
    },
    "customMetadata": { "orderId": "order-123" }
  }
}
```

支持的 HTTP 字段为 `contentType`、`contentLanguage`、`contentDisposition`、
`contentEncoding`、`cacheControl`，以及 ISO 8601 格式的 `cacheExpiry`。未知字段、
非字符串自定义元数据，以及找不到对应导出对象的清单 key 都会被拒绝。不提供此
sidecar 时仍会迁移对象内容和 key，但无法还原 R2 元数据。

脚本会确认 D1 导出包含仓库中的全部迁移，为本地迁移器记录校验和，校验外键，并把
R2 key 路径转换成私有对象的哈希布局。非空目标会被拒绝，因此失败或重复执行导入不会
覆盖现有实例。
