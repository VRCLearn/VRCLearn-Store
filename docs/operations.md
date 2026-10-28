# 配置与运维

## 工具与环境

账户查询和经授权的资源管理优先使用 `cf` CLI：D1、R2、KV、Pages 项目与域名、Turnstile、Access 和边缘规则均通过其对应资源命令处理。用 `cf cli search` 查找命令、`cf schema` 检查精确请求，搜索文字不包含账户、域名或资源标识。写入前核对已有资源，结果不明确时先读回，不直接重试创建。

Pages 使用 Cloudflare 原生 Git 集成连接 `VRCLearn/VRCLearn-Store`，生产分支为 `main`，由 Cloudflare 拉取已推送的明确提交构建和部署，Pages 部署不依赖 GitHub Actions。生产构建命令为 `npm ci && npm test && npm run build && npm run preflight`，输出目录为 `dist`，根目录为仓库根目录，构建镜像为 v3。仓库 `.node-version` 固定 Node.js 版本；`wrangler.jsonc` 的 vars 声明 `SKIP_DEPENDENCY_INSTALL=1` 并同步到 Pages 构建环境，避免 Git 部署覆盖仪表盘设置后恢复自动安装；依赖由命令中的 `npm ci` 按锁文件安装一次。关闭非生产分支自动预览部署，避免生产绑定进入其他分支及消耗构建配额。浏览器回归在推送前本地运行，Cloudflare 构建不依赖本机 Chrome。

`wrangler.jsonc` 是 Pages Functions 配置的唯一来源，Git 构建沿用其中的 D1、R2、KV、Service Binding、Durable Object、CPU 和兼容日期；Secret 通过 Cloudflare 加密环境变量配置。生产与预览均保持 `fail_open=false`，不能将预检通过当作远端绑定或 Access 已生效的证据。每次发布核对 Cloudflare 生产部署的提交 SHA 与 GitHub `main` 一致，并检查构建日志、部署状态、自定义域及默认入口的实际响应。

现有 Direct Upload 项目不能原地改成 Git 集成。重建时先提交并推送全部有效代码及文档，保存旧项目配置和 Access 策略，然后仅删除旧 Pages 项目，再创建同名 Git 集成项目。保留原 D1、两个 R2 桶、KV、辅助 Worker、配额 Durable Object、Turnstile 与 Access 应用；不要运行数据库重置、重新初始化管理员或媒体清理。创建时即配置 fail closed，并在首次构建前恢复必要 Secret、资源绑定与入口保护。域名绑定完成后，核对正式域、根默认域、hash／分支默认域及媒体域匿名访问均转入 Access；不能只验证正式域。内测允许重建期间短暂不可用，不能以临时公开入口替代 Access。

辅助 Worker 由独立配置管理。需要更新它时，从 GitHub 已推送提交的干净检出构建，先部署辅助 Worker，再发布依赖其 Service Binding 的 Pages；仅 Pages 前端和 Functions 变化时无需重复上传辅助 Worker。当前 `cf` beta.18 无法直接上传既有 Wrangler Worker 项目，仅此上传步骤使用已安装的官方 Wrangler：

```powershell
npx.cmd --no-install wrangler deploy --config worker/wrangler.jsonc
```

部署前完成类型生成、测试、构建、`npm.cmd run preflight` 及绑定／Secret 检查。不得从含未提交改动的工作区上传生产代码，也不得将 `--dry-run` 成功写成远端部署成功。上传后用 `cf` 读回 Worker 版本、绑定、触发器及 Pages 部署状态。Worker 上传所需凭据只传给相应子进程，输出须捕获并脱敏；凭据及未脱敏响应不得进入仓库或持久日志。Windows 本机 Worker 部署使用仅当前用户可连接的命名管道向 Wrangler `--secrets-file` 提供秘密 JSON，不创建明文秘密文件；长期凭据仅在仓库外保留 DPAPI 加密副本。

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

