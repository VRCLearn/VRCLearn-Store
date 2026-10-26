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

## 费用监控的实际限制

`*/15 * * * *` 调用真实 Cloudflare `GET /accounts/{account_id}/billable-usage`，每次最多一个源请求、10 秒超时、2 MiB 响应、5000 条数据；不重试。该接口按账户返回累计使用费，当前按日更新，不能提供本项目十五分钟实时费用或 Cloudflare 账单硬上限。估算额外保守预留 Workers Paid 的 5 美元基础费；同账户其他项目用量会计入保护阈值。

**2026-10-26 只读账户检查中，该成本接口返回 403，而订阅及资源查询正常。没有把它当作登录失效，也没有用假数据替代。** 因此当前不能将自动美元监控描述为已验证可用，生产高成本功能保持受限。即使将来有读取权限，若缺少 Workers／Pages、D1、R2、Durable Objects、邮件、日志、KV 中任一产品的完整数据、发现分页截断、未知币种或过期数据，也进入受限模式；缺失行不会被当作零成本。

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

模式为 `normal`、`restricted`、`maintenance`，只有升级，没有自动恢复。10 美元告警，15 美元受限，18 美元维护；读取失败也受限，已有维护状态不会被覆盖。缺失状态或超过 30 分钟没有新检查的状态不能授权生产高成本操作。

维护时只启用预先配置且表达式严格匹配 `dynamicBlockExpression(ORIGIN)` 的单条 `block` 规则，不创建规则或改写其他规则。`CF_MONITOR_TOKEN` 只读成本；`CF_API_TOKEN` 只用于该规则更新，二者分开配置。如果缺少该规则、凭据或规则不匹配，状态记录 `edgeBlocked:false`，应用层仍保持维护。操作员应在 Cloudflare 控制台核对用量与规则后手动恢复，绝不能仅清空状态让系统自行回到正常模式。

发信与监控凭据都由 secret 注入，不写入配置和日志。普通账户邮件有独立的全站 100 封／日、2500 封／日历月及收件人 1 封／分钟、5 封／日配额；运维告警另保留 6 封／日、40 封／月，重复告警不会无限发送。当前仓库没有部署、创建资源或发送真实邮件。
