# 辅助 Worker

此 Worker 只接受 Pages Service Binding 调用；配置关闭 `workers.dev` 和预览 URL，不配置公共路由。它提供 Better Auth 邮箱密码登录、邮箱验证、密码重置与会话撤销。管理员需要已验证邮箱、有效会话、明确授予的管理员角色且未被封禁。

账户资料仅使用昵称，不设置独立用户名；未来接入 HopeWriteDream 的 Logto 账号体系，本期尚未实现。自定义认证门禁返回 Better Auth 平面错误字段 `code`、`message`、`requestId`，客户端保留 SDK 的真实 HTTP 状态。

密码计算显式使用原生 `node:crypto.scrypt` 的 N=32768、r=8、p=3 参数（约 32 MiB 内存）；格式和参数进入存储值，无纯 JavaScript 回退。生产 CPU 上限仍需在受 Access 保护的内部环境中确认，不能降低参数以使测试通过。

## 当前部署

2026-10-27 已部署版本 `148212b3-faac-48db-b678-d6c35069aeea`，启动时间 38 ms，CPU 上限 500 ms，配置 `*/15 * * * *`。前三个 D1 迁移与外键检查通过，共享资源 ID 和 SQLite Durable Object 已配置。当前仓库的账户认证简化及相应迁移尚待授权部署，密码登录、会话撤销和管理员门禁须在部署后重新验收。启动耗时不代表密码计算 CPU 已通过远端验证。

五个必需 secrets 为 `BETTER_AUTH_SECRET`、`TURNSTILE_SECRET_KEY`、`CF_MONITOR_TOKEN`、`CF_API_TOKEN`、`ALERT_EMAIL`。Windows 部署通过仅当前用户可连接的命名管道向 Wrangler `--secrets-file` 提供数据，随版本原子注入，未创建明文秘密文件；运维收件人保存在 secret 中。

人工恢复后，线上 Cron 已持续成功读取并核验真实账单来源。2026-10-27 17:15:47 UTC 自动采样为 `normal`、5 美元、`coverageBasis: "provider-account"`，没有伪造缺失的 Logs 行。17:24:36 UTC 读回确认 Pages 仍为 FD 部署、媒体地区 WAF 启用，两条紧急停机规则均禁用。

经明确批准的真实停机演练已验证动态配置 API 与媒体返回 403，静态入口仍保持 Access 保护，已登录静态维护页实际返回 200。两条紧急规则已恢复禁用，规则定义、顺序及其他规则保持一致，12 次 HTTP 探测均符合阶段预期。

所有者已完成真实注册、验证邮件、密码登录及管理员初始化。商家入驻、店铺与两区权限审核、商品提交与发布、三语详情及 sitemap、公开图片、检索、收藏和举报处理已实测。同一商品内容修订在仅一区批准时保留旧版，两区通过后统一切换；下架验收确认 CN 下架保留国际区，随后国际区下架使目录／收藏／sitemap／图片最终撤销，公开图片记录清零、私有原图保留一份。最终分区验收确认 CN 首先生效而国际区仍待审，国际出口无法读取商品；国际区随后正常通过审核，当前修订 `4be2d32a-d48f-4586-ae98-85d8e59c81a0` 为 `published`、双区有效上架并保留两份公开图片供内测使用。发布与换版未触发 Pages 构建。

最终三语商品 HTML 均为 200、含当前正文及 Product 结构化数据且仅引用国际区图片；搜索和收藏为 200 并返回新内容，三语 sitemap 包含商品。国际区图片实际返回 200、CDN HIT、非磁盘缓存，JPEG 响应为 53,991 字节、TTL 60 秒，解码为 1910×851；国际出口直接请求 CN 图片实际为 403。

受 Access 保护的内测部署已可用。用户明确延期真实中国网络访问验证，此项不阻断本次交付。真实拒绝、同内容新增区、并发异常等边界尚仅有本地覆盖；此前下架图片的原 URL 抽样距操作约四分钟，不能作为 60 秒内撤销的实测证明，时限由实现及本地测试覆盖。当前不宣称全部生产边界均已验证。

