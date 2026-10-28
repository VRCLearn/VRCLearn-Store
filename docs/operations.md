# 运维说明

## 环境与资源身份

当前只允许 `test` 分支发布测试环境。`main` 保留将来的生产代码，生产清单必须保持 `enabled=false`、`provisioned=false`，云资源 ID 为空；生产发布命令应在发出任何 Cloudflare 请求前失败。

`deployment/environments.json` 是实际资源身份的唯一权威来源。测试主 Worker、辅助 Worker、D1、R2、KV、DO、认证限流、Access、Turnstile 和发布控制数据库均使用新建资源，名称以 `test-` 开头。旧数据不导入、不同步；配置存在不代表资源已创建或站点已完成验收。

资源操作优先使用 `cf`，GitHub 操作使用 `gh`。先以匿名任务描述执行 `cf cli search`，再用 `cf schema` 查参数；搜索中不包含账户、邮箱、域名或 ID。CLI 失败时先区分环境、网络和权限问题；未知写入先读回，不能直接重试。

## 首次创建前的退役检查

旧生产、旧测试和旧账户监控的部署、Cron、触发器、业务/控制数据、DO、域绑定、Access、Turnstile、专属令牌及商店专属规则须逐项退役并记录结果。旧部署、旧默认/预览入口与媒体不能再提供内容；旧发布任务不能在稍后重新发布。

按精确资源 ID 删除，不能按名称前缀批量处理。共享 zone、全局身份提供方、GitHub 连接、CLI 登录和其他项目保持不变；ruleset 只删除已核验的商店专属规则，不删除其他规则。令牌撤销与本地加密副本清理都须核验，不能只删除脚本中的变量。

全部旧资源清理验收通过之前，不创建或发布新业务资源。保留必要的脱敏退役收据；供应商保留的账单和审计历史不代表旧站仍在运行。

## 本地开发

使用 Node.js 24、`npm ci` 和仓库锁文件。云资源管理优先 `cf`；Vite/Miniflare/Wrangler 用于本地 Workers 运行时、类型生成、编译和资产上传。

将根目录 `.dev.vars.example` 复制为被忽略的 `deployment/.dev.vars`，填入随机生成且至少 32 字符的本地 `BETTER_AUTH_SECRET`，使用示例中的 Turnstile 测试密钥。本地 ORIGIN 和 MEDIA_ORIGIN 固定为 `http://127.0.0.1:4173`；本地绑定不指向云端资源。

```sh
npm run types
npx wrangler d1 migrations apply local-vrclearn-store --local --config deployment/local-app.jsonc
npm run dev
```

`npm run build` 输出 `dist/client` 和两个 Worker 的 Vite 构建配置；`npm run preview` 运行产物。一般页面和资源不应调用业务 Worker。正常本地请求没有可信 `request.cf.country` 时拒绝商品查询；用本地测试运行时 fixture 验证地区，不能让线上接受用户自定义国家头。

## 新测试环境初始化

1. 创建空业务 D1、两个空 R2 桶、新 KV、新业务 DO/限流、新发布控制 D1及独立 Secret。新库不复用旧资源 ID、密码哈希、会话、图片或配额。
2. 新建 Access 应用与发布用服务身份，用户范围保持 `@vrclearn.com`。先保护测试站点和媒体主机，再连接公开域名；主/辅助 Worker 关闭 `workers.dev` 和版本 URL，R2 关闭默认公开入口。
3. 创建测试 Turnstile；只为测试媒体域配置地区隔离与缓存规则。媒体 `/cn/`、`/intl/` 严格隔离，仅排除确切 Access 回调 `/cdn-cgi/access/authorized`。
4. 用 `deployment/release-control.sql` 初始化新测试发布控制数据库。该数据库不绑定运行时；只建立测试租约和迁移校验和，不复制旧发布状态。
5. 受控首次 bootstrap 用于注册新 Worker、配置最终绑定/Secret、CPU 限制并创建业务 DO；生成时显式使用 `bootstrap:true`，主 Worker 配置不写 `routes`，不绑定公网域名，不初始化旧数据，不把 bootstrap 当作正式发布。读回新 Worker tag、DO 命名空间及全部资源身份，再填清单；全部配置完整后才设置测试 `provisioned=true`。
6. 完成 GitHub 授权及 Workers Builds。普通发布仍严格要求已有完整绑定、Secret、关闭的默认入口和可核验的新资源，不为首次上线放宽门槛。首个正式可访问版本由 Git 构建执行完整链路，包括空业务库基线迁移。

常规发布的冒烟需要测试域名时，先确保 Access 已保护站点与媒体，再连接新域名；此时 bootstrap 不提供旧业务内容。随后运行 Git 发布，并读回两 Worker 的最终 SHA、版本和绑定后验收。不得为通过冒烟暂时关闭 Access，也不得把本地 bootstrap 的成功代替 Git 发布验收。

业务库的 `0001_initial.sql` 是固定摘要的空库基线。发布器只在库中无未知业务表时允许首次执行，迁移与账本在 D1 批处理中提交。不得改写已应用迁移；后续只自动执行明确安全的增量结构变更。

账户仅为内测邮箱/密码系统，不验证邮箱所有权，不发送账号邮件。首位管理员应先由所有者自行注册和保存密码，再核对新内部账户 ID 并显式赋权；不能按未经验证的邮箱自动初始化管理员。

## Workers Builds

