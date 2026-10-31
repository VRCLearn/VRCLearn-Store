# 字体

正文、标题与 Material Web 的 brand/plain 字体令牌继续共用 Noto Sans、Noto Sans SC、Noto Sans JP。日文页面将 JP 排在 SC 前。保留 400–700 字重、Noto Sans 正常与斜体样式，以及既有字号、行高和系统无衬线后备字体。

## 自托管与预加载

使用精确锁定版本的 `@fontsource-variable/noto-sans`、`@fontsource-variable/noto-sans-sc` 和 `@fontsource-variable/noto-sans-jp`。`src/fonts.css` 直接引入包内的 `wght.css`，Noto Sans 另引入 `wght-italic.css`，不手写或复制字形分片声明。Vite 将引用的 WOFF2 输出到带内容哈希的 `/assets/` 文件；即使很小的分片也不内联为 data URL。

字体由本站 Workers Static Assets 提供，不经业务 API、D1 或 R2，也不请求 Google Fonts 或其他字体 CDN。现有 `/assets/*` 响应使用一年 immutable 缓存，字体 CSP 仅允许 `font-src 'self'`。

`index.html` 使用 `<link rel="preload" as="font" type="font/woff2" crossorigin>` 提前请求常用的 Noto Sans 正常拉丁分片。Vite 将源路径转换成与字体 CSS 相同的带哈希文件地址，避免预加载与实际渲染重复下载。三语静态 HTML、404 和商品／店铺详情都保留这条预加载。中文、日文字形以及斜体按 `unicode-range` 需求加载，不预加载整套 CJK 字库。

## 防止字体抖动

开发与构建共用 Vite PostCSS 策略：保留 Fontsource 的文件和 `unicode-range`，将字重声明限定为 400–700，将 `font-display` 设为 `optional`。字体族内部名称仍为 `VRCLearn Noto Sans`、`VRCLearn Noto Sans SC`、`VRCLearn Noto Sans JP`，隔离本机已安装的同名 Noto；字体文件本身不修改。

预加载提高字体在首次排版前就绪的机会，不承诺任意网络下首访必用 Noto。未赶上首次排版的字体在本次文档中保持后备字体，后续文档可使用已缓存的字体。加载不控制页面显隐，不使用 JavaScript 强制换字，也不通过轮询等待字体。

## 维护与许可

升级字体时先核对三个包的版本、OFL-1.1 许可和引入体积，再更新精确版本与锁文件。执行 `npm run generate:font-notices` 更新 `public/font-licenses.txt`；普通构建也会生成该文件。它保留三个上游字体包的完整版权与许可文本，应用的 AGPL-3.0-only 许可不替代字体许可。

字体测试读取实际构建 CSS 与字体资产，验证同域请求、预加载复用、缓存命中、晚到不换字及失败时内容可用；不依赖独立字体样本或外部网络。更新后运行单元测试、构建、预检和三语桌面／移动端字体浏览器测试。