300 项单元／集成测试、64 项桌面／移动端浏览器回归，以及构建、类型检查和部署预检通过。回归包含新库与旧库认证迁移、密码登录和管理员门禁、地区独立发布、统一换版、并发撤销、审核结果及重试界面。当前账户认证与迁移变更须在授权部署后完成远端回归，部署与真实验收边界见 [运维说明](../docs/operations.md#真实环境验收)。

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

`*/15 * * * *` 先调用真实 Cloudflare `GET /accounts/{account_id}/billable-usage/info` 核对账户覆盖和有效订阅，再以显式 `from`／`to` 读取 `billable-usage`。窗口从最早的当前订阅账期起点至 UTC 次日，账期按 UTC 锚点及月末对齐，不假定从每月 1 日开始，也不接受混入上一账期的记录。每次最多两个源请求，单次 10 秒超时、2 MiB 响应，最多 5,000 条使用记录，不重试。按订阅、zone、服务、计量与单位累计，各分区分别检查 36 小时内的最新记录；未知产品的有效费用也累加。估算额外保守预留 Workers Paid 的 5 美元基础费，同账户其他项目用量会计入保护阈值。

账单和 WAF 请求采用 Workers 支持的 `redirect: "manual"`，3xx 按失败处理，不跟随跳转或将认证头传给其他目标。

2026-10-27 已用单独的账户 Billing Read 令牌通过 `cf` 读取 V1 与 info：`covered=true`，一个订阅；显式当前账期查询返回 13 条美元记录。账单与独立 WAF 停机令牌在开发机器以当前用户的 Windows DPAPI 加密保存，均于 2027-01-25 到期，已分别注入 `CF_MONITOR_TOKEN` 和 `CF_API_TOKEN`。V2／metrics 仍返回 403／1171，当前监控不依赖这两个受限入口。

监控接受提供方声明的完整账户费用源，成功估算保存 `coverageBasis: "provider-account"`；`coverage` 仅描述实际观察到的产品族，缺少 Logs 等产品行不会被伪造成零成本或已观察记录。该合同依据 [Cloudflare 对 V1 账户按量产品覆盖的说明](https://blog.cloudflare.com/billable-usage-api/)。覆盖声明无效、空响应、分页截断、未知币种、错误账期或任一指标过期均至少进入受限模式。源失败时保留旧估算用于显示，但不保留成功覆盖依据。费用目前按日更新，每十五分钟查询无法变成实时项目账单，也不能形成账单硬上限。

KV `budget:state` 保存当前状态，以下为费用源失败时的结构示例：

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

维护时启用同一 zone 活跃自定义防火墙入口中、表达式分别匹配 `dynamicBlockExpression(ORIGIN)` 与 `mediaBlockExpression(MEDIA_ORIGIN)` 的两条预配置裸 `block` 规则，绑定 EDGE_RULESET_ID、EDGE_RULE_ID、EDGE_MEDIA_RULE_ID。验证入口 ID／kind／phase、规则内容和 skip 顺序后，PATCH 原有 action、expression 及存在的 description／ref，仅将 enabled 改为 true；不发送 id、version、last_updated 或 position。额外动作参数、日志配置等未支持设置会使该条更新被拒绝，避免完整定义替换丢失行为。一条失败仍处理另一条；最后读取入口核验。两条均确认才记录 `edgeBlocked:true`，分项结果记录为 `edgeDynamicBlocked`／`edgeMediaBlocked`。不创建规则、改写表达式、重排规则或自动恢复。

`CF_MONITOR_TOKEN` 限定账户 Billing Read；`CF_API_TOKEN` 限定 zone 的 WAF 规则读写，二者分开配置。KV 状态读取／验证／持久化失败时进入维护并仍尝试边缘封锁；应用门禁在 KV 读取失败时拒绝动态业务和认证。定时任务在维护状态跳过额外清理。缺少规则或凭据仍会记录 `edgeBlocked:false`，需操作员处理并在恢复时人工关闭两条规则，绝不能仅清空状态让系统自行回到正常模式。

认证、监控凭据及 `ALERT_EMAIL` 运维收件人由 secret 注入，不写入公开配置和日志；发信通过原生 EMAIL 绑定。普通账户邮件有独立的全站 100 封／日、2500 封／日历月及收件人 1 封／分钟、5 封／日配额；运维告警另保留 6 封／日、40 封／月，重复告警不会无限发送。`EMAIL.send()` 使用当前原生 `EmailMessageBuilder`，绑定限制发件人为 `noreply@vrclearn.com`。域名启用和类型检查不能证明实际投递，内部测试只向已确认的所有者测试邮箱发送必要邮件。

部署使用 `cf` 管理资源、迁移、绑定及查询。Pages 由 Cloudflare 原生 Git 集成从 GitHub `main` 构建发布，Pages 部署不依赖 GitHub Actions；辅助 Worker 有变更时，从已推送提交的干净检出单独发布，当前仅其代码上传使用官方 Wrangler。先部署变化的辅助 Worker，再发布依赖它的 Pages，不改变 Pages 静态优先架构。内部入口保护、上传命令和真实环境验收见 [运维说明](../docs/operations.md)。本文描述运行合同，不代替远端部署和验收记录。
