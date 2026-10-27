# 配置与运维

## 工具与环境

账户查询和经授权的 Cloudflare 管理操作使用 `cf` CLI。用 `cf cli search` 查找命令、`cf schema` 检查精确请求，搜索文字不包含账户、域名或资源标识。仓库中的 Wrangler 配置供 Pages 和运行时工具读取；Wrangler 仅用于本地类型生成、函数编译、平台模拟及 `--dry-run` 打包，不用于查询账户或写入远端。

开发前端：`npm.cmd run dev`。本地平台模拟分别使用 `npm.cmd run dev:worker` 和构建后的 `npm.cmd run dev:pages`；复制根目录和 `worker/` 中的 `.dev.vars.example` 为各自 `.dev.vars`，把两处 ORIGIN 设成同一个本地 Pages 地址并设 ENVIRONMENT=development。不要在本地配置真实邮件绑定或生产 API token。IP 地区验证不接受自定义地区请求头；不具备可信 `request.cf.country` 的本地请求会拒绝商品内容，完整地区行为由集成测试覆盖。

## 资源合同

| 绑定 | 用途与要求 |
| --- | --- |
| DB | 独立的 `vrclearn-store` D1；两个运行时共享同一数据库 |
| PRIVATE_MEDIA | 私有图片桶，关闭所有公开访问 |
| PUBLIC_MEDIA | 展示图片桶，仅绑定 `store-media.vrclearn.com`，关闭 r2.dev |
| STATE | 共享 KV，记录目录版本、费用保护状态 |
| AUTH | Pages 到 `vrclearn-store-support` 的 Service Binding |
| QUOTA | 辅助 Worker 导出的 SQLite Durable Object `QuotaGate` |
| EMAIL | 仅辅助 Worker 配置，限制发件人为 `noreply@vrclearn.com` |
| AUTH_RATE_LIMIT | 辅助 Worker 的快速认证限流绑定 |

部署前在配置中填写实际 CF_ACCOUNT_ID、CF_ZONE_ID，并在两个配置中填写相同的 D1、KV ID 和桶名。绑定类型由配置生成，修改配置后运行 `npm.cmd run types`。不要手改生成声明来掩盖配置错误。

Pages secrets：`TURNSTILE_SECRET_KEY`，可选的缓存清理凭据。辅助 Worker secrets：`BETTER_AUTH_SECRET`（随机高熵，至少 32 字符）、`TURNSTILE_SECRET_KEY`、限定该账户 Billing Read 的 `CF_MONITOR_TOKEN`、限定目标 zone 的 WAF 规则读写 `CF_API_TOKEN`。规则 token 的资源范围是 zone，不能把代码内的指定规则检查当成 token 本身的规则级授权。发信域已启用不代表所有邮箱服务商投递已验证，仍需单独授权测试真实邮件。

D1 按文件顺序应用 `0001_business.sql`、`0002_auth.sql`、`0003_revision_storage.sql`，然后部署依赖这些表和触发器的代码。第三个迁移先计量现有修订，再对新增或增长内容实施全站与店铺配额；已有内容超过配额时仍允许等量或减量替换。调整 `revision_storage_policy` 前核对实际容量和费用，不直接改写计量表。

初始化管理员时，在受控的本地或已授权数据库操作中将已验证账户 ID 加入 `user_profiles` 并设 role='admin'；禁止自动把第一位注册用户设为管理员。管理员登录后必须启用 TOTP 并验证当前会话，保存恢复码后再使用审核台。首次完成 MFA 设置会撤销其他已有会话；密钥和恢复码仅在初始设置中交付，公开认证接口不提供再次导出或生成恢复码的入口。

## 上线访问规则

1. Pages 自定义域设为 `store.vrclearn.com`，动态入口校验 ORIGIN。保护或关闭默认 `pages.dev`、预览和旧部署入口，不把生产绑定复制到公开预览。
2. 辅助 Worker 保持 `workers_dev=false`、`preview_urls=false` 且无公共路由。不得公开 `/internal/session`。
3. Turnstile 仅允许正式域，注册／登录 action 为 `auth`，上传为 `upload`，提交审核为 `submit`；服务端逐项验证 hostname 和 action。
4. 媒体桶边缘规则必须在缓存命中之前执行，拒绝未知国家和不符合地区前缀的请求：大陆只允许 `/cn/`，其他已知国家只允许 `/intl/`。其他路径拒绝；不能仅靠 Referer、CORS 或隐藏链接保护地区内容。
5. 媒体 Cache Rule 的边缘 TTL 不超过 60 秒，禁止 Cache Everything 把动态 HTML 按原始 URL 共享。商品图片路径包含不可复用的提交令牌。
6. Pages 函数故障采用 fail closed，静态文件中不得包含私有数据或需要函数保护的生产内容。

