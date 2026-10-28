# 辅助 Worker 与账户监控

两套业务辅助 Worker 分别为 `vrclearn-store-support` 和 `test-vrclearn-store-support`，共用实现但不共用 D1、KV、R2、DO、认证限流或认证秘密。它们只接受本环境 Pages 的 Service Binding 调用，关闭 `workers.dev`、预览 URL 和公共路由。资源由 `deployment/environments.json` 管理；部署与实际验收见 [运维说明](../docs/operations.md)。

## 业务辅助 Worker

`worker/index.ts` 提供 Better Auth 邮箱密码登录、邮箱验证、密码重置、会话撤销和内部会话查询。账户资料仅使用昵称，不设独立用户名；未来接入 HopeWriteDream 的 Logto。管理员要求已验证邮箱、有效会话、明确授予的角色且未被封禁。

密码计算使用原生 `node:crypto.scrypt`，参数为 N=32768、r=8、p=3，约占 32 MiB；格式与参数进入存储值，不提供纯 JavaScript 回退。安全 Cookie 按主机限定；两套云端 `ENVIRONMENT=production`，使用 `DEPLOYMENT_ENV=production|test` 标记部署身份。认证错误保留 SDK 的真实 HTTP 状态和 `code`、`message`、`requestId`。

每个业务 Worker 仅持有自己的 `BETTER_AUTH_SECRET`、`TURNSTILE_SECRET_KEY`，原生 EMAIL 绑定只允许本环境发件地址。生产使用 `noreply@vrclearn.com`，测试使用 `test-noreply@vrclearn.com`；测试邮件主题含 `[TEST]`，允许发送给所有注册邮箱，仍执行同等验证、限流及配额。邮件链接必须匹配本环境 ORIGIN。

业务 Cron 为 `*/15 * * * *`，只读取本地预算门禁并执行有界媒体、草稿、会话与验证记录清理，不查询账单、修改 WAF 或发送运维告警。维护或 KV 读取异常时跳过清理；一次批次失败不扩大重试。CPU 上限 500 ms，密码计算性能仍须按实际部署记录验收，不能降低参数。

## 配额合同

各环境的 `QUOTA.getByName("global").fetch("https://quota.internal/reserve", ...)` 接收：

```json
{
    "key": "upload:logical-operation-id",
    "limits": [
        { "key": "upload:bytes", "limit": 2097152, "amount": 1024, "windowSeconds": 86400 }
    ]
}
```

首次允许返回 `{"allowed":true}`，拒绝返回 429 与 `{"allowed":false,"retryAfter":60}`。相同 key 一小时内重放返回 `duplicate:true`，不再扣除配额，也不授权第二次执行。多个计数在同一 DO 事务内检查及扣除，任一不足均不扣除；`period:"month"` 使用 UTC 日历月。失败不自动退还预留，避免结果不明时重放昂贵操作。长期业务幂等性由 D1 操作状态负责。

SQLite 账本使用到期索引，计数与预留合计最多 100,000 条。获批操作最多清理 32 条过期记录，超限和重放不触发删除；Alarm 每批最多清理 1,000 条，积压最短 60 秒后继续，否则睡到下一到期时间，空账本停止 Alarm。清理、配额写入及 Alarm 更新同事务提交，持久化失败不放行。

账户发信限制为每邮箱 1 封／分钟、5 封／日，全环境 100 封／日、2,500 封／UTC 日历月；两套计数独立。上传、提交与存储限制见 [费用与容量](../docs/costs.md)。

## 独立账户监控

`control/index.ts` 对应 `vrclearn-store-account-monitor`，不随测试分支的业务发布更新，无公共 HTTP 入口。它独立持有权威 KV、告警 DO、EMAIL 和三个 Secret：`CF_MONITOR_TOKEN`（账户 Billing Read）、`CF_API_TOKEN`（目标 zone WAF 读写）、`ALERT_EMAIL`。业务 Worker 不持有这些控制权限。

监控 Cron 为 `7,22,37,52 * * * *`，每十五分钟运行并与旧业务监控及清理错峰。Cron 通过本命名空间的 `QUOTA.getByName("account-monitor").checkBudget()` 执行整轮任务；告警预留使用另一对象 `QUOTA.getByName("global")`，避免 DO 自调用。两者与业务环境的 DO 命名空间均独立。

`account-monitor` 合并同对象的并发调用，所有 KV、WAF 与发信 Promise 完成前保持本轮串行。SQL 单行保存开始、完成时间和结果，完成后 61 秒内的重复触发只读缓存，不再写 KV。中断结果不明时不立即重试，下一安全轮次强制维护；RPC 故障由外层尝试两域 WAF 封锁，不另起并发 KV 写入者。外站请求不跟随重定向，分别限时十秒；步骤数量及响应大小固定有界，不使用到期后放开旧写入的外部租约。

费用源先核验 `billable-usage/info` 的账户覆盖与订阅，再显式读取当前账期。最多两个源请求、每次 2 MiB、最多 5,000 条记录；逐项校验美元、计量单位、账期与 36 小时时效，不重试。未知产品的有效费用也计入账户总额，额外预留 Workers Paid 的 5 美元基础费；同账户其他项目用量共同计费。实际观察到的产品族保存在 `coverage`，完整提供方来源保存 `coverageBasis:"provider-account"`，不伪造缺失产品的零费用。

权威 KV 分别保存账户门禁 `budget:state` 与完整分发回执 `budget:delivery`，每轮每 key 只写一次。首次启用必须将核验过的原生产预算同时预置到这两个 key，保留原模式和金额；任一缺失或畸形都进入维护，不能以空状态自动恢复。业务 KV 只得到自己的门禁，不包含另一环境的回执或资源。

阈值为 10 美元告警、15 美元两环境受限、18 美元两环境维护，只升级不自动恢复。费用源异常至少受限，权威状态故障进入维护；单个测试副本不可读／不可写仅闭锁测试。告警配额独立为 6 封／日、40 封／UTC 月，同模式与原因每天最多一次。

动态和媒体各使用一条共享裸 block 规则。监控只接受配置生成的生产单域、测试单域、两域三种精确表达式，合并各环境目标后每 ID 每轮最多 PATCH 一次，并核验活跃入口、phase、kind、规则与 skip 顺序，再读回表达式及 enabled。更新保留 action、description、ref，不发送位置或 API 管理字段，拒绝未支持的额外动作参数。普通检查只能扩大或保留已有封锁；显式人工恢复传入 `{allowRecovery:true}` 才能缩小或关闭，关闭时保留完整两域表达式。

恢复前暂停控制调度并确认本轮已结束，核对真实费用、攻击状态、权威两键、业务副本与规则读回。不得只清空 KV、只改测试副本或用伪造零费用解除保护。此机制始终是账户账单软性兜底，不能保证硬上限；固定订阅、延迟、攻击流量及剩余入口仍可能产生费用。

首次移交必须在新控制监控完整验收后，暂停旧辅助 Worker 的监控 Cron、确认旧轮结束，再删除其三个控制 Secret 并发布纯业务版本；业务配额、账户和媒体均保留。具体顺序与读回清单见 [首次启用与迁移](../docs/operations.md#首次启用与迁移)。