两个运行时配置已填写实际账户／zone、共享 D1／KV 和桶名，Pages 已配置正式域的 Turnstile 公钥，辅助 Worker 已填写两条实际紧急规则 ID。更换资源时同步修改绑定和相关标识。绑定类型由配置生成，修改配置后运行 `npm.cmd run types`。不要手改生成声明来掩盖配置错误。

Pages secrets：`TURNSTILE_SECRET_KEY`，可选的缓存清理凭据。辅助 Worker 的五个必需 secrets 已声明并注入：`BETTER_AUTH_SECRET`（随机高熵，至少 32 字符）、`TURNSTILE_SECRET_KEY`、限定该账户 Billing Read 的 `CF_MONITOR_TOKEN`、限定目标 zone 的 WAF 规则读写 `CF_API_TOKEN`、运维收件人 `ALERT_EMAIL`。预检验证五个 secret 名称的声明，并拒绝把 `ALERT_EMAIL` 放入公开 vars；它不读取或证明远端 secret 值。规则 token 的资源范围是 zone，不能把代码内的指定规则检查当成 token 本身的规则级授权。发信使用原生 EMAIL 绑定，限制 `noreply@vrclearn.com`；域名已启用不代表投递已验证，内部测试仅向确认的测试邮箱发送必要邮件。

