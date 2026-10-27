# 辅助 Worker

此 Worker 只接受 Pages Service Binding 调用；配置关闭 `workers.dev` 和预览 URL，不配置公共路由。它提供 Better Auth 邮箱密码登录、邮箱验证、密码重置、会话撤销，以及 TOTP 和备用恢复码。管理员还需要当前会话的成功 MFA 证明，旧会话或仅启用 MFA 的账户不能取得管理权限。

密码计算显式使用原生 `node:crypto.scrypt` 的 N=32768、r=8、p=3 参数（约 32 MiB 内存）；格式和参数进入存储值，无纯 JavaScript 回退。生产 CPU 上限仍需在隔离部署中确认，不能降低参数以使压测通过。

## 配额合同

`QUOTA.getByName("global").fetch("https://quota.internal/reserve", ...)` 接收：

```json
{
    "key": "upload:logical-operation-id",
    "limits": [
        { "key": "upload:bytes", "limit": 2097152, "amount": 1024, "windowSeconds": 86400 }
    ]
}
```

首次允许返回 `{"allowed":true}`，拒绝返回 429 和 `{"allowed":false,"retryAfter":60}`。相同 key 一小时内重放返回 `duplicate:true` 且不再扣配额，调用方不能把重放当作再次执行上传或发信的许可。数据库中的操作状态仍负责长时间的业务幂等性。`period:"month"` 使用 UTC 日历月。多个计数在同一 Durable Object 事务内一起检查和扣除，任一项不足均不扣除。失败后不自动退还已预留额度，避免超时结果不明时重放昂贵操作。

内部账本使用 SQLite 到期索引，计数和预留总计不超过 100,000 条；容量不足返回 503，完整回滚当次操作。获批请求最多删除 32 条过期记录，超限和重放不执行清理删除。Alarm 每次最多清理 1,000 条，过期积压最短 60 秒后继续，否则睡到下一到期时间；空账本停止调度。清理、配额写入与 Alarm 更新在同一存储事务中执行，持久化失败不放行预留。

## 费用监控的实际限制

`*/15 * * * *` 先调用真实 Cloudflare `GET /accounts/{account_id}/billable-usage/info` 核对订阅信息，再读取 `billable-usage`。每次最多两个源请求，单次 10 秒超时、2 MiB 响应，最多 5000 条使用记录，不重试。该接口按账户返回累计使用费，当前按日更新，不能提供本项目十五分钟实时费用或 Cloudflare 账单硬上限。订阅账期按 UTC 锚点及月末对齐，不假定从每月 1 日开始；按订阅、zone、服务、计量与单位累计，各分区分别检查 36 小时内的最新记录，跨 zone 费用不会作为同一累计记录合并。估算额外保守预留 Workers Paid 的 5 美元基础费；同账户其他项目用量会计入保护阈值。

**2026-10-27 重新认证后的只读检查中，V1／info／V2／metrics 仍返回 403／10000，而普通资源查询正常。账户有账单权限，CLI OAuth 没有 Billing scope，仍需限定账户的 Billing Read token 验证实际来源。** 当前不能将自动美元监控描述为已验证可用。若缺少 Workers／Pages、D1、R2、Durable Objects、邮件、日志、KV 中任一产品的完整数据、发现分页截断、未知币种、错误账期或任一指标过期，也进入受限模式；缺失行不会被当作零成本。

KV `budget:state` 保存：

```json
{
    "mode": "restricted",
    "updatedAt": "2026-10-26T00:00:00.000Z",
    "reason": "usage_source_unavailable",
    "source": "billable-usage",
    "coverage": []
}
```

模式为 `normal`、`restricted`、`maintenance`，只有升级，没有自动恢复。10 美元告警，15 美元受限，18 美元维护；成本源读取失败至少受限，KV 故障进入维护，已有维护状态不会被降级。缺失状态或超过 30 分钟没有新检查的状态不能授权生产高成本操作。

维护时启用同一 zone 活跃自定义防火墙入口中、表达式分别匹配 `dynamicBlockExpression(ORIGIN)` 与 `mediaBlockExpression(MEDIA_ORIGIN)` 的两条预配置 `block` 规则，绑定 EDGE_RULESET_ID、EDGE_RULE_ID、EDGE_MEDIA_RULE_ID。验证入口 ID／kind／phase、规则内容和 skip 顺序，只 PATCH `enabled:true`，一条失败仍处理另一条；最后读取入口核验。两条均确认才记录 `edgeBlocked:true`，分项结果记录为 `edgeDynamicBlocked`／`edgeMediaBlocked`。不创建规则、改写表达式、重排规则或自动恢复。

`CF_MONITOR_TOKEN` 限定账户 Billing Read；`CF_API_TOKEN` 限定 zone 的 WAF 规则读写，二者分开配置。KV 状态读取／验证／持久化失败时进入维护并仍尝试边缘封锁；应用门禁在 KV 读取失败时拒绝动态业务和认证。定时任务在维护状态跳过额外清理。缺少规则或凭据仍会记录 `edgeBlocked:false`，需操作员处理并在恢复时人工关闭两条规则，绝不能仅清空状态让系统自行回到正常模式。

发信与监控凭据都由 secret 注入，不写入配置和日志。普通账户邮件有独立的全站 100 封／日、2500 封／日历月及收件人 1 封／分钟、5 封／日配额；运维告警另保留 6 封／日、40 封／月，重复告警不会无限发送。当前仓库没有部署、创建资源或发送真实邮件。
