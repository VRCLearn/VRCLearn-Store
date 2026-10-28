# 配置与运维

## 环境与资源

同一 Cloudflare 账户内运行生产候选和测试两套业务环境，均保持内部 Access 保护。测试资源名称统一以 `test-` 开头，代码绑定名保持通用。完整资源 ID、入口与固定分支由 `deployment/environments.json` 管理，`scripts/environment.mjs` 生成部署配置；不直接编辑生成文件或在合并时替换资源 ID。

| 项目 | 生产候选 | 测试 |
| --- | --- | --- |
| Git 分支 | `main` | `test` |
| Pages | `vrclearn-store` | `test-vrclearn-store` |
| 站点 | `store.vrclearn.com` | `test-store.vrclearn.com` |
| 媒体 | `store-media.vrclearn.com` | `test-store-media.vrclearn.com` |
| 辅助 Worker | `vrclearn-store-support` | `test-vrclearn-store-support` |
| D1 | `vrclearn-store` | `test-vrclearn-store` |
| 私有 R2 | `vrclearn-store-private` | `test-vrclearn-store-private` |
| 公开 R2 | `vrclearn-store-public` | `test-vrclearn-store-public` |
| KV | 保留现有生产资源 | `test-vrclearn-store-state` |

D1、两个 R2 桶、KV、辅助 Worker、配额 Durable Object 命名空间、认证限流命名空间、认证 Secret、Turnstile 和 Access 应用分别独立。测试不复制生产账户、会话、媒体或认证秘密。Cookie 按主机限定；测试邮件使用独立发件地址及明确测试标识，可发送给所有注册邮箱，仍受验证、限流和配额约束。两套的 `ENVIRONMENT` 均为 `production`，安全逻辑一致；`DEPLOYMENT_ENV=production|test` 仅用于确认部署身份。

账户总费用保护由独立 `vrclearn-store-account-monitor` Worker 负责，控制状态、告警配额与发布锁独立于业务资源。它不随 `test` 分支的常规发布更新。业务隔离针对可信开发中的缺陷、误操作和误配置；仓库检查不能防御拥有构建凭据的恶意代码。

## 工具与本地开发

资源管理优先使用 `cf`。先用匿名描述执行 `cf cli search`，再用匹配命令的 `cf schema` 检查参数；搜索文字不包含账户、邮箱、域名或标识。写操作结果不明确时先读回，不直接重试。Workers Builds 镜像不要求安装 `cf`；发布器使用 Cloudflare 官方 REST API，只有辅助 Worker 上传使用锁文件安装的官方 Wrangler，不执行 Pages Direct Upload。

本地使用 Node.js 24、仓库的 `.node-version` 和 `package-lock.json`：

```powershell
npm.cmd ci
npm.cmd run dev
npm.cmd run build
npm.cmd test
npm.cmd run test:browser
```

`npm run dev:worker` 和 `npm run dev:pages` 使用 `deployment/local-support.jsonc`、`deployment/local-pages.jsonc`，不引用云端生产资源。复制相应 `.dev.vars.example` 后将 ORIGIN 设成同一本地 Pages 地址；不要配置真实发信或生产控制令牌。普通本地请求没有可信 `request.cf.country` 时拒绝商品查询，不以自定义请求头冒充地区。浏览器回归在本地运行，云端构建不依赖本机 Chrome。

## 自动发布

`test` 验证后直接向 `main` 发起 PR；两分支共用业务代码和两份环境清单，合并时不改配置、不复制数据。为 `main` 设置 PR 与必需检查保护，合并后的提交重新测试和构建。没有 GitHub Actions 发布流程。

两个辅助 Worker 分别连接 Cloudflare Workers Builds，固定监听自己的分支。Pages 仍原生连接同一 GitHub 仓库，但 `production_deployments_enabled=false`、`preview_deployment_setting=none`，关闭独立推送触发，避免迁移和 Worker 尚未完成就先发布 Pages。Pages 根目录为仓库根、输出 `dist`、构建镜像 v3，构建命令为：

```sh
npm ci && node scripts/environment.mjs prepare-pages && npm test && npm run build && npm run preflight
```

Pages 两套均设置 `SKIP_DEPENDENCY_INSTALL=1`，由上面的 `npm ci` 按锁文件安装一次。固定构建身份变量是 `DEPLOYMENT_ENV` 和 `PAGES_PROJECT_NAME`；`RELEASE_SHA` 只由已持锁的发布器更新。Pages 构建核对 `CF_PAGES_BRANCH`、`CF_PAGES_COMMIT_SHA` 与预期 SHA，生成 `.wrangler/deploy/config.json` 指向本环境的配置；最终预检再次核对分支 HEAD。不得以 `commit_hash` 参数冒充 Git 来源固定：[原生 Git 部署实际使用分支 HEAD](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/create/)。

Workers Builds 安装命令使用 `npm ci`；测试的发布命令与生产候选分别为：

```sh
node scripts/release.mjs --environment test
node scripts/release.mjs --environment production
```

每个构建只执行对应的一行。发布器要求平台提供的 `WORKERS_CI_BRANCH`、`WORKERS_CI_COMMIT_SHA` 与干净检出的完整 SHA 一致，并核对项目固定身份、远端分支 HEAD 和两套资源清单。顺序固定为：