当前 Windows 开发机器的账单和紧急停机令牌以用户级 DPAPI 保存于仓库外，均于 2027-01-25 到期。本机入口 `pwsh -File .cloudflare/cf-billing.ps1 get-info-v1` 可读取覆盖信息，将操作改为 `get-v1` 可读取用量。该本机脚本和元数据均由 Git 忽略，不随仓库分发。脚本仅给 `cf` 子进程设置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`，不覆盖默认 OAuth 或全局环境。Billing-only 令牌不应依赖账户枚举来选择账户；该令牌已注入辅助 Worker 的 `CF_MONITOR_TOKEN`，禁止输出 secret 值。轮换时保持账单与 WAF 令牌的权限分离，并核验远端 secret 名称。

Microsoft Store 版 Codex 会将 AppData 写入重定向至应用的 LocalCache。实际加密存储位置由本机忽略文件 `.cloudflare/credential-store.json` 记录；账单、部署和内测凭据助手读取同一物理目录，不能依赖普通终端与打包应用对逻辑 AppData 路径的视图相同。受托管理的内测密码、TOTP 密钥和恢复码也使用当前 Windows 用户的 DPAPI 加密；本机验证码助手只生成短期验证码，不输出密码、密钥或恢复码。

D1 按文件顺序应用 `0001_business.sql`、`0002_auth.sql`、`0003_revision_storage.sql`，然后部署依赖这些表和触发器的代码。核对实际迁移记录、业务／认证表、FTS5 虚表及修订计量触发器，并执行外键检查；迁移错误时先查已应用状态，不重复整批执行。第三个迁移先计量现有修订，再对新增或增长内容实施全站与店铺配额；已有内容超过配额时仍允许等量或减量替换。调整 `revision_storage_policy` 前核对实际容量和费用，不直接改写计量表。

初始化管理员时，在受控的本地或已授权数据库操作中将已验证账户 ID 加入 `user_profiles` 并设 role='admin'；禁止自动把第一位注册用户设为管理员。管理员登录后必须启用 TOTP 并验证当前会话，保存恢复码后再使用审核台。首次完成 MFA 设置会撤销其他已有会话；密钥和恢复码仅在初始设置中交付，公开认证接口不提供再次导出或生成恢复码的入口。

账户使用邮箱和密码登录，注册界面填写昵称，不设置独立用户名。自定义认证门禁遵循 Better Auth 的平面错误结构 `code`／`message`／`requestId`，客户端保留 SDK 返回的真实 HTTP 状态。未来 HopeWriteDream 账号关联不属于当前部署，现有账户 schema 未为此改动。

## 上线访问规则

1. Pages 自定义域设为 `store.vrclearn.com`，动态入口校验 ORIGIN。保护或关闭默认 `pages.dev`、预览和旧部署入口，不把生产绑定复制到公开预览。
2. 辅助 Worker 保持 `workers_dev=false`、`preview_urls=false` 且无公共路由。不得公开 `/internal/session`。
3. Turnstile 仅允许正式域，注册／登录 action 为 `auth`，上传为 `upload`，提交审核为 `submit`；服务端逐项验证 hostname 和 action。
4. 媒体桶边缘规则必须在缓存命中之前执行，拒绝未知国家和不符合地区前缀的请求：大陆只允许 `/cn/`，其他已知国家只允许 `/intl/`。仅 Access 的精确授权回调 `/cdn-cgi/access/authorized` 排除地区路径检查，该回调仍由 Access 处理；其他路径拒绝。不能仅靠 Referer、CORS 或隐藏链接保护地区内容。
5. 媒体 Cache Rule 的边缘 TTL 不超过 60 秒，禁止 Cache Everything 把动态 HTML 按原始 URL 共享。现有媒体规则仅匹配正式媒体域的 `/cn/`、`/intl/`，边缘采用 `bypass_by_default`，浏览器采用 `respect_origin`，不覆盖已审核对象的来源缓存时效。商品图片路径包含不可复用的提交令牌。
6. Pages 函数故障采用 fail closed，静态文件中不得包含私有数据或需要函数保护的生产内容。

## 内部测试入口

内部测试 Access 的允许策略仅包含 `email_domain: vrclearn.com`。当前应用同时允许新建的邮箱 One-time PIN 来源与现有 Cloudflare 登录来源；任意 `@vrclearn.com` 邮箱可选择邮件验证码登录，Cloudflare 登录来源另外受其账户成员限制。新的 OTP 已通过 `cqmhv@vrclearn.com` 真实收码与登录测试，成功身份的来源与新 OTP 配置一致。`auto_redirect_to_identity=false`、24 小时会话、HttpOnly Cookie、eager redirect cookie 以及正式站点、媒体、根 Pages 默认域和通配预览域四个保护目标保持启用。Cloudflare Access 只决定是否可以访问测试站，不代替商店的邮箱密码登录、邮箱验证、商家权限和管理员 MFA。

将 `store.vrclearn.com` 与 `store-media.vrclearn.com` 放入同一个 self-hosted 多域 Access 应用，使用一致的允许策略并开启 eager redirect cookie，让首次登录同时为两个明确域建立访问 cookie。用真实浏览器确认媒体 `<img>` 不会被登录重定向替代；不能把 CORS、Referer 或已登录主站作为媒体域获准的证据。[Access 多域 cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)

Pages 自定义域须先完成绑定与证书验证，再启用该域的 Access；初始绑定期间不开放业务内容。R2 则应先建立 Access 应用，再连接媒体自定义域，避免连接瞬间公开桶内容。两桶的 `r2.dev` 及其他公开域保持关闭。媒体地区 WAF 与 Access 的登录回调组合须实测，不为排障宽泛跳过安全规则。[Pages 自定义域限制](https://developers.cloudflare.com/pages/platform/known-issues/)、[R2 Access 顺序](https://developers.cloudflare.com/r2/tutorials/cloudflare-access/)

Pages 的“Enable access policy”默认只保护预览，不覆盖根 `vrclearn-store.pages.dev` 或自定义域。分别核验根默认域、`*.<project>.pages.dev` 的 hash／分支／旧部署，以及两个自定义域的策略；匿名请求静态页和动态入口均不得绕过。Pages 官方内建流程分别创建根域与预览应用；通过 API 配置单个多域应用时，仍须确认 Pages 默认域关联与实际拦截，不能仅凭 destinations 写入成功认定入口已保护，也不能仅依赖函数中的 ORIGIN 校验保护静态内容。[Pages 默认域保护步骤](https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain)

## 费用维护与恢复

每 15 分钟只执行一批监控与维护，不递归调度。上传与发布使用多层限额：用户、全站、每日／月度，以及 D1 原子维护的私有与公开对象合计 8 GiB 存储预留。R2 超时结果不明确时保留预留；24 小时后由有界维护核实并删除未引用对象，再释放预留。

费用检查先要求 V1 info 的 `covered=true` 与有效订阅，再显式查询当前账期。正常估算写入 `coverageBasis: "provider-account"`；`coverage` 仅列出实际识别到的产品族，不能把缺失的 Logs 行写成已核实零费用。账户覆盖合同、每指标 36 小时时效、未知产品费用累计及失败语义见 [费用说明](costs.md)。本地真实响应估算通过不能代替上线后 Cron、secret、KV 持续更新和失败路径验收。

在同一 zone 的 `http_request_firewall_custom` 活跃入口规则集中预先创建两条**禁用**的紧急 block 规则：动态入口表达式精确匹配 `dynamicBlockExpression(ORIGIN)`，媒体表达式精确匹配 `mediaBlockExpression(MEDIA_ORIGIN)`。填写 EDGE_RULESET_ID、EDGE_RULE_ID、EDGE_MEDIA_RULE_ID，两个运行时的 MEDIA_ORIGIN 必须一致。紧急规则应置于可能跳过后续自定义规则的 skip 规则之前。

监控先验证活跃入口的 ID、kind、phase 和对应规则表达式，再保留已核验的裸 block 规则定义进行 PATCH：action 为 block，expression 原文不变，description／ref 存在时原样携带，仅将 enabled 改为 true。不发送 id、version、last_updated 或 position；发现额外动作参数、日志配置等未支持的设置时拒绝更新该条，避免完整定义替换时丢失行为。一条写入失败不阻止另一条，再读取一次活跃入口核验，不自动重试写入。`edgeDynamicBlocked`、`edgeMediaBlocked` 分别记录核验结果，只有两者均确认生效才记录 `edgeBlocked:true`。KV 读取或持久化失败会强制尝试同样的双域封锁，不以 KV 可用为前提。缺失规则或无写权限仍需人工处理，不能把应用维护响应当作边缘请求已免费阻断。

达到维护模式后，静态首页仍可访问，业务 API、详情、sitemap、认证和内部会话入口返回暂停；定时维护跳过媒体和认证清理，DO 仅继续有界排空账本。受限模式仍允许密码登录，但禁止账户发信和高成本业务。KV 读取失败时应用动态入口也拒绝继续执行。恢复时必须先核对 Cloudflare 控制台的实际使用量、攻击状态和监控源，人工关闭动态与媒体两条紧急规则并写入经核实的新 `budget:state`；不要清空 KV、伪造费用为零或部署自动开关循环。缺失、畸形、超过 30 分钟或明显来自未来的状态不能开启生产高成本功能。

配额账本有到期索引和 100,000 条硬上限。每个获批操作最多清理 32 条，Alarm 每批最多清理 1,000 条；过期积压按最短 60 秒继续，正常时调度到最早到期，空账本停止 Alarm。容量不足和 Alarm 持久化失败均不放行操作；不要通过删除尚未到期的计数或重放记录恢复可用性。

私有上传未附加到有效草稿／当前发布版超过 24 小时后可清理；未发布草稿 30 天不更新后视为过期，图片可能清理，重新编辑需补传。每次至多清理 25 个旧公开图片、25 个私有图片和 25 个孤立预留，并清理至多 100 条过期会话与验证记录。R2 删除失败不释放预留，后续批次重试。

首次发布及同内容首次新增地区按区独立审核。仍有待审或获批但尚未成功发布的地区时，修订保持 `pending` 并锁定编辑，已批准且有效上架的地区仍可公开。内容修改须先保存新修订，所有当前上架地区均通过后统一切换；新增地区的待审或拒绝不构成额外屏障。已决定地区再次申请须保存新修订，不覆盖原批准或拒绝记录。撤回只取消未决审核，已上架地区保留；下架、撤权及封禁同时使旧发布任务失效，避免迟到任务复活已撤销内容。管理台仅在确有可发布但尚未完成的地区时提供重试，商家界面逐区显示状态与理由。

## 真实环境验收

以下为截至 2026-10-28 的内测验收记录，表内服务端时间明确标注 UTC。最新 Pages 生产版本以 Cloudflare 的 canonical deployment 及其关联 Git 提交为准；重建 Pages 不会重置这些业务数据。

| 项目 | 实际结果 |
| --- | --- |
| 辅助 Worker | `148212b3-faac-48db-b678-d6c35069aeea` 已部署，启动 38 ms，配置每 15 分钟触发器；仅 Service Binding，无公开路由 |
| Pages | 已在 2026-10-28 重建为同名 Git 集成项目，ID 为 `49f24811-18b6-4778-a6c3-bb73278bb7da`，连接 `VRCLearn/VRCLearn-Store` 的 `main`。首次原生构建 `a792bd9f-542f-4ac2-8ef2-d856f53002d8` 从提交 `1eb6727` 克隆，Cloudflare 执行锁文件安装、288 项测试、构建及预检后部署成功，GitHub 的 Cloudflare Pages 检查通过；后续当前版本以 canonical deployment 关联 SHA 为准 |
| 数据与绑定 | Pages 重建前后 D1 仍有 3 个账户、2 个店铺、1 个商品、3 个修订、2 条有效地区发布、1 条私有媒体及 2 条公开媒体记录；两个 R2 桶、KV、认证 Worker 与配额 Durable Object 均沿用原资源，未重置数据库、媒体或管理员。五个 Worker Secret 保留，Pages Turnstile Secret 已通过当前用户专用内存管道恢复 |
| 媒体 | 两桶 `r2.dev` 已关闭；正式媒体自定义域最低 TLS 1.2、SSL 状态 active；地区 WAF 仅排除 Access 精确授权回调。最终国际区图片实际返回 200，非磁盘缓存、CDN `HIT`，响应为 `image/jpeg`、53,991 字节、`max-age=60, s-maxage=60`，实际解码为 1910×851；同一国际出口请求对应 CN 图片实际返回 403，非磁盘缓存，匿名国际区请求仍转入 Access。用户已明确延期真实中国网络测试，此项不阻断本次受保护内测交付 |
| Access 准入与匿名入口 | 新邮箱 OTP 与 Cloudflare 登录并存，仅允许 `@vrclearn.com` 邮箱域，四个保护目标、策略、登录来源、24 小时会话和 Cookie 配置与重建前一致。首次原生构建后，正式静态页、API、根默认域、hash 默认域、main 分支域及媒体六项匿名探测均为 Access 302；原已获准浏览器会话正常读取搜索结果，站点自定义域验证和证书状态 active |
| 浏览器与公开读取 | 所有者实际通过 Access 打开首页；最终分区验收修订的简中、英文、日文详情原始 HTML 均返回 200、`private, no-store`，包含最新正文与 Product 结构化数据，三语响应均仅引用国际区图片。搜索和收藏实际返回 200 及当前新内容，三语 sitemap 均为 200 且包含该商品。这些实测来自国际出口 |
| 店铺详情 SEO | 已获批店铺的简中、英文、日文原始 HTML 均实际返回 200，包含店铺正文、标题、对应语言 canonical、Open Graph 和 Organization 结构化数据；三语响应均为 `private, no-store` 并带 nonce CSP，源码不含草稿商品 |
| 账户与邮件 | 所有者已完成真实 Turnstile 注册、验证邮件与密码登录；D1 确认邮箱、TOTP 均已验证且当前会话有有效 MFA 证明，账户页显示双重身份验证已启用。当前 500 ms CPU 配置下流程可用，尚未取得逐请求 CPU 测量值 |
| 管理员 | 经所有者批准已初始化内测管理员，后续指定的内测账户也已按授权授予角色。角色授予本身不绕过邮箱验证与当前会话 MFA 门禁；审核台仍强制检查两者 |
| 费用状态 | 人工恢复后，线上 Cron 持续成功核验真实来源；17:15:47 UTC 自动采样为 `normal`、5 美元、`coverageBasis: "provider-account"`，未人工触发任务。17:24:36 UTC 读回确认 Pages 仍为 FD 部署、媒体地区 WAF 启用，两条紧急停机规则均禁用 |
| 商家与发布 | 内测店铺资料和两区权限已分别审核；首份商品在正常界面完成两区审核并上架。同一商品的新修订也已真实提交：仅 CN 批准时，两区仍指向旧版且候选公开图片为零；国际区批准后，两区原子切换至修订 `4c5dcaaf-b17a-4a81-9667-c62c4dc954ab`，公开图片两份，旧版图片记录清零。真实搜索在切换前不返回修订关键词，切换后返回新内容。发布与换版均未触发 Pages 构建 |
| 未审核内容隔离 | 首次发布前，草稿搜索为空、详情拒绝、三语 sitemap 不含草稿；修改后的草稿也未替换旧版公开内容。店铺审核前同样验证未进入三语 sitemap。实测来自国际出口 |
| 图片上传 | 普通浏览器已上传一张 53,991 字节、1910×851 的截图；实际检测类型及公开响应为 JPEG，D1 媒体记录、草稿引用和真实解码一致。原私有图及审核后的公开图均已读取成功 |
| 发现、收藏与举报 | 真实中文二元词检索叠加分类、PC、免费、标签及适配模型筛选返回目标商品；收藏写入及按地区读取均为 200。测试举报返回 201、进入管理员队列，并通过正常界面处理为 `resolved`，D1 确认一条对应处理审计 |
| 分区审核修复 | 分区验收修订 `4be2d32a-d48f-4586-ae98-85d8e59c81a0` 已真实提交。仅 CN 批准时，D1 确认其成为当前修订、CN 有效上架且只有一份 CN 公开图片，国际区仍待审且未上架，修订保持 `pending`；国际出口的 API／HTML 为 404，搜索为空、收藏 `product:null`、三语 sitemap 不含商品。国际区随后通过正常审核；17:21:39 UTC 读回确认该修订为当前 `published`、两区均批准并有效上架、公开图片两份，原 CN 媒体令牌不变，保留此状态供内测使用 |
| 下架与缓存 | 此前下架验收中，CN 下架后，D1 确认仅 CN 失效及对应公开图片删除，国际区保持上架且原图片实际返回 200。国际区于 17:01:37 UTC 下架后，D1 确认两区均失效、公开图片记录为零、私有原图保留一份。原国际区图片的确切 URL 于约四分钟后的抽样返回 404，非磁盘缓存且 `CF-Cache-Status: BYPASS`；随后商品 API 与 HTML 均为 404／`no-store`，HTML 带 `noindex`，搜索为空，收藏保留记录但 `product:null`，三语 sitemap 均为 200 且为空。图片响应 TTL 为 60 秒，详情内部缓存上限 60 秒；此次抽样确认最终撤销，不证明在 60 秒内完成，时限约束由实现及本地测试覆盖 |
| 提交交互 | 真实保存及工作台刷新均为 200，两区勾选在保存后保留。首份商品、内容修订和最终分区验收修订均已通过真实验证提交并完成审核。界面有 Material 进度、错误与手动重试，配置／脚本各限 15 秒、首次验证限 120 秒；失败清令牌与旧实例，不自动重试，不接受旧回调恢复令牌 |
| 真实停机演练 | 经明确批准，于北京时间 21:34:45–21:35:53 完成。启用期动态配置 API 与媒体返回 403；静态入口仍可进入 Access，已有 Access 会话的静态维护页实际返回 200，未使用磁盘缓存或 Service Worker；观察时间早于两条规则的恢复更新时间。恢复后各探测入口重新返回 Access 302，两条规则均关闭，定义、顺序及其他规则保持一致 |
| 本地验证 | 288 项单元／集成测试、52 项桌面／移动端浏览器回归，以及构建、类型检查和部署预检通过；新增覆盖部分发布、旧区换版屏障、审核决定保留、扩区、媒体失败与撤销并发、提交状态竞争、地区结果及重试界面；另有 9 项停机演练纯 mock 测试通过 |

内部测试代码与业务闭环已完成验收，当前仍受 Access 保护，新邮箱 OTP 与 Cloudflare 登录均已配置，最终测试商品保留双区上架。注册、验证邮件、密码登录、MFA、管理员、商家入驻、两区权限、商品分别审核、公开详情／图片、搜索筛选、收藏和举报处理已有真实证据；修订期间保留旧版、两区统一切换、首次单区先上架而另一地区待审时的国际区隔离，以及单区下架保留另一地区、最终撤销公开读取也已验证。费用监控和双域停机演练已通过。密钥与恢复码按授权保存在本机用户级 DPAPI 加密存储，不进入仓库。

这些结果不代表全部生产边界均已逐项实测。Cloudflare HTTP Analytics 确认最终详情及媒体读取来自日本出口，详情在国际区批准前为 404、批准后为 200，国际区图片为 200。真实中国网络的正向及反向访问由用户明确延期，不阻断本次内测交付；真实拒绝、同内容新增区和并发异常等边界已有本地覆盖，未额外执行生产演练。逐请求密码计算 CPU 数值尚未取得。下架抽样没有验证 60 秒截止时间，不能将配置和测试中的时限写成真实观测结果。

每项记录目标部署 ID、时间和实测结果。使用专用商店资源、一店一商品和一张小型有效图片完成以下闭环，不执行无界压测、轮询或向其他收件人发信。

1. 核对迁移、实际绑定、CPU 上限、secret 名称、Cron 与 Service Binding；辅助 Worker 无公开入口，私有桶无公开访问。未登录时测试正式域、媒体、默认域及部署别名的静态和动态路径，确认 Access 拒绝绕行。
2. 按实际启用的 Access 来源完成登录，检查两域 cookie；邮箱 OTP 发码须处于用户明确授权的验证范围内。普通静态首页和资源不调用 Functions，不主动检查应用会话。动态 API 故障时，已获准访问的用户仍可打开静态说明和维护页面。
3. 使用真实 Turnstile 完成一次注册、必要的邮箱验证和密码登录；检查原生 scrypt 在辅助 Worker 500 ms CPU 上限内可用，并记录执行结果。不得降低密码参数或使用测试 challenge 替代真实生产验证。测试密码找回时核对一次性链接和会话撤销，并保持既有邮件配额。
4. 仅提升明确批准的所有者账户为管理员，写入时校验邮箱、MFA 与当前有效会话，并记录初始化审计；未完成当前会话 MFA 时审核接口应拒绝。由所有者完成 TOTP 绑定确认，按其选择保管密钥和恢复码；受托管理使用受控本机用户级 DPAPI 加密存储，不写入仓库。验证成功后检查当前会话与安全 cookie，再打开审核台。
5. 完成商家入驻、店铺资料审核、CN／国际发布权限申请及分别审核、草稿、私有图片预览、商品提交和发布。验证搜索、筛选、收藏、详情源码与分享元数据、sitemap 和媒体；修订审核期间旧版继续展示，下架后目录、详情和公开图片最迟 60 秒不可见，期间没有 Pages 全站构建。
6. 从真实 CN 与国际网络出口检查 API、HTML、收藏、sitemap、媒体前缀隔离及未知地区拒绝；浏览器切换语言不能切换商品区。没有对应出口时明确记录尚未远端验证，不能通过自定义国家请求头冒充 Cloudflare 地区判断。
7. 确认定时监控从真实来源写入新状态及 `coverageBasis`，费用源失败至少受限、配额故障拒绝昂贵操作。受控停机演练先保存现状，短暂启用两条预配置紧急规则并读回，再实测动态与媒体封锁、静态说明可用；人工恢复前核对真实费用与规则。禁止以假零金额或清空 KV 绕过保护。

## 正式公开上线前

必须先提醒所有者清空内测数据库，避免把测试账户、会话、MFA、商家、商品和审核记录带入正式服务。该提醒不授权立即删除；执行前另行确认目标 D1 与具体重置范围，并核对 R2 测试媒体和 KV 配额状态，不能影响其他项目。重置后重新应用迁移并初始化正式管理员。

欧盟 IP 封锁在最终上线阶段配置，覆盖正式站点、媒体、默认域和预览。EU 国家集合为 AT、BE、BG、HR、CY、CZ、DK、EE、FI、FR、DE、GR、HU、IE、IT、LV、LT、LU、MT、NL、PL、PT、RO、SK、SI、ES、SE，不扩展为英国或整个欧洲。
