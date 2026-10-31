# VRCLearn Store

面向 VRChat 创作者与用户的商品展示、搜索和导购平台。使用 React、TypeScript、Material Web、Cloudflare Workers Static Assets、D1、R2、KV 和 Durable Objects。兑换码在外部商家网站购买，用户在商店内兑换每张卡密对应的私密文本或链接；平台不处理支付或聊天。

项目只允许内部测试环境发布，生产环境未开通。源代码和环境清单保留 `test` 与 `main` 的结构；合并到 `main` 不会创建或发布生产资源。线上状态须通过实际部署和验收记录确认，不能由配置文件推断。

内部测试站：[test-store.vrclearn.com](https://test-store.vrclearn.com/zh-CN)。站点与媒体使用 Cloudflare Access，允许 `@vrclearn.com` 身份访问；商店账户另行注册，密码由使用者自行保存。旧生产、旧测试及旧账户预算监控已退役，新测试库和媒体从空状态初始化。

## 本地运行

使用 Node.js 24 和锁文件安装依赖：

```sh
npm ci
npm run types
npx wrangler d1 migrations apply local-vrclearn-store --local --config deployment/local-app.jsonc
npm run dev
```

本地站点为 `http://127.0.0.1:4173/zh-CN`。Vite 使用 Workers 运行时及本地绑定，同时启动主 Worker 和辅助 Worker；不连接云端业务数据库或媒体桶。本地开发 Secret 放在被忽略的 `deployment/.dev.vars`，设置独立的 `BETTER_AUTH_SECRET` 和测试用 `TURNSTILE_SECRET_KEY`，不要使用云端秘密。

```sh
npm run check
npm test
npm run build
npm run preflight
npm run test:browser
npm run test:capacity
```

构建输出为 `dist/client`、`dist/app/wrangler.json` 和 `dist/support/wrangler.json`。`npm run preview` 在同一端口运行构建产物。测试使用独立本地数据；容量测试在内存 SQLite 中建立约 100 家商家、10,000 件商品，不访问真实 Cloudflare 资源。

## 产品与权限

商品页提供“兑换”与“购买兑换码”：前者要求登录并输入卡密，后者跳转商家设置、随商品审核的 HTTPS 网页。商家在商品编辑页的“兑换码管理”中导入 JSON，每张卡密对应独立交付内容；用户可在账户的“我的兑换”中重新查看。格式、限制和访问规则见 [卡密兑换](docs/redemptions.md)。

成功兑换的用户可发表商品评论，标记为“已兑换”，并可修改或删除自己的评论。评论按地区隔离、按需分页加载，支持举报及管理员隐藏／恢复；规则见 [商品评论](docs/comments.md)。

- 三语界面：简体中文、英文、日文；商品保留商家原文，界面语言不改变商品区域。
- 邮箱与密码注册、登录；只设置昵称，不设置 username。不发送邮箱验证或找回密码邮件，不验证邮箱所有权，不提供 MFA。已登录用户可修改密码和撤销会话。
- 商家自行入驻，每账户一个店铺；地区发布权限、商品发布、修订及公开店铺资料均须审核。
- CN 与国际区由服务端根据可信 IP 国家信息决定；未知地区拒绝商品查询。Adult 商品只能提交国际区审核，已有 CN 上架时须先下架 CN 才能提交 Adult 修订。
- 搜索、筛选、收藏、举报、首页推荐与横幅展示；图片只托管商品展示内容，不托管模型文件或视频。

管理员权限依据内部账户 ID 和明确授予的角色，不因输入某个邮箱而自动获得。未来使用 Loginflare 替换身份认证；本期不实现统一登录、自动关联或账户迁移。

## 代码与发布

`app/` 是主 Worker 入口；`server/` 保存共享业务服务，API 与详情 HTML 直接调用这些服务。`worker/` 提供内部认证、业务配额和有界清理。静态界面由 Material Web 组件组成，主题与滚动条集中管理。

字体使用锁定版本的 Fontsource Noto Sans、Noto Sans SC 和 Noto Sans JP 可变字重包，由 Vite 输出为带哈希的同域静态资产。页面与 Material Web 共用现有 Noto 字体栈，日文仍优先使用 JP 字形。仅预加载 Noto Sans 常用拉丁分片，其他字形按需加载；构建与开发共用 `font-display: optional`、400–700 字重和独立字体族名策略，避免晚到换字和本机同名字体干扰。无外部字体请求；许可随 `/font-licenses.txt` 分发。详见 [字体说明](docs/fonts.md)。

`deployment/environments.json` 是云端资源身份的权威清单。未配置或未开通的环境拒绝发布；测试资源以 `test-` 开头。测试从新建空库和空媒体桶开始，不复制旧账户、会话、媒体或配额状态。

Cloudflare Workers Builds 从 `test` 分支执行校验、测试、一次构建、安全迁移、辅助 Worker 和主 Worker 发布、版本读回及冒烟。无需部署用 GitHub Actions；业务运行时不持有部署凭据。详情见 [架构](docs/architecture.md)、[运维说明](docs/operations.md) 和 [费用与容量](docs/costs.md)。

当前没有账户账单监控、自动预算告警或按美元阈值停机机制；保留业务配额、限流、CPU 限制和有界后台任务。这些不构成账单上限。

## 正式公开前

正式公开、移除 Access 或开放公众访问前，必须提醒所有者清空内测数据库，并核对测试媒体和配额的处理范围。实际删除仍须另行明确授权，随后初始化正式管理员。见 [正式公开上线前](docs/operations.md#正式公开上线前)。

## 许可证

本项目采用 [AGPL-3.0-only](LICENSE)。