## 费用维护与恢复

每 15 分钟只执行一批监控与维护，不递归调度。上传与发布使用多层限额：用户、全站、每日／月度，以及 D1 原子维护的私有与公开对象合计 8 GiB 存储预留。R2 超时结果不明确时保留预留；24 小时后由有界维护核实并删除未引用对象，再释放预留。

在同一 zone 的 `http_request_firewall_custom` 活跃入口规则集中预先创建两条**禁用**的紧急 block 规则：动态入口表达式精确匹配 `dynamicBlockExpression(ORIGIN)`，媒体表达式精确匹配 `mediaBlockExpression(MEDIA_ORIGIN)`。填写 EDGE_RULESET_ID、EDGE_RULE_ID、EDGE_MEDIA_RULE_ID，两个运行时的 MEDIA_ORIGIN 必须一致。紧急规则应置于可能跳过后续自定义规则的 skip 规则之前。

监控先验证活跃入口的 ID、kind、phase 和对应规则表达式，只更新预配置规则的 `enabled:true`；一条写入失败不阻止另一条，再读取一次活跃入口核验，不自动重试写入。`edgeDynamicBlocked`、`edgeMediaBlocked` 分别记录核验结果，只有两者均确认生效才记录 `edgeBlocked:true`。KV 读取或持久化失败会强制尝试同样的双域封锁，不以 KV 可用为前提。缺失规则或无写权限仍需人工处理，不能把应用维护响应当作边缘请求已免费阻断。

达到维护模式后，静态首页仍可访问，业务 API、详情、sitemap、认证和内部会话入口返回暂停；定时维护跳过媒体和认证清理，DO 仅继续有界排空账本。受限模式仍允许密码登录，但禁止账户发信和高成本业务。KV 读取失败时应用动态入口也拒绝继续执行。恢复时必须先核对 Cloudflare 控制台的实际使用量、攻击状态和监控源，人工关闭动态与媒体两条紧急规则并写入经核实的新 `budget:state`；不要清空 KV、伪造费用为零或部署自动开关循环。缺失、畸形、超过 30 分钟或明显来自未来的状态不能开启生产高成本功能。

配额账本有到期索引和 100,000 条硬上限。每个获批操作最多清理 32 条，Alarm 每批最多清理 1,000 条；过期积压按最短 60 秒继续，正常时调度到最早到期，空账本停止 Alarm。容量不足和 Alarm 持久化失败均不放行操作；不要通过删除尚未到期的计数或重放记录恢复可用性。

私有上传未附加到有效草稿／当前发布版超过 24 小时后可清理；未发布草稿 30 天不更新后视为过期，图片可能清理，重新编辑需补传。每次至多清理 25 个旧公开图片、25 个私有图片和 25 个孤立预留，并清理至多 100 条过期会话与验证记录。R2 删除失败不释放预留，后续批次重试。

## 最终上线验收

- 实际绑定、迁移、原生 scrypt 的 Worker CPU／内存表现、真实发信和退信、Turnstile、MFA 和 cookie。
- 两个地区从 API、详情、收藏、sitemap 和媒体 URL 访问均隔离；关闭默认域和预览绕行。
- 发布／下架无需 Pages 构建，旧缓存最多保留 60 秒；紧急规则启用与人工恢复可用。
- 确认有效的成本源及其数据完整性，读取失败显示受限，不能记录为零。
- 欧盟 IP 封锁仅在最后上线时配置，覆盖正式站点、媒体、默认域和预览。EU 国家集合为 AT、BE、BG、HR、CY、CZ、DK、EE、FI、FR、DE、GR、HU、IE、IT、LV、LT、LU、MT、NL、PL、PT、RO、SK、SI、ES、SE，不扩展为英国或整个欧洲。

这些外部写入及真实环境验证尚未执行，须在获得部署或对应操作授权后完成。
