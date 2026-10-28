# 架构

## 静态优先与业务边界

React、TypeScript 和 Material Web 界面由 Cloudflare Pages 静态分发。只有 `/api/v1/*`、`/api/auth/*`、商品／店铺详情和 sitemap 进入 Functions；`public/_routes.json` 限定入口，不设置全站函数中间件。普通静态页不读取账户状态、不轮询。详情 HTML 与 API 共用 `server/` 服务层，不通过 HTTP 请求自己。

D1 保存账户、店铺、权限、修订、区域审核和发布；R2 分别保存待审私有图和已审核公开图。每商品最多 10 张、每张 2 MiB，校验实际类型与尺寸。媒体发布、撤销和缓存遵守地区权限，不把两区全库打包进静态文件。

地区来自 Cloudflare IP 国家：大陆为 CN，港澳台及其他已知国家为国际区，未知拒绝。API、HTML、收藏、sitemap 和媒体均服务端隔离；语言不改变商品区。Adult 只可提交国际区审核；已有大陆上架时须先下架大陆区才能提交 Adult 修订。首次发布按区审核，内容修订通过全部当前上架区后统一替换。

## 两环境、一份代码

| 层级 | 生产候选 | 测试 |
| --- | --- | --- |
| 分支 | `main` | `test` |
| 站点 | `store.vrclearn.com` | `test-store.vrclearn.com` |
| Pages / 支持 Worker | `vrclearn-store` / `vrclearn-store-support` | `test-vrclearn-store` / `test-vrclearn-store-support` |
| 业务数据与状态 | 独立 D1、R2、KV、DO、限流 | 全新独立 D1、R2、KV、DO、限流 |
| 认证与访问 | 本环境 Secret、Turnstile、Access | 独立 Secret、Turnstile、Access |

`deployment/environments.json` 是固定资源身份来源，`scripts/environment.mjs` 校验清单并生成 Pages、辅助 Worker 与控制 Worker 配置。分支、平台项目、环境与 SHA 的错误组合阻断。测试引用生产业务资源也阻断；同一账户 ID、zone 及经核验的共享边缘规则属于控制资源，不是业务数据共享。

`test` 通过后直接 PR 合入 `main`，不修改配置、不复制数据。生产重新构建该合并提交。两套运行生产级安全逻辑，只有 `DEPLOYMENT_ENV` 区分身份。隔离不承诺防御持有构建凭据的恶意代码。

## 发布控制

Cloudflare Workers Builds 负责完整链路：校验 → 测试／构建 → 允许的迁移 → 辅助 Worker → Pages 原生 Git 部署 → 版本／绑定读回 → Access 与应用冒烟。Pages 关闭独立推送和预览触发，仍由 Cloudflare 从 GitHub 拉取分支 HEAD。无 GitHub Actions，也不使用 Pages Direct Upload。

发布控制 D1 仅供构建期访问，按环境保存唯一 lease 与迁移校验和。旧 SHA、并发作业、失败迁移及 Worker／Pages 不一致不能标记成功；写入结果不明保持锁，过期不自动抢占。整个链路、子进程、请求和轮询有时间／次数上限。恢复前先确认旧作业和远端部署结束，再读回版本、迁移和校验和，按 lease ID 与 SHA 人工解锁。

自动迁移只允许新表／索引和安全新增列，历史文件校验和固定。基线及删除 MFA 的 `0004` 单独受控切换，不自动执行；不自动回滚数据库。具体命令见 [运维说明](operations.md)。

## 账户总费用保护

`control/` 的独立监控 Worker 每 15 分钟读取账户总费用，权威状态、告警配额和控制令牌独立保存；不跟随测试分支发布。总预算包含其他项目：10 美元告警、15 美元限制两套高成本操作、18 美元共同维护，只控制明确指定的商店入口。

监控向两套业务 KV 分发状态。测试副本单独失败只停测试；账户预算失败或触发阈值影响两套。媒体分区／缓存规则按同类合并；动态和媒体紧急规则各一条，由控制面按目标集合生成精确组合表达式并逐条读回。单测试故障不会把生产域加入封锁条件。

业务 Worker 只持本环境认证 Secret 与业务绑定，不持账单、WAF、部署或 Access 冒烟凭据；构建凭据只在构建期使用。监控延迟、攻击流量、剩余入口和其他项目费用意味着这不是账单硬上限。

## 内部测试与正式开放

两套站点、媒体、Pages 默认域与预览入口均须受独立 Access 应用保护，用户范围为 `@vrclearn.com`，业务管理员权限另行校验。测试库不复制生产身份，Cookie 按主机隔离。当前所有部署仍为内部测试。

正式公开、移除 Access 前必须提醒所有者清空内测数据库，并核对测试媒体和配额处理范围；实际删除须当时另行明确授权。部署状态以真实远端验收记录为准，不能由生成配置或本地预检推断。
