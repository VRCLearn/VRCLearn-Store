import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildStaticHeaders, staticBuildContext } from "./static-headers.mjs";

export const uiRoutes = JSON.parse(await readFile(new URL("../shared/routes.json", import.meta.url), "utf8"));
const copy = {
    en: {
        title: "Find your next expression.", intro: "Discover VRChat avatars, clothing, worlds, plugins, tools and services from independent creators.", browse: "Browse products", notice: "Purchases take place on the seller’s website. VRCLearn Store does not process payments or provide chat.",
        pages: { search: "Browse products", favorites: "Favorites", account: "Account", merchant: "Merchant workspace", admin: "Admin workspace", privacy: "Privacy", terms: "Terms", security: "Security", maintenance: "Service status" }, notFound: "Page not found", returnHome: "Return to storefront",
    },
    "zh-CN": {
        title: "找到下一种表达。", intro: "探索独立创作者的 VRChat 模型、服饰、场景、插件、工具与服务。", browse: "浏览商品", notice: "商品在商家网站购买，VRCLearn 商店不处理支付，也不提供聊天。",
        pages: { search: "浏览商品", favorites: "收藏", account: "账户", merchant: "商家工作台", admin: "管理工作台", privacy: "隐私", terms: "使用条款", security: "安全", maintenance: "服务状态" }, notFound: "页面不存在", returnHome: "返回商店",
    },
    ja: {
        title: "次の表現を見つけよう。", intro: "クリエイターの VRChat アバター、衣装、ワールド、プラグイン、ツールとサービスを探そう。", browse: "商品を見る", notice: "購入は出品者のサイトで行います。VRCLearn Store は決済やチャットを提供しません。",
        pages: { search: "商品を見る", favorites: "お気に入り", account: "アカウント", merchant: "出品者ワークスペース", admin: "管理ワークスペース", privacy: "プライバシー", terms: "利用規約", security: "セキュリティ", maintenance: "サービス状況" }, notFound: "ページが見つかりません", returnHome: "ストアに戻る",
    },
};

export function staticPageHtml(source, locale, page = "") {
    const text = copy[locale];
    if (!text || (page !== "404" && !uiRoutes.staticPages.includes(page))) throw new Error("Unknown static interface route");
    const title = page === "404" ? text.notFound : page ? text.pages[page] : text.title;
    const body = `<header class="static-header"><a href="/${locale}">VRCLearn Store</a></header><main class="static-main"><h1>${title}</h1>${page === "404" ? `<a href="/${locale}">${text.returnHome}</a>` : `<p>${text.intro}</p><nav><a href="/${locale}/search">${text.browse}</a></nav><p>${text.notice}</p>`}</main>`;
    return source.replace(/<html[^>]*>/, `<html lang="${locale}">`)
        .replace(/<title>[\s\S]*?<\/title>/, `<title>VRCLearn Store — ${title}</title>`)
        .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${text.intro}">`)
        .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="VRCLearn Store — ${title}">`)
        .replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${text.intro}">`)
        .replace(/<div id="root">[\s\S]*?<\/div>/, `<div id="root">${body}</div>`);
}

export async function buildStaticPages(directory = new URL("../dist/client/", import.meta.url), variables = process.env) {
    const context = await staticBuildContext(variables);
    const destination = directory instanceof URL ? directory : pathToFileURL(`${resolve(directory)}/`);
    const source = await readFile(new URL("index.html", destination), "utf8");
    const template = await readFile(new URL("../public/_headers", import.meta.url), "utf8");
    await writeFile(new URL("_headers", destination), buildStaticHeaders(template, context.mediaOrigin));
    for (const locale of uiRoutes.locales) for (const page of uiRoutes.staticPages) {
        const folder = new URL(`${locale}/${page ? `${page}/` : ""}`, destination);
        await mkdir(folder, { recursive: true });
        await writeFile(new URL("index.html", folder), staticPageHtml(source, locale, page));
    }
    await writeFile(new URL("404.html", destination), staticPageHtml(source, "en", "404"));
    console.log(`Built ${uiRoutes.locales.length * uiRoutes.staticPages.length} static interfaces and ${context.environment} media policy.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildStaticPages();
