# 商户 API

简体中文 · [English](../en-US/MERCHANT_API.md)

GMPay 是主商户协议。EPay 只是同一 API 凭证、订单服务、收银台、支付处理器和 Webhook Outbox 上的边界兼容适配器。

## API 凭证

每个凭证包含数字 `pid` 和 API Secret。Secret 只在创建或轮换时显示一次。轮换会原地更新凭证：PID 保持不变，后续所有投递使用新 Secret。
创建交易需要 `orders:create`，查询需要 `orders:read`。两项 Scope 独立校验；数据库中的 Scope 数据无效时会失败关闭。

## GMPay 创建交易

向以下地址发送 JSON 或 `application/x-www-form-urlencoded`：

```text
POST /payments/gmpay/v1/order/create-transaction
```

字段：

- 必填：`pid`、`order_id`、`currency`、`amount`、`notify_url`、`signature`；
- `currency` 必须是有效的 ISO 4217 法币代码（默认 `USD`）；`amount` 最多 18 位整数和 8 位小数；
- `amount` 接受正数 JSON number 或十进制字符串，例如 `12.5` 或 `"12.50"`；字符串会原样保留格式，JSON number 则使用解析后的十进制表示参与签名和最小单位转换。
- 可选：`token` 与 `network`，两者必须同时提供；
- 可选：`redirect_url` 与 `name`。

同时省略 `token` 与 `network` 会创建可选择支付方式的 `pending` 订单，不会静默默认到 TRON 或 USDT。付款人通过返回的 `payment_url` 进入统一收银台。

创建、查询与收银台响应使用 epusdt 兼容的整数 `status`：`1` 表示等待支付，`2` 表示支付成功，`3` 表示已关闭，`4` 表示等待选择支付方式。`status_detail` 保留 `confirming`、`partially_paid`、`overpaid` 等 GMPay Edge 细粒度状态。

## GMPay HMAC-SHA256 签名

1. 排除 `signature`；
2. 排除 `null` 和空字符串；
3. 数字使用普通十进制表示；
4. 按字段名 ASCII 升序排序；
5. 不做 URL Encode，以 `&` 拼接 `key=value`；
6. 使用 API Secret 作为 HMAC Key 计算 HMAC-SHA256；
7. 将结果编码为 64 位小写十六进制文本。

旧版格式只接受参数边界无歧义的输入。参与签名的字段名必须匹配
`[A-Za-z_][A-Za-z0-9_]*`；值中不得包含 `&` 后接这类字段名和 `=` 的片段。
歧义请求会以 `401` 拒绝验签，包括含多个 `&key=value` 查询参数的回调 URL；
请使用回调路径或单个不透明查询参数。没有字段边界模式的普通 `&`、`=` 仍可使用。
EPay 同样遵循此限制，无歧义请求的签名结果保持不变。

```ts
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const parameters = {
  pid: "100000000001",
  order_id: "invoice-1001",
  currency: "USD",
  amount: "12.50",
  notify_url: "https://merchant.example/notify",
};
const source = Object.entries(parameters)
  .filter(([, value]) => value !== "")
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /&[A-Za-z_][A-Za-z0-9_]*=/.test(String(value))) {
      throw new Error("ambiguous signature parameters");
    }
    return `${key}=${value}`;
  })
  .join("&");
const signature = bytesToHex(
  hmac(
    sha256,
    utf8ToBytes(process.env.GMPAY_API_SECRET ?? ""),
    utf8ToBytes(source),
  ),
);
```

将代码保存为 `sign.ts`，设置 `GMPAY_API_SECRET` 后运行 `bun sign.ts`。无需 SDK 即可请求：

```bash
curl --fail-with-body \
  -H 'content-type: application/json' \
  --data '{"pid":"100000000001","order_id":"invoice-1001","currency":"USD","amount":"12.50","notify_url":"https://merchant.example/notify","signature":"<lowercase-hmac-sha256>"}' \
  https://pay.example.com/payments/gmpay/v1/order/create-transaction
```

权威实现和向量位于 `src/features/api-keys/server/gmpay-signature.ts` 与 `tests/unit/auth/gmpay-signature.test.ts`。

## GMPay 订单查询

使用同一个 API 凭证查询订单，并且只能使用一个查询条件：

```text
GET /payments/gmpay/v1/order/query?pid=100000000001&trade_id=<trade-id>&signature=<lowercase-hmac-sha256>
```

也可以将 `trade_id` 换成商户订单号 `order_id`。签名规则与创建订单完全
一致，按非空查询字段排序后以 API Secret 为 Key 计算小写 HMAC-SHA256。凭证只能查询
自己创建的订单。

