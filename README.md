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

首次发布按区独立生效；内容修订须通过所有当前上架地区的审核后统一替换，新申请地区待审或拒绝不会额外阻止已有地区的换版。同内容首次申请新区可复用已发布修订；已作出最终决定的地区重新申请时，先保存新修订，保留原决定。部分上架后撤回未决审核、下架或撤权不会撤销其他仍有效的地区。

当前账户使用邮箱与密码登录，仅设置昵称／显示名，不设置 username。Better Auth 的 `name` 字段保存昵称，不作为登录标识；内部账户 ID 独立于登录方式。后续对接 HopeWriteDream 账号体系，本期不实现统一登录迁移。

按钮、菜单、选择器、筛选项、标签页、卡片、徽标、对话框、滑块和表单直接使用 Material Web（卡片与徽标使用依赖中的 labs 组件）；自定义 CSS 仅负责布局、主题 token 与库中没有提供的内容。外观设置支持系统／浅色／深色、主题色 HEX、HCT 调整和九种配色风格，通过官方 Material Color Utilities 生成完整主题并在本机保存。`generate:theme` 在开发和构建前生成默认配色，不依赖远程字体或图标服务。

## 配置与内部测试

内部测试版入口为 [store.vrclearn.com](https://store.vrclearn.com)。Access 保护正式站点、媒体以及默认和预览 Pages 入口，仅允许 `@vrclearn.com` 邮箱域；同时提供新邮箱一次性验证码（OTP）和现有 Cloudflare 登录。邮箱 OTP 已实际验证可用，Cloudflare 登录来源另外受其账户成员限制。Access 准入不授予商店账户或管理权限。商店使用专用 D1、两个 R2 桶、KV、辅助 Worker、Turnstile 和秘密绑定；实际资源 ID 已填入配置，秘密不进入仓库。

`npm.cmd run preflight` 检查资源引用和入口约束，当前配置已通过。`deployment/edge-policies.json` 记录已应用的媒体分区、缓存与预置紧急规则；两条紧急封锁规则正常时保持禁用。预检不能代替远端验收，也不授权部署。

Pages 从 Cloudflare 原生连接本仓库，生产分支为 `main`；使用 `.node-version`、锁文件和 `npm ci && npm test && npm run build && npm run preflight` 构建到 `dist`，Pages 部署不依赖 GitHub Actions，不从含未提交改动的本地工作区部署。分支预览自动部署关闭。资源管理优先使用 `cf`；辅助 Worker 的独立发布与 Secret 注入见 [运维说明](docs/operations.md)。本地 CLI 缓存、凭据和验收产物不纳入版本控制。

自动费用监控已通过真实 Cron 验证 V1 账户账单来源，并在人工确认后恢复正常。验收采样估算的 5 美元为 Workers Paid 基础费预留，已返回计费行的累计按量费用为零；费用接口按日更新，保护机制不构成账单硬上限。完整验收范围与未验证项见 [费用与容量](docs/costs.md)、[运维说明](docs/operations.md) 和 [辅助 Worker](worker/README.md)。

## License

This project is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](LICENSE) for the full text.
