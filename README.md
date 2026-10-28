# VRCLearn Store

React、TypeScript、Material Web（MD3）和 Cloudflare Pages 构建的 VRChat 商品目录。商家直接入驻，区域发布权限与每次发布分别审核；用户搜索、收藏、举报并前往外站购买。不提供支付和聊天。

## 本地使用

需要 Node.js 24 或更新版本。

```powershell
npm.cmd ci
npm.cmd run dev
```

`dev` 运行静态界面。尚未启动本地 Cloudflare 服务时，动态操作会明确显示服务不可用，不会显示模拟商品或假成功。

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:capacity
npm.cmd run test:browser
```

浏览器验收使用本机 Chrome，以独立无头会话运行。`test:capacity` 使用内存 SQLite 创建 100 家商家、10,000 件商品，验证查询计划、FTS 与游标分页，不访问真实 Cloudflare 资源。

## 架构

- `src/`：三语静态 React 应用、Material Web 控件与按路由加载的页面。
- `functions/`、`edge/`：有限动态路由、地区隔离的 HTML 缓存与安全输出。
- `server/`：共享业务服务、D1 查询、审核与 R2 图片发布。
- `worker/`：Better Auth、原生密码计算、会话管理、Durable Object 配额与有界维护任务。
- `control/`：独立账户费用监控、状态分发及指定入口紧急停机。
- `deployment/`、`scripts/release*.mjs`：环境清单、隔离预检与串行自动发布。
- `migrations/`：业务和认证 D1 迁移。
- `public/_routes.json`：明确指定动态入口。首页、搜索界面、后台界面与静态资源不会执行 Pages Functions。

首页自动推荐最多 6 件当前地区可见的已上架商品，初期从本区最近 96 件活动上架商品中按资料完整度排序，算法后续完善；仅加载时请求一次，空位和请求失败均保留静态内容。静态横幅支持横向滑动与按钮切换，后续可承载广告内容。收藏与商家工作台位于头像下拉菜单，展开菜单不查询登录态。

商品和店铺详情在源 HTML 中输出内容与元数据，客户端沿用同一份初始数据。服务端按大陆 CN／其他地区过滤；界面语言不会改变商品区。动态 HTML 只在应用控制的地区缓存键下缓存，对外响应不允许共享代理缓存。

首次发布按区独立生效；内容修订须通过所有当前上架地区的审核后统一替换，新申请地区待审或拒绝不会额外阻止已有地区的换版。Adult 商品可在国际区提交审核，不可提交中国大陆区审核；已有大陆区上架的商品提交 Adult 修订前须先下架大陆区。同内容首次申请新区可复用已发布修订；已作出最终决定的地区重新申请时，先保存新修订，保留原决定。部分上架后撤回未决审核、下架或撤权不会撤销其他仍有效的地区。

当前账户使用邮箱与密码登录，仅设置昵称／显示名，不设置 username。Better Auth 的 `name` 字段保存昵称，不作为登录标识；内部账户 ID 独立于登录方式。管理员需要已验证邮箱、有效会话、明确授予的管理员角色且未被封禁。后续对接 HopeWriteDream 的 Logto 账号体系，本期不实现统一登录迁移。账户认证变更及数据库迁移须在授权部署后完成线上验收，详见 [运维说明](docs/operations.md)。

按钮、菜单、选择器、筛选项、标签页、卡片、徽标、对话框、滑块和表单直接使用 Material Web（卡片与徽标使用依赖中的 labs 组件）；自定义 CSS 仅负责布局、主题 token 与库中没有提供的内容。外观设置支持系统／浅色／深色、主题色 HEX、HCT 调整和九种配色风格，通过官方 Material Color Utilities 生成完整主题并在本机保存。`generate:theme` 在开发和构建前生成默认配色，不依赖远程字体或图标服务。

## 配置与内部测试

项目保持生产候选、测试两套独立业务环境：`main` 对应 [store.vrclearn.com](https://store.vrclearn.com)，`test` 对应 [test-store.vrclearn.com](https://test-store.vrclearn.com)。测试资源统一以 `test-` 开头，D1、R2、KV、DO、认证、限流、Turnstile 和 Access 分别独立，不复制生产账户或媒体。两套继续保持内部 Access 保护，用户范围为 `@vrclearn.com`；Access 准入不授予商店管理权限。

两分支共用业务代码与 `deployment/environments.json` 环境清单。`test` 验证后直接 PR 合入 `main`，不改环境配置、不复制数据，生产重新校验和构建。Cloudflare Workers Builds 协调迁移、辅助 Worker 和 Pages 原生 Git 发布；Pages 独立推送／预览触发关闭，不使用 GitHub Actions 或 Pages Direct Upload。

环境配置由 `scripts/environment.mjs` 生成，错误分支、项目身份、SHA 或跨环境业务引用会停止发布。发布锁和迁移校验和独立存储，结果不明时先读回、人工解锁，不盲目重试。预检和本地测试不能证明远端配置或部署已完成；完整命令、首次切换及恢复见 [运维说明](docs/operations.md)，资源边界见 [架构](docs/architecture.md)。

账户总费用由独立监控 Worker 统一保护，包含同账户的其他项目，保留 10 美元告警、15 美元受限、18 美元维护和人工恢复规则。状态向两环境分发，单独测试资源故障只闭锁测试；账户预算触发则两套共同保护。监控延迟及其他费用意味着这不是账单硬上限。见 [费用与容量](docs/costs.md)。

正式公开或移除 Access 前，必须提醒清空内测数据库并核对测试媒体及配额范围；实际删除另行取得明确授权。


## License

This project is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](LICENSE) for the full text.