## GMPay 通知

GMPay Edge 向订单不可变的 `notify_url` POST JSON。载荷使用 epusdt 兼容的整数状态（`1` 等待支付、`2` 支付成功、`3` 已关闭），并包含 `pid`、`trade_id`、`order_id`、订单/支付金额、收款目标、Token、交易 ID、状态和 `signature`。使用相同排序参数 HMAC-SHA256 算法验签，成功后返回 HTTP 200 与纯文本 `ok`，其他响应都会重试。

状态、订单金额、应付资产金额和资产代码取自持久化的事件快照，而不是订单的后续状态。
订单全额付款后重试旧的部分付款事件，仍报告原来的等待状态。`actual_amount` 继续表示
应付资产金额，不表示累计实收；内部事件的 `payment.receivedAmountUnits` 记录事件发生时的
累计实收。密钥轮换可能改变签名，但不会改变事件业务数据。

```ts
import { timingSafeEqual } from "node:crypto";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const payload = await Bun.stdin.json() as Record<string, string | number>;
const received = String(payload.signature ?? "");
const source = Object.entries(payload)
  .filter(([key, value]) => key !== "signature" && value != null && value !== "")
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /&[A-Za-z_][A-Za-z0-9_]*=/.test(String(value))) {
      throw new Error("ambiguous signature parameters");
    }
    return `${key}=${value}`;
  })
  .join("&");
const expected = bytesToHex(hmac(
  sha256,
  utf8ToBytes(process.env.GMPAY_API_SECRET ?? ""),
  utf8ToBytes(source),
));
const valid = received.length === expected.length && timingSafeEqual(
  Buffer.from(received), Buffer.from(expected),
);
if (!valid) throw new Error("invalid signature");
process.stdout.write("ok");
```

生产接收端应在返回 `ok` 前持久化订单/事件身份，使重复投递无副作用。
自动重试和后台手动重发都可能再次发送同一逻辑状态，因此不能依赖只投递一次。

## EPay 兼容

EPay 客户端可使用 GET Query 或表单 POST：

```text
/payments/epay/v1/order/create-transaction/submit.php
```

适配器接受 `pid`、`money`、`out_trade_no`、`notify_url`，以及可选的 `return_url`、`name`、`type`、`sign`、`sign_type=MD5`。签名排除 `sign` 和 `sign_type`。`type=asset.network` 选择支付方式；空值或 `alipay` 创建可选择订单，不默认到任何链。成功返回与 GMPay 相同的订单 Envelope，客户端只需打开一次 `data.payment_url`。

EPay GET 回调使用同一 Secret 签名并要求纯文本 `ok`。EPay 字段和 `trade_status` 只存在于边界，数据库仍使用 GMPay Edge 状态机。

## 错误与幂等

响应包含 `status_code`、`message`、`data` 和 `request_id`。外部订单号在创建它的 API 凭证范围内唯一；同一凭证重试相同订单号不会创建第二个订单，不同凭证可以使用各自的业务编号。校验与业务拒绝除下表特别说明外均为 HTTP `400`，所有响应使用同一 Envelope。

| `status_code` | 含义 |
| --- | --- |
| `10001` | 查询的订单不存在（HTTP `404`） |
| `10002` | 商户订单号已存在 |
| `10003` | 请求的收款方式不可用，或托管支付服务商未返回支付（`provider_unavailable`，HTTP `502`）；订单及其商户订单号会回滚，可直接重试 |
| `10004` | 金额无效：不是正十进制数，或整数位超过 18 位、小数位超过 8 位 |
| `10009` | 请求参数无效，包括不支持的 `currency`、非公网 HTTPS 的 `notify_url`、非 HTTPS 的 `redirect_url`，或只提供 `token` 未提供 `network`；超过 64 KiB 的请求体以该码返回 HTTP `413` |
| `10016` | 请求的资产/网络不可用，或订单币种没有可用汇率（`exchange_rate_unavailable`，HTTP `503`） |
| `401` | PID、Scope 或签名校验失败 |
| `429` | API 凭证超过限流；同一 PID 一分钟内认证失败超过 20 次也会返回 |
| `500` | 网关发生未预期错误；排查时使用 `request_id` |

超时应视为未知结果。重试相同 `order_id` 不会重复创建，但会返回 `10002`，不会静默替换订单。权威 OpenAPI 合约为 [`public/openapi.yaml`](../../public/openapi.yaml)，运行时在 `/docs` 渲染。
