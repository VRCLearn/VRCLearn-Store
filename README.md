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
- `worker/`：Better Auth、原生密码计算、MFA、Durable Object 配额与有界维护任务。
- `migrations/`：业务和认证 D1 初始迁移。
- `public/_routes.json`：明确指定动态入口。首页、搜索界面、后台界面与静态资源不会执行 Pages Functions。

商品和店铺详情在源 HTML 中输出内容与元数据，客户端沿用同一份初始数据。服务端按大陆 CN／其他地区过滤；界面语言不会改变商品区。动态 HTML 只在应用控制的地区缓存键下缓存，对外响应不允许共享代理缓存。

按钮、菜单、选择器、筛选项、标签页、卡片、徽标、对话框、滑块和表单直接使用 Material Web（卡片与徽标使用依赖中的 labs 组件）；自定义 CSS 仅负责布局、主题 token 与库中没有提供的内容。外观设置支持系统／浅色／深色、主题色 HEX、HCT 调整和九种配色风格，通过官方 Material Color Utilities 生成完整主题并在本机保存。`generate:theme` 在开发和构建前生成默认配色，不依赖远程字体或图标服务。

## 配置与上线边界

当前配置包含**未创建资源的占位 ID**。必须为此项目单独配置 D1、两个 R2 桶、KV、辅助 Worker、Turnstile 与 secrets，不能复用其他项目的数据库。生产部署前见 [运维说明](docs/operations.md)、[费用与容量](docs/costs.md) 和 [辅助 Worker](worker/README.md)。

`npm.cmd run preflight` 检查占位 ID 和入口约束；当前会按预期失败，防止把未完成配置误认为可直接上线。`deployment/edge-policies.json` 提供待应用的媒体分区和紧急规则表达式。

2026-10-26 已通过 `cf` CLI 只读确认账户具备 Workers Paid、R2、有效的 `vrclearn.com` zone，以及已启用的该域发信能力；尚未为商店创建 Pages、D1 或 R2 资源，也未部署。仓库配置中的账户、zone 与资源 ID 均为待填写值，本地 CLI 缓存不纳入版本控制。

**当前外部限制：** Cloudflare 账户成本接口返回 403。费用读取代码遇到无权限、缺失产品覆盖、数据过期或截断时会保持受限，不能将自动美元监控视为已验证可用。详见费用文档。