测试主 Worker 连接 GitHub 的 `VRCLearn/VRCLearn-Store`，固定生产分支为仓库的 `test` 分支，不开启其他分支或临时 Preview 自动发布。这里的 Cloudflare“生产分支”只是测试 Worker 的发布分支，不代表商店生产环境开通。

构建命令：

```sh
npm ci
```

部署命令：

```sh
node scripts/release.mjs --environment test
```

固定构建变量为 `DEPLOYMENT_ENV=test`、`WORKER_NAME=test-vrclearn-store`。平台提供 `WORKERS_CI_BRANCH` 和 `WORKERS_CI_COMMIT_SHA`；发布器对照 Git checkout、远端分支 HEAD 和清单验证身份，再生成 `.wrangler/deploy/test` 配置。构建使用 `VRCLEARN_APP_CONFIG`、`VRCLEARN_SUPPORT_CONFIG` 和不可变 `RELEASE_SHA`，不能手动替换分支或 SHA 来发布其他源码。

发布只编译一次，依次上传 `dist/support/wrangler.json` 和 `dist/app/wrangler.json` 指向的产物。资产与主 Worker 代码属于同一主 Worker 版本；辅助 Worker 和数据库仍是独立状态，不能宣称整个应用或数据库可原子回滚。项目不使用部署用 GitHub Actions。

常规主 Worker 配置声明精确的测试主机 `routes:[{pattern:"test-store.vrclearn.com",custom_domain:true}]`，构建预检拒绝缺失、额外或生产域路由。辅助 Worker 没有公开路由；默认入口和版本 URL 关闭状态还须通过远端读回核验。

构建部署凭据只在构建期出现，需要账户级 Workers Scripts/D1 编辑、KV/Account Settings 读取，以及仅 `vrclearn.com` 的 Workers Routes 编辑以维护测试自定义域。它不授予账单、WAF、DNS 编辑或 R2 数据权限。Cloudflare 账户权限覆盖账户内同类资源，资源清单不是额外的令牌权限边界。默认构建镜像无需安装 `cf`；发布器使用官方 REST API，编译产物/资产上传使用锁文件中的 Wrangler。

## Secret 与访问边界

| 位置 | 需要的 Secret |
| --- | --- |
| 主 Worker | 本测试环境 `TURNSTILE_SECRET_KEY` |
| 辅助 Worker | 本测试环境 `BETTER_AUTH_SECRET`、`TURNSTILE_SECRET_KEY` |
| Builds | 发布用 `CLOUDFLARE_API_TOKEN`、冒烟用 `CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET` |

没有 EMAIL、账单、WAF 或预算状态绑定。认证只通过本环境内部 Service Binding 提供，不公开内部会话查询入口。Cookie 使用 Secure、HttpOnly、SameSite=Lax，按主机限定；Access 不代替商店会话和角色检查。

只记录 Secret 名称、资源 ID、版本和结果，禁止输出值、Cookie、密码、验证码、响应原文或含秘密的环境 dump。运维凭据可在仓库外以当前用户 DPAPI 加密保存；不代管测试用户密码。失效或缺失凭据应明确失败，不能关闭保护以完成发布。

## 发布失败与人工恢复

发布总时限 12 分钟，锁等待最多 2 分钟；单次 API 请求最多 10 秒，只读连接/5xx 最多重试两次，429 不自动重试，写入不自动重试。旧 checkout 变为非分支 HEAD 时停止。任何可能已经上传、迁移或写入但结果不明的失败保留租约，过期不自动抢占。

恢复前确认旧构建及子进程已结束，分别读回业务迁移账本/结构、发布控制校验和、两个 Worker 的实际活跃版本和 SHA。必要时完成明确的人工修复；核对后按本环境、lease ID 和 SHA 解除原锁。不能清空所有锁、重新执行结果不明的迁移或用新推送覆盖未知结果。

若代码需要回退，先检查数据库结构和两个 Worker 的接口仍可运行；不自动回滚 D1、R2 或 DO。重新触发当前分支 HEAD 的完整发布，成功条件包括资源和版本读回及冒烟，而非仅上传命令退出成功。

## 验收

- 真实 Git 触发的构建对应当前测试 SHA，两 Worker 活跃版本、资源绑定、发布收据和 `/api/v1/config` 一致；生产发布在首次网络请求之前被拒绝。
- 新数据库没有旧账户、会话、商家或商品，媒体桶和业务配额为空；手动注册后再初始化测试管理员。
- 匿名访问站点/媒体被 Access 拦截，授权身份可访问；默认域和版本 URL不可用，R2 默认公开入口关闭。
- 静态页面与资源不执行主 Worker；详情源码有正文与分享元数据，API 不返回 SPA HTML，缺失路径不查询 D1。
- 登录、改密码、会话撤销、商家/地区权限、上传、审核、Adult CN 限制、搜索收藏、发布修订及下架正常；公开内容/媒体最长 60 秒失效。
- 完成桌面/移动端、三语、键盘、主题与错误状态检查；地区隔离的真实出口验收不能由语言切换或伪造请求头代替。

这些是必须验证的条件，不是对尚未完成部署的验收声明。

## 正式公开上线前

在准备正式公开、移除内部 Access 或开放公众访问之前，必须先提醒所有者清空内测数据库，并核对测试媒体、配额状态、旧会话和管理员初始化的处理范围。提醒不授权删除；当时须重新确认目标资源和影响范围，取得明确批准，再重置并重新迁移、初始化正式管理员。

开通生产、接入 Loginflare、移除 Access 及执行正式数据重置均属于另行明确的工作，不随 `test` 合并到 `main` 自动执行。