1. 获取本环境发布锁，验证远端项目配置。
2. 测试、构建、预检；再次确认提交未被替代。
3. 校验迁移历史与校验和，仅应用允许的增量迁移。
4. 部署辅助 Worker，读回唯一 100% 活跃版本、SHA 和业务绑定。
5. 更新 Pages 的预期 SHA，以原生 Git API 启动本分支部署。
6. 有界等待，核对实际来源、canonical deployment、Worker 版本及全部绑定。
7. 探测站点、API、媒体、Pages 默认域和本次 hash 入口的 Access 拦截，再用专用服务身份核对配置 API 的环境和 SHA，最后释放发布锁。

整个发布最多 12 分钟；锁等待、HTTP、子进程和 Pages 轮询分别有限额。旧提交在后续阶段变为过时就停止；SHA 或 Worker／Pages 版本不一致不会标记发布成功。已产生远端变更的失败保留闭锁，不能依靠新推送覆盖未查明的结果。原生 Git 构建与新提交可能交错，因此以构建期检查、持锁串行和最终读回共同验收，不能将启动部署写成成功。

## Workers Builds API 对接

Builds 管理权限和发布权限分开：管理接口需要 Workers Builds Configuration Edit（API 名称 `Workers CI Write`），获取 Worker tag 需要 Workers Scripts Read；构建部署 token 的权限按发布器实际使用的 Workers、D1、Pages 端点配置。Workers Builds 当前只支持用户所有的 API Token，不能选择账户所有 token。[官方权限与前置条件](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/)、[Build token 限制](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)

`script_tag`／`external_script_id` 是 `GET /workers/scripts` 返回的不可变 tag，不是 Worker 名称；`build_token_uuid` 也不是原始 API token 或其 token ID。新用户 API Token 通过 `POST /builds/tokens` 的 `{build_token_name,build_token_secret,cloudflare_token_id}` 注册后，使用返回的 build token UUID，不能复用其他项目的部署 token。

`cf builds workers create --body` 对应 `POST /accounts/{account}/builds/workers`。以下为测试配置的最小请求形状，尖括号值必须先读回核对；不要把 Secret 放进请求文件或命令历史：

```json
{
    "script_tag": "<test-worker-tag>",
    "git_repository": {
        "provider_type": "github",
        "provider_account_id": "<github-owner-id>",
        "provider_account_name": "VRCLearn",
        "repo_id": "<github-repository-id>",
        "repo_name": "VRCLearn-Store",
        "branch": "test"
    },
    "production_settings": {
        "build_command": "npm ci",
        "deploy_command": "node scripts/release.mjs --environment test",
        "build_token_uuid": "<test-build-token-uuid>",
        "environment_variables": {},
        "root_directory": "/"
    },
    "previews_enabled": false
}
```

此形状通过 `cf --dry-run` 只代表本地请求构造有效，不代表远端授权、安装或创建成功。生产候选使用自己的 Worker tag、build token、`main` 与 `--environment production`。已有配置用 `PATCH /builds/workers/{script_tag}` 仅更新需要的 `git_repository.branch`、`production_settings` 和 `previews_enabled`。若使用底层 `POST /builds/triggers`，必须填写 `external_script_id`、`repo_connection_uuid`、`build_token_uuid`、命令及路径，分支包含只设本环境分支、排除为空；不能额外保留通配 preview trigger。

