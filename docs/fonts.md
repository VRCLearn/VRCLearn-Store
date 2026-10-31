# 字体

正文、标题与 Material Web 的 brand/plain 字体令牌使用同一字体栈：Noto Sans、Noto Sans SC、Noto Sans JP。日文页面将 JP 排在 SC 前。字号、行高与页面布局不随字体加载状态切换。

字体文件由 Google Fonts 的 `fonts.gstatic.com` 提供，不托管到 R2 或业务 Worker。Google Fonts CSS2 生成的 WOFF2 可变字重声明固定在 `src/fonts.css`，随普通静态 CSS 构建、缓存；运行时不再请求 Google Fonts CSS API。浏览器依据 `unicode-range` 仅下载页面需要的字形分片，不预载完整 CJK 字库。

所有字体声明使用 `font-display: optional`。未赶上首次排版的字体在本次文档中保持回退；后续文档可使用已缓存的字体。此策略优先保证页面稳定，慢网首访不保证显示 Noto。字体载入不控制页面显隐，也不通过 JavaScript 或 `document.fonts.load()` 强制切换已显示的内容。

字体族内部名称为 `VRCLearn Noto Sans`、`VRCLearn Noto Sans SC`、`VRCLearn Noto Sans JP`；字体文件未修改。独立名称隔离本机已安装的同名 Noto，避免可选网页字体失败后重新选中同名本机字体。字体加载失败仍使用原有通用无衬线回退。

## 更新

当前声明由 Google Fonts CSS2 API 于 2026-10-31 生成，使用支持 WOFF2 可变字体的 Chrome User-Agent：

https://fonts.googleapis.com/css2?family=Noto+Sans:ital,wght@0,400..700;1,400..700&family=Noto+Sans+JP:wght@400..700&family=Noto+Sans+SC:wght@400..700&display=optional

更新时直接替换 `src/fonts.css` 中的声明，将三个 `font-family` 改为上述站点专用名称，保留原始 `unicode-range`、400–700 字重范围、Noto Sans 的正常与斜体样式、`font-display: optional` 和 HTTPS Google CDN 文件 URL。不要按商品或账户文本生成 `text=` 请求，不在普通构建中自动更新供应商声明。更新后运行字体策略、安全头与浏览器加载测试。

Noto 字体采用 SIL Open Font License；上游许可见 Google Fonts 仓库的 [Noto Sans](https://github.com/google/fonts/blob/main/ofl/notosans/OFL.txt)、[Noto Sans SC](https://github.com/google/fonts/blob/main/ofl/notosanssc/OFL.txt) 和 [Noto Sans JP](https://github.com/google/fonts/blob/main/ofl/notosansjp/OFL.txt)。测试使用的小型字体子集及其许可证位于 `tests/fixtures/fonts`，不作为站点资产发布。
