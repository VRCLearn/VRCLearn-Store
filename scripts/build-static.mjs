import { readFile, writeFile, mkdir } from "node:fs/promises";
import { buildStaticHeaders, staticBuildContext } from "./static-headers.mjs";

const context = await staticBuildContext();
const headerTemplate = await readFile(new URL("../public/_headers", import.meta.url), "utf8");
await writeFile(new URL("../dist/_headers", import.meta.url), buildStaticHeaders(headerTemplate, context.mediaOrigin));

const source = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const copy = {
    en: { title: "Find your next expression.", intro: "Discover VRChat avatars, clothing, worlds, plugins, tools and services from independent creators.", browse: "Browse products", notice: "Purchases take place on the seller’s website. VRCLearn Store does not process payments or provide chat." },
    "zh-CN": { title: "找到下一种表达。", intro: "探索独立创作者的 VRChat 模型、服饰、场景、插件、工具与服务。", browse: "浏览商品", notice: "商品在商家网站购买，VRCLearn 商店不处理支付，也不提供聊天。" },
    ja: { title: "次の表現を見つけよう。", intro: "クリエイターの VRChat アバター、衣装、ワールド、プラグイン、ツールとサービスを探そう。", browse: "商品を見る", notice: "購入は出品者のサイトで行います。VRCLearn Store は決済やチャットを提供しません。" }
};
for (const [locale, text] of Object.entries(copy)) {
    await mkdir(new URL(`../dist/${locale}/`, import.meta.url), { recursive: true });
    const body = `<header class="static-header"><a href="/${locale}">VRCLearn Store</a></header><main class="static-main"><h1>${text.title}</h1><p>${text.intro}</p><nav><a href="/${locale}/search">${text.browse}</a></nav><p>${text.notice}</p></main>`;
    const html = source.replace(/<html[^>]*>/, `<html lang="${locale}">`).replace(/<title>[\s\S]*?<\/title>/, `<title>VRCLearn Store — ${text.title}</title>`).replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${text.intro}">`).replace(/<div id="root">[\s\S]*?<\/div>/, `<div id="root">${body}</div>`);
    await writeFile(new URL(`../dist/${locale}/index.html`, import.meta.url), html);
}
const routes = JSON.parse(await readFile(new URL("../dist/_routes.json", import.meta.url), "utf8"));
if (routes.include.includes("/*")) throw new Error("Refusing a catch-all function route: static requests must stay static.");
console.log(`Built three static homepages and ${context.environment} media policy; dynamic routes remain explicitly scoped.`);