创建时可令 `production_settings.environment_variables={}`，随后单独设置变量与秘密；官方 `cf` 生成源码的 `compactBody` 明确保留该路径的空对象。CLI 对 `workers create/get` 直接输出服务端 result，没有定义 `trigger_uuid` 的固定嵌套位置。创建后使用文档化的 `GET /builds/workers/{script_tag}/triggers`，按 Worker tag、仓库与精确分支筛选唯一项，再取该项 `trigger_uuid`；不要假设它位于 create 响应顶层。[CLI 创建源码](https://github.com/cloudflare/cf/blob/main/packages/cli/src/commands/_generated/builds/workers/create.ts)、[官方 trigger 读取流程](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/#step-2-get-your-trigger-uuid)

构建期变量单独通过 `PATCH /builds/triggers/{trigger_uuid}/environment_variables` 上传；它与 Pages 的 `type/value` 格式不同：

```json
{
    "DEPLOYMENT_ENV": { "is_secret": false, "value": "test" },
    "PAGES_PROJECT_NAME": { "is_secret": false, "value": "test-vrclearn-store" },
    "CLOUDFLARE_API_TOKEN": { "is_secret": true, "value": "<test-deployment-token>" },
    "CF_ACCESS_CLIENT_ID": { "is_secret": true, "value": "<test-service-client-id>" },
    "CF_ACCESS_CLIENT_SECRET": { "is_secret": true, "value": "<test-service-client-secret>" }
}
```

未指定键保留，单值最大 5,000 字符；GET 对秘密返回 `is_secret:true,value:null`。上传时从受控加密存储在内存组装，不使用带值的 argv、明文文件或输出；读回仅保留名称、标记和公开身份，不能把 GET 的 null 当作值重新写回。[Secret API](https://developers.cloudflare.com/api/resources/workers_builds/subresources/triggers/subresources/environment_variables/methods/upsert/)

平台注入 `CI=true`、`WORKERS_CI=1`、`WORKERS_CI_BUILD_UUID`、`WORKERS_CI_COMMIT_SHA` 和 `WORKERS_CI_BRANCH`；这些键可被自定义变量覆盖，运维不得覆盖它们。发布器仍须将平台 SHA 与实际检出及远端 HEAD 比对。[平台变量](https://developers.cloudflare.com/changelog/post/2025-06-10-default-env-vars/)

GitHub 授权须在组织 Installed GitHub Apps 中核对 Cloudflare Workers & Pages 应用：账户／组织、未暂停状态，以及 selected repositories 中确实包含本仓库；不为排障卸载或扩大到全部仓库。Cloudflare 连接记录的 `provider_account_id`、`repo_id` 必须与 GitHub API 读回一致。仓库连接没有公开的 GET/list 接口，可从 Worker 配置或 trigger 的 `repo_connection` 读回；只读 `config_autofill` 可辅助检查目标分支可读，公开仓库可读本身不能独立证明安装授权。[GitHub 安装说明](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)

首次验收只记录 trigger ID、Worker tag、分支、构建 UUID、提交 SHA、结果和 Secret 名称；不 dump 环境、原始日志或全部接口响应。分别确认两套各仅有自己的分支触发器、无 preview 触发器，Builds GET 中秘密为空，业务 Worker／Pages 绑定中没有构建 Secret；实际构建成功后再核对 Worker 版本、Pages SHA、业务隔离与 Access。API 管理成功不能代替一次真实 Git 触发与最终发布验收。


## Secret 与绑定边界

| 所在位置 | 必需秘密与权限 |
| --- | --- |
| Pages 运行时 | 本环境 `TURNSTILE_SECRET_KEY` |
| 辅助 Worker 运行时 | 本环境 `BETTER_AUTH_SECRET`、`TURNSTILE_SECRET_KEY`；原生 EMAIL 仅允许本环境发件地址 |
| Workers Builds 构建期 | `CLOUDFLARE_API_TOKEN`、本环境 Access 冒烟用 `CF_ACCESS_CLIENT_ID`／`CF_ACCESS_CLIENT_SECRET` |
| 独立账户监控运行时 | Billing Read 的 `CF_MONITOR_TOKEN`、限定目标 zone WAF 的 `CF_API_TOKEN`、`ALERT_EMAIL` |

构建期凭据不写入任何业务配置、静态产物或运行时绑定；发布器拒绝多余资源绑定与未声明运行时变量。Access 冒烟使用每环境独立的 service token 和 Service Auth 策略，不改变 `@vrclearn.com` 用户策略。令牌权限受 Cloudflare 能提供的账户／zone 粒度约束，代码中的资源白名单不是更细的令牌授权边界。

Pages 元数据更新只写公开的预期 SHA、部署身份和项目名，不回传读取 API 中的秘密值，并在写入后核对原 Secret 名称仍保留。辅助 Worker 上传保留已配置秘密，随后读回必需名称；Secret 值不进入仓库、命令输出或发布日志。运维读取原始设置时也不得持久保存含秘密的响应。

Windows 运维凭据可在仓库外按用户级 DPAPI 加密保存，本机忽略配置记录实际位置；不代管商店测试账户密码、验证器密钥或恢复码。轮换账单与 WAF 令牌时保持权限分离。API token 到期、Access 服务凭据失效或 Secret 缺失均须明确处置，不能关闭入口保护来完成发布。

## 首次启用与迁移

首次切换是单独的受控操作，不由自动发布重建或重置资源：

1. 保存现有 Pages、Worker、D1、R2、KV、Access、Turnstile 和规则配置，确认现有业务数据保留。
2. 新建测试业务资源与独立 Access 应用，不复制生产认证、媒体或会话；填齐环境清单。新库按顺序执行 `0001` 至 `0004`，为每个已完成文件登记 `d1_migrations`。
3. 用 `deployment/release-control.sql` 初始化专用发布控制 D1，一次性建立两条环境锁记录及校验和表；不得将该库绑定到业务运行时。
4. 保持旧监控运行，新 control 暂不启用 Cron。读取并核验原生产 `budget:state`，将其原模式、金额及来源分别预置到控制 KV 的 `budget:state` 与 `budget:delivery`；读回两键一致，不以空状态或伪造零费用初始化。单个 key 缺失也会闭锁两环境。
5. 部署控制专用 `QuotaGate` 和监控代码，确认只持有自身权威 KV、独立 DO、两环境副本及三个控制 Secret。启用 `7,22,37,52 * * * *`，避免与旧 `*/15` 同时写生产预算；保留旧监控直到新控制链路完成验收。
6. 等待真实一轮，记录控制版本、服务端时间、账单来源与估算、两套副本和完整分发回执。确认权威两键、业务副本时间均晚于部署，告警配额使用独立对象；逐条核对共享 WAF 的精确范围和读回结果。配置存在或本地测试通过不代表新监控已接管。
7. 新监控验收后，暂时清空旧辅助 Worker 的 Cron 并确认旧轮结束，再删除旧 `CF_MONITOR_TOKEN`、`CF_API_TOKEN`、`ALERT_EMAIL`，读回仅保留认证和 Turnstile Secret。随后发布纯业务辅助 Worker，恢复 `*/15` 的清理调度，确认其不再写预算或操作 WAF；业务配额、账户、媒体和会话不重置。上传通常保留已有 Secret，不能只删除配置字段就声称完成移交。
8. 现有库的 `0004_remove_mfa.sql` 单独执行：先确认当前辅助 Worker 与 Pages 已去掉相关表依赖，再执行清理，读回表结构、迁移记录和外键检查，重验登录与管理员门禁。不要把这项删除迁移加入自动白名单。
9. 验证测试完整发布后再接入生产候选，最后启用两条固定分支的 Workers Builds 触发，并确认 Pages 独立推送触发已关闭。

受控初始化发布库的命令如下，先确认账户和目标 ID；现有已初始化库不得重复执行：

```powershell
cf d1 query <release-database-id> --sql (Get-Content -Raw deployment/release-control.sql)
```

业务迁移使用 `cf d1 query <business-database-id>` 的 `--batch` 请求，把该文件的 SQL 与插入 `d1_migrations(name)` 放在同一批次；先读回已有记录，结果不明时不得重复套用。发布器要求前四份基线已完整应用且仓库内容与固定基线校验和一致。

常规自动迁移只允许新表、新索引、新增可空列或具有有效常量默认值的列。删除、清空、DML 回填、触发器、重命名、虚表和未知语法一律停止发布；不自动回滚数据库。每个自动迁移把结构变更与 `d1_migrations` 记录原子批处理，再把源文件 SHA-256 写入控制库；已应用历史修改、缺少文件或校验和均阻断后续发布。两个库之间没有分布式事务：若业务变更成功而校验和写入不明，必须人工读回处理。

## 发布失败与人工解锁

`release_leases` 按环境保存 lease ID、SHA、阶段、截止时间与 Pages deployment ID。成功后释放；可确认未产生业务变更的失败释放；任何可能已写入、进程中断或结果不明均保持占用。到期不代表远端构建已结束，因此不会按时间自动抢锁。不得直接删表、清空所有锁或循环重试发布。

解锁前先停止／确认旧 Workers Build 已终止，并逐项读回：

```powershell
cf d1 query <release-database-id> --sql "SELECT * FROM release_leases WHERE environment='test'"
cf pages get test-vrclearn-store
cf pages deployments get <deployment-id> --project-name test-vrclearn-store
cf workers deployments list --worker test-vrclearn-store-support --per-page 5
cf d1 query <business-database-id> --sql "SELECT name FROM d1_migrations ORDER BY id"
cf d1 query <release-database-id> --sql "SELECT name,digest FROM release_migration_checksums WHERE environment='test'"
```

同时读取 Worker 设置中的 `RELEASE_SHA`、`DEPLOYMENT_ENV` 和业务绑定；只查看／记录必要字段与 Secret 名称。确认 Pages 部署已进入终态、canonical SHA 与实际 Worker 版本已查明，且没有仍可晚到发布的任务。若 schema 与迁移记录已生效而控制库校验和缺失，只能在比对原文件内容、实际表结构和记录后补齐对应校验和，不能重新运行结构修改或伪造历史。

确认影响范围和恢复版本后，人工以刚读到的环境、lease ID 与 SHA 为条件，单次更新锁状态；影响行数必须为 1：

```sql
UPDATE release_leases
SET lease_id=NULL, expires_at=NULL, phase='reconciled', outcome='reconciled'
WHERE environment='test' AND lease_id='<observed-lease-id>'
  AND release_sha='<observed-full-sha>' AND outcome IN ('running','blocked_uncertain');
```

生产候选使用 `production` 和对应资源。解锁后仅重新触发当前分支 HEAD 的完整发布；不能继续过时提交、自动回滚数据库或在 Worker／Pages 不匹配时宣称恢复完成。


## 上线访问规则

1. 两套 Pages 自定义域分别为 `store.vrclearn.com`、`test-store.vrclearn.com`，ORIGIN 必须与本环境一致。各自 Access 应用覆盖站点、媒体、根默认域及通配预览域；两套 `fail_open=false`，默认入口不得绕过。
2. 两个辅助 Worker 与独立监控均保持 `workers_dev=false`、`preview_urls=false`，不配置公共路由。认证仅通过本环境的 Service Binding 调用，不公开 `/internal/session`。
3. Turnstile 按环境限制主机名；注册／登录 action 为 `auth`，上传为 `upload`，提交审核为 `submit`，服务端逐项验证 hostname 和 action。测试不使用生产 Secret。
4. 媒体地区规则在缓存之前执行。两个媒体域均拒绝未知国家与不匹配前缀：大陆只允许 `/cn/`，其他已知国家只允许 `/intl/`；仅精确排除 Access 管理的 `/cdn-cgi/access/authorized` 回调。不能靠 Referer、CORS 或隐藏链接隔离内容。
5. 同类媒体地区规则、缓存规则合并匹配两套媒体域，避免重复消耗 zone 规则额度。缓存不覆盖来源的 60 秒时效；公开图片路径使用不可复用的提交令牌，禁止按原始 URL 全局缓存动态 HTML。
6. 紧急停机按动态、媒体各一条共享规则管理。监控根据两环境各自应停状态生成精确组合表达式；仅测试资源失败时表达式只匹配测试域，账户费用触发时匹配两套域。不得为简化操作把测试故障扩展为全站封锁。
7. 私有桶关闭所有公开访问，公开桶仅绑定本环境媒体域，两桶 `r2.dev` 关闭。静态文件不包含商品全库、私有数据或需函数保护的内容。

## 内部测试入口

每套环境使用独立 self-hosted Access 应用，用户允许策略为 `email_domain: vrclearn.com`。可使用账户现有邮箱 One-time PIN 和 Cloudflare 登录来源；Cloudflare 来源另受其成员限制。专用构建服务身份使用单独 Service Auth 策略，不扩大用户邮箱范围。Access 只控制站点准入，不授予商店账户、邮箱验证状态或管理员角色。

每个应用覆盖站点、媒体、根 Pages 默认域和通配预览域四个目标，保持 24 小时会话、HttpOnly Cookie 与 eager redirect cookie。站点和媒体位于同一应用中，但两环境 Cookie 不共用；用真实浏览器检查媒体 `<img>` 不被登录重定向替代。[Access 多域 cookie](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/)

Pages 自定义域先完成绑定与证书验证，再配置该域的 Access；绑定期间不开放业务内容。R2 先建立 Access 应用再连接媒体域，避免短暂公开。Pages 的预览保护开关不自动证明根默认域和自定义域受保护，须分别探测根、hash／分支／旧部署及两个自定义域；不能只凭应用 destinations 或 ORIGIN 校验认定完成。[Pages 默认域保护](https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain)、[R2 Access 顺序](https://developers.cloudflare.com/r2/tutorials/cloudflare-access/)

## 费用维护与恢复

独立账户监控使用 `7,22,37,52 * * * *`，每 15 分钟执行一批任务；业务辅助 Worker 的 `*/15` 仅做清理。预算统计针对整个 Cloudflare 账户，包含其他项目，并非给每个环境分别设预算：估算 10 美元告警，15 美元两环境受限，18 美元两环境维护。它只控制清单指定的商店入口，不自动停止其他项目；监控延迟、其他项目增长、攻击流量与剩余入口费用意味着这始终是软性兜底。

监控先核验 V1 info 的账户覆盖与有效订阅，再显式查询当前账期。估算包含 Workers Paid 基础费预留，实际覆盖产品族来自返回数据；缺少 Logs 行不等于已核实零费用。来源合同、时效和未知费用语义见 [费用说明](costs.md)。账单来源失败时两套至少受限，权威两键缺失、畸形或读取失败时两套维护；状态不会自动降级恢复。

Cron 通过控制专用 `QUOTA.getByName("account-monitor").checkBudget()` 执行整轮，告警预留使用同命名空间的另一对象 `global`，不自调用。并发调用共享同一个运行 Promise；所有写入完成前不释放串行门，完成后 61 秒内重复触发只读 SQL 缓存。中断结果不明时下一安全轮次强制维护；RPC 失败只尝试 WAF 全域闭锁，不在 DO 外另起 KV 写入者。

权威 `budget:state` 与分发回执 `budget:delivery` 留在控制 KV，分别向生产、测试 KV 分发业务可读状态。测试 KV 单独不可读／不可写时，只闭锁测试并告警，生产不因该资源故障暂停。账户预算触发则两套共同执行保护；回执按环境记录分发及动态、媒体封锁结果，不把一条规则写成功当作整体成功。

动态与媒体各一条共享紧急规则，规则 ID 写入环境清单。监控逐条检查活跃入口、规则类型、phase 与允许的精确组合表达式，再 PATCH 所需目标；每条规则独立执行并读回，失败不阻止另一条核验，写入结果不明不盲目重试。规则置于可能跳过后续自定义规则的 skip 规则之前。仅测试故障时组合条件不包含生产域；账户维护时包含两套。不能把应用维护响应写成边缘已阻断或费用归零。

维护时静态首页和说明仍受 Access 保护并可访问；动态 API、详情、sitemap、认证和内部会话暂停，业务清理停止高成本操作。受限模式允许密码登录，但禁止上传、新发布及非必要发信。业务 KV 状态缺失、畸形、超过 30 分钟或来自明显未来时，不能授权上传、新发布及非必要发信；KV 读取异常或维护模式也拒绝普通动态、认证和清理。不能清空 KV 绕过保护。

恢复前暂停控制 Cron 并确认本轮结束，人工确认真实账单、攻击状态、来源健康、两套分发和规则读回。普通检查不会缩小已启用的封锁；明确恢复使用 `{allowRecovery:true}` 按需移除已恢复环境的条件，全部关闭仍保留两域完整表达式，并同步核对权威两个 key、分发回执及对应业务副本后再恢复调度。不要仅改测试副本、伪造零费用或设置自动开关循环。恢复账户预算保护不等于撤销待处理发布锁，二者分别验收。

上传和发布继续使用每环境独立的 Durable Object 配额及 D1 原子存储预留；规则一致，计数和重放状态不共享。私有与公开对象合计 8 GiB，R2 结果不明保留预留，24 小时后有界核实未引用对象再删除并释放。测试删库、删除媒体或耗尽业务配额不得改变生产数据与计数；账户消耗仍共同计费。


配额账本有到期索引和 100,000 条硬上限。每个获批操作最多清理 32 条，Alarm 每批最多清理 1,000 条；过期积压按最短 60 秒继续，正常时调度到最早到期，空账本停止 Alarm。容量不足和 Alarm 持久化失败均不放行操作；不要通过删除尚未到期的计数或重放记录恢复可用性。

私有上传未附加到有效草稿／当前发布版超过 24 小时后可清理；未发布草稿 30 天不更新后视为过期，图片可能清理，重新编辑需补传。每次至多清理 25 个旧公开图片、25 个私有图片和 25 个孤立预留，并清理至多 100 条过期会话与验证记录。R2 删除失败不释放预留，后续批次重试。

首次发布及同内容首次新增地区按区独立审核。仍有待审或获批但尚未成功发布的地区时，修订保持 `pending` 并锁定编辑，已批准且有效上架的地区仍可公开。内容修改须先保存新修订，所有当前上架地区均通过后统一切换；新增地区的待审或拒绝不构成额外屏障。已决定地区再次申请须保存新修订，不覆盖原批准或拒绝记录。撤回只取消未决审核，已上架地区保留；下架、撤权及封禁同时使旧发布任务失效，避免迟到任务复活已撤销内容。管理台仅在确有可发布但尚未完成的地区时提供重试，商家界面逐区显示状态与理由。

## 本次平台契约验证

2026-10-28 13:31 UTC 使用 `cf` 对指定资源执行了有界验证；以下仅记录实际观察，不代表完整双环境发布已完成。

| 范围 | 实际结果与限制 |
| --- | --- |
| 发布控制 D1 `a051be13-2d43-49e6-8ad7-4c940366a3ea` | 一次 `body.batch` 包含 `SELECT 1`、`SELECT 2`，返回按顺序排列的两项 `{results,success,meta}`，两项均成功、`changes=0`、`changed_db=false`、`rows_written=0`；只读，未创建表或写数据 |
| 测试 D1 `7bb66e28-d981-4db2-8963-4e6820ba7a14` | 先查重确认唯一 probe 表不存在，再创建；同一 REST batch 内两次插入相同主键，实际返回 HTTP 400／7500 UNIQUE 错误，随后读回 `count(*)=0`。首条写入已回滚。最终删除该 probe 表，再查 `sqlite_master` 为空，无 probe 残留；未写生产库或控制库 |
| 事务结论 | 此次实测支持当前 REST batch 的约束故障回滚行为；公开 REST 文档确认 batch 请求形状，明确事务保证见 Worker binding 文档，不能把一次观察提升为永久平台契约。发布器仍逐项校验响应、保留结果不明锁，并要求迁移异常人工读回；本地 SQLite 回滚测试只覆盖客户端逻辑 |
| Pages 稀疏变量 PATCH | 本次受控元数据 PATCH 前后，选定项目的 10 个变量名全部保留，`TURNSTILE_SECRET_KEY` 仍为 `secret_text`，无需恢复；没有读取或输出秘密值。发布器仍在每次 PATCH 后检查 Secret 名称保留，不依赖这次采样永久放行 |
| Pages 自动触发与手动 API | 官方 source 标志定义针对 Git push／commit 自动触发，创建部署 API 独立支持 Git 分支 HEAD；据此设计为关闭自动触发后由协调器调用 API。此项仅做文档／CLI 契约核对，没有为验证启动部署，仍须首次真实发布确认。若返回 `is_skipped` 或 `status=skipped`，立即停止并保留闭锁，不重试或自动开启推送触发 |

依据：[D1 REST 请求](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)、[Worker binding batch 事务](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)、[Pages 分支自动部署控制](https://developers.cloudflare.com/pages/configuration/branch-build-controls/)、[Pages 原生 Git 部署 API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/create/)。


## 既有单环境验收记录

以下是双环境切换前的既有验收证据，表内服务端时间标注 UTC，不代表本文所述新资源、监控拆分或完整自动链路已远端验收。当前版本以远端 canonical deployment、Worker RELEASE_SHA、迁移和预算状态读回为准；双环境新增验收须另记录实际提交、部署 ID、时间及结果，不由本地测试推断。

| 项目 | 实际结果 |
| --- | --- |
| 辅助 Worker | `148212b3-faac-48db-b678-d6c35069aeea` 已部署，启动 38 ms，配置每 15 分钟触发器；仅 Service Binding，无公开路由 |
| Pages | 已在 2026-10-28 重建为同名 Git 集成项目，ID 为 `49f24811-18b6-4778-a6c3-bb73278bb7da`，连接 `VRCLearn/VRCLearn-Store` 的 `main`。首次原生构建 `a792bd9f-542f-4ac2-8ef2-d856f53002d8` 从提交 `1eb6727` 克隆，Cloudflare 执行锁文件安装、288 项测试、构建及预检后部署成功，GitHub 的 Cloudflare Pages 检查通过；后续当前版本以 canonical deployment 关联 SHA 为准 |
| 数据与绑定 | Pages 重建前后 D1 仍有 3 个账户、2 个店铺、1 个商品、3 个修订、2 条有效地区发布、1 条私有媒体及 2 条公开媒体记录；两个 R2 桶、KV、认证 Worker 与配额 Durable Object 均沿用原资源，未重置数据库、媒体或管理员。当次部署保留了凭据，Pages Turnstile Secret 已通过当前用户专用内存管道恢复；当前秘密归属按上文双环境边界及监控移交步骤核对 |
| 媒体 | 两桶 `r2.dev` 已关闭；正式媒体自定义域最低 TLS 1.2、SSL 状态 active；地区 WAF 仅排除 Access 精确授权回调。最终国际区图片实际返回 200，非磁盘缓存、CDN `HIT`，响应为 `image/jpeg`、53,991 字节、`max-age=60, s-maxage=60`，实际解码为 1910×851；同一国际出口请求对应 CN 图片实际返回 403，非磁盘缓存，匿名国际区请求仍转入 Access。用户已明确延期真实中国网络测试，此项不阻断本次受保护内测交付 |
| Access 准入与匿名入口 | 新邮箱 OTP 与 Cloudflare 登录并存，仅允许 `@vrclearn.com` 邮箱域，四个保护目标、策略、登录来源、24 小时会话和 Cookie 配置与重建前一致。首次原生构建后，正式静态页、API、根默认域、hash 默认域、main 分支域及媒体六项匿名探测均为 Access 302；原已获准浏览器会话正常读取搜索结果，站点自定义域验证和证书状态 active |
| 浏览器与公开读取 | 所有者实际通过 Access 打开首页；最终分区验收修订的简中、英文、日文详情原始 HTML 均返回 200、`private, no-store`，包含最新正文与 Product 结构化数据，三语响应均仅引用国际区图片。搜索和收藏实际返回 200 及当前新内容，三语 sitemap 均为 200 且包含该商品。这些实测来自国际出口 |
| 店铺详情 SEO | 已获批店铺的简中、英文、日文原始 HTML 均实际返回 200，包含店铺正文、标题、对应语言 canonical、Open Graph 和 Organization 结构化数据；三语响应均为 `private, no-store` 并带 nonce CSP，源码不含草稿商品 |
| 账户与邮件 | 所有者已完成真实 Turnstile 注册、验证邮件与密码登录；当前仓库认证变更部署后须重新验证密码登录、密码找回与会话撤销。当前 500 ms CPU 配置下密码流程可用，尚未取得逐请求 CPU 测量值 |
| 管理员 | 经所有者批准已初始化内测管理员，后续指定的内测账户也已按授权授予角色。当前仓库变更部署后须重新验证有效会话、已验证邮箱、管理员角色和封禁状态的门禁 |
| 费用状态 | 人工恢复后，线上 Cron 持续成功核验真实来源；17:15:47 UTC 自动采样为 `normal`、5 美元、`coverageBasis: "provider-account"`，未人工触发任务。17:24:36 UTC 读回确认 Pages 仍为 FD 部署、媒体地区 WAF 启用，两条紧急停机规则均禁用 |
| 商家与发布 | 内测店铺资料和两区权限已分别审核；首份商品在正常界面完成两区审核并上架。同一商品的新修订也已真实提交：仅 CN 批准时，两区仍指向旧版且候选公开图片为零；国际区批准后，两区原子切换至修订 `4c5dcaaf-b17a-4a81-9667-c62c4dc954ab`，公开图片两份，旧版图片记录清零。真实搜索在切换前不返回修订关键词，切换后返回新内容。发布与换版均未触发 Pages 构建 |
| 未审核内容隔离 | 首次发布前，草稿搜索为空、详情拒绝、三语 sitemap 不含草稿；修改后的草稿也未替换旧版公开内容。店铺审核前同样验证未进入三语 sitemap。实测来自国际出口 |
| 图片上传 | 普通浏览器已上传一张 53,991 字节、1910×851 的截图；实际检测类型及公开响应为 JPEG，D1 媒体记录、草稿引用和真实解码一致。原私有图及审核后的公开图均已读取成功 |
| 发现、收藏与举报 | 真实中文二元词检索叠加分类、PC、免费、标签及适配模型筛选返回目标商品；收藏写入及按地区读取均为 200。测试举报返回 201、进入管理员队列，并通过正常界面处理为 `resolved`，D1 确认一条对应处理审计 |
| 分区审核修复 | 分区验收修订 `4be2d32a-d48f-4586-ae98-85d8e59c81a0` 已真实提交。仅 CN 批准时，D1 确认其成为当前修订、CN 有效上架且只有一份 CN 公开图片，国际区仍待审且未上架，修订保持 `pending`；国际出口的 API／HTML 为 404，搜索为空、收藏 `product:null`、三语 sitemap 不含商品。国际区随后通过正常审核；17:21:39 UTC 读回确认该修订为当前 `published`、两区均批准并有效上架、公开图片两份，原 CN 媒体令牌不变，保留此状态供内测使用 |
| 下架与缓存 | 此前下架验收中，CN 下架后，D1 确认仅 CN 失效及对应公开图片删除，国际区保持上架且原图片实际返回 200。国际区于 17:01:37 UTC 下架后，D1 确认两区均失效、公开图片记录为零、私有原图保留一份。原国际区图片的确切 URL 于约四分钟后的抽样返回 404，非磁盘缓存且 `CF-Cache-Status: BYPASS`；随后商品 API 与 HTML 均为 404／`no-store`，HTML 带 `noindex`，搜索为空，收藏保留记录但 `product:null`，三语 sitemap 均为 200 且为空。图片响应 TTL 为 60 秒，详情内部缓存上限 60 秒；此次抽样确认最终撤销，不证明在 60 秒内完成，时限约束由实现及本地测试覆盖 |
| 提交交互 | 真实保存及工作台刷新均为 200，两区勾选在保存后保留。首份商品、内容修订和最终分区验收修订均已通过真实验证提交并完成审核。界面有 Material 进度、错误与手动重试，配置／脚本各限 15 秒、首次验证限 120 秒；失败清令牌与旧实例，不自动重试，不接受旧回调恢复令牌 |
| 真实停机演练 | 经明确批准，于北京时间 21:34:45–21:35:53 完成。启用期动态配置 API 与媒体返回 403；静态入口仍可进入 Access，已有 Access 会话的静态维护页实际返回 200，未使用磁盘缓存或 Service Worker；观察时间早于两条规则的恢复更新时间。恢复后各探测入口重新返回 Access 302，两条规则均关闭，定义、顺序及其他规则保持一致 |
| 本地验证 | 310 项单元／集成测试、74 项桌面／移动端浏览器回归，以及构建、类型检查和部署预检通过；覆盖新库与旧库认证迁移、密码登录、角色／邮箱验证／封禁门禁、部分发布、旧区换版屏障、审核决定保留、扩区、媒体失败与撤销并发、提交状态竞争、地区结果及重试界面。浏览器回归使用项目已有的外部预览服务器模式执行，未修改线上环境 |

该次内部测试业务闭环已有真实验收证据，Access、登录来源与测试商品状态按上述采样记录，不能代替双环境切换后的读回。注册、验证邮件、密码登录、管理员、商家入驻、两区权限、商品分别审核、公开详情／图片、搜索筛选、收藏和举报处理已有真实证据；当前仓库的账户认证简化仍待授权部署与相应远端回归。修订期间保留旧版、两区统一切换、首次单区先上架而另一地区待审时的国际区隔离，以及单区下架保留另一地区、最终撤销公开读取也已验证。费用监控和双域停机演练已通过。

这些结果不代表全部生产边界均已逐项实测。Cloudflare HTTP Analytics 确认最终详情及媒体读取来自日本出口，详情在国际区批准前为 404、批准后为 200，国际区图片为 200。真实中国网络的正向及反向访问由用户明确延期，不阻断本次内测交付；真实拒绝、同内容新增区和并发异常等边界已有本地覆盖，未额外执行生产演练。逐请求密码计算 CPU 数值尚未取得。下架抽样没有验证 60 秒截止时间，不能将配置和测试中的时限写成真实观测结果。

每项记录目标部署 ID、时间和实测结果。使用专用商店资源、一店一商品和一张小型有效图片完成以下闭环，不执行无界压测、轮询或向其他收件人发信。

1. 核对迁移、实际绑定、CPU 上限、secret 名称、Cron 与 Service Binding；辅助 Worker 无公开入口，私有桶无公开访问。未登录时测试正式域、媒体、默认域及部署别名的静态和动态路径，确认 Access 拒绝绕行。
2. 按实际启用的 Access 来源完成登录，检查两域 cookie；邮箱 OTP 发码须处于用户明确授权的验证范围内。普通静态首页和资源不调用 Functions，不主动检查应用会话。动态 API 故障时，已获准访问的用户仍可打开静态说明和维护页面。
3. 使用真实 Turnstile 完成一次注册、必要的邮箱验证和密码登录；检查原生 scrypt 在辅助 Worker 500 ms CPU 上限内可用，并记录执行结果。不得降低密码参数或使用测试 challenge 替代真实生产验证。测试密码找回时核对一次性链接和会话撤销，并保持既有邮件配额。
4. 仅提升明确批准的所有者账户为管理员，写入时校验已验证邮箱、当前有效会话及未封禁状态，并记录初始化审计。检查当前会话与安全 cookie 后打开审核台；确认普通用户、未验证邮箱、封禁账户和无效会话均不能访问审核接口。账户密码由所有者自行保管，不在本机运维凭据目录中代管。
5. 完成商家入驻、店铺资料审核、CN／国际发布权限申请及分别审核、草稿、私有图片预览、商品提交和发布。验证搜索、筛选、收藏、详情源码与分享元数据、sitemap 和媒体；修订审核期间旧版继续展示，下架后目录、详情和公开图片最迟 60 秒不可见，期间没有 Pages 全站构建。
6. 从真实 CN 与国际网络出口检查 API、HTML、收藏、sitemap、媒体前缀隔离及未知地区拒绝；浏览器切换语言不能切换商品区。没有对应出口时明确记录尚未远端验证，不能通过自定义国家请求头冒充 Cloudflare 地区判断。
7. 确认定时监控从真实来源写入新状态及 `coverageBasis`，费用源失败至少受限、配额故障拒绝昂贵操作。受控停机演练先保存现状，短暂启用两条预配置紧急规则并读回，再实测动态与媒体封锁、静态说明可用；人工恢复前核对真实费用与规则。禁止以假零金额或清空 KV 绕过保护。

## 正式公开上线前

必须先提醒所有者清空内测数据库，避免把测试账户、会话、商家、商品和审核记录带入正式服务。该提醒不授权立即删除；执行前另行确认目标 D1 与具体重置范围，并核对 R2 测试媒体和 KV 配额状态，不能影响其他项目。重置后重新应用迁移并初始化正式管理员。

欧盟 IP 封锁在最终上线阶段配置，覆盖正式站点、媒体、默认域和预览。EU 国家集合为 AT、BE、BG、HR、CY、CZ、DK、EE、FI、FR、DE、GR、HU、IE、IT、LV、LT、LU、MT、NL、PL、PT、RO、SK、SI、ES、SE，不扩展为英国或整个欧洲。
