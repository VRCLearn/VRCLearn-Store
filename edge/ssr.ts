import type { Locale, Product, Shop } from "../shared/contracts";
import { LOCALES } from "../shared/contracts";
import type { AppEnv } from "../server/env";
import { getProduct, getShop, sitemap } from "../server/catalog";
import { HttpError, regionOf } from "../server/security";
import { escapeHtml, safeJson, safeMarkdown } from "./html";
import { allowedHost, secureResponse, unavailable } from "./respond";
interface EdgeContext {
    request: Request;
    env: AppEnv;
    ctx: Pick<ExecutionContext, "waitUntil">;
}

function outward(response: Response, head = false): Response {
    const result = secureResponse(new Response(head ? null : response.body, response));
    // Only our explicit region-keyed Cache API entries may be shared.
    result.headers.set("Cache-Control", "private, no-store");
    return result;
}

function csp(nonce: string, mediaOrigin: string): string {
    return `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: ${mediaOrigin}; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
}

async function cacheKey(request: Request, env: AppEnv): Promise<Request> {
    const url = new URL(request.url);
    url.search = "";
    url.searchParams.set("__region", regionOf(request));
    url.searchParams.set("__release", env.RELEASE_SHA);
    const version = await env.STATE.get("catalog:version");
    url.searchParams.set("__version", version ?? "initial");
    return new Request(url, { method: "GET" });
}

function staticDetail(data: Product | Shop, kind: "product" | "shop", locale: Locale): string {
    if (kind === "product") {
        const product = data as Product;
        return `<article><p><a href="/${locale}/shops/${encodeURIComponent(product.shopId)}">${escapeHtml(product.shopName)}</a></p><h1>${escapeHtml(product.title)}</h1>${product.r18 ? "<p>Adult</p>" : ""}<p>${escapeHtml(product.summary)}</p><div>${product.images.map((image) => `<img src="${escapeHtml(image)}" alt="${escapeHtml(product.title)}" loading="lazy" width="640" height="640">`).join("")}</div><section>${safeMarkdown(product.description)}</section><p>${product.pricing === "free" ? "Free / 免费 / 無料" : `${escapeHtml(product.currency ?? "")} ${product.price ?? ""}`}</p><a href="${escapeHtml(product.purchaseUrl)}" rel="nofollow noopener noreferrer" target="_blank">Buy redemption code / 购买兑换码 / 引き換えコードを購入</a></article>`;
    }
    const shop = data as Shop;
    return `<article><h1>${escapeHtml(shop.name)}</h1><section>${safeMarkdown(shop.description)}</section><p><a href="${escapeHtml(shop.websiteUrl)}" target="_blank" rel="nofollow noopener noreferrer">${escapeHtml(shop.websiteUrl)}</a></p><a href="/${locale}/search">Browse products / 浏览商品 / 商品を見る</a></article>`;
}

export async function detailPage(context: EdgeContext, kind: "product" | "shop"): Promise<Response> {
    const { request, env } = context;
    if (!["GET", "HEAD"].includes(request.method)) return secureResponse(new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } }));
    if (!allowedHost(request, env)) return secureResponse(new Response("Not found", { status: 404 }));
    try {
        const pieces = new URL(request.url).pathname.split("/").slice(1);
        const locale = pieces[0] as Locale;
        if (!LOCALES.includes(locale) || pieces.length !== 3 || pieces[1] !== (kind === "product" ? "products" : "shops")) throw new HttpError(404, "NOT_FOUND", "Page not found.");
        let id: string;
        try { id = decodeURIComponent(pieces[2]); }
        catch { throw new HttpError(404, "NOT_FOUND", "Page not found."); }
        if (!id || /[\/\\\u0000-\u001f\u007f]/.test(id)) throw new HttpError(404, "NOT_FOUND", "Page not found.");
        const key = await cacheKey(request, env);
        const cached = await caches.default.match(key);
        if (cached) return outward(cached, request.method === "HEAD");
        const data = kind === "product" ? await getProduct(request, env, id) : await getShop(request, env, id);
        const title = kind === "product" ? (data as Product).title : (data as Shop).name;
        const description = kind === "product" ? (data as Product).summary : (data as Shop).description.slice(0, 200);
        const canonical = `${env.ORIGIN}/${locale}/${kind === "product" ? "products" : "shops"}/${encodeURIComponent(id)}`;
        const shell = await env.ASSETS.fetch(new Request(`${env.ORIGIN}/${locale}`));
        if (!shell.ok) throw new Error("Static shell unavailable");
        let html = await shell.text();
        const nonce = crypto.randomUUID().replaceAll("-", "");
        const product = kind === "product" ? data as Product : null;
        const structured = product ? {
            "@context": "https://schema.org", "@type": "Product", name: title, description,
            image: (data as Product).images, url: canonical,
            ...(product.pricing === "free" || (product.price !== null && product.currency) ? {
                offers: { "@type": "Offer", url: product.purchaseUrl, price: product.pricing === "free" ? 0 : product.price, priceCurrency: product.currency ?? "USD" }
            } : {})
        } : { "@context": "https://schema.org", "@type": "Organization", name: title, description, url: canonical };
        const metadata = `<title>${escapeHtml(title)} — VRCLearn Store</title><meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="${kind === "product" ? "product" : "website"}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonical)}">${kind === "product" && (data as Product).images[0] ? `<meta property="og:image" content="${escapeHtml((data as Product).images[0])}">` : ""}<script nonce="${nonce}" type="application/ld+json">${safeJson(structured)}</script>`;
        html = html.replace(/<html[^>]*>/, `<html lang="${locale}">`).replace(/<title>[\s\S]*?<\/title>/, "").replace(/<meta\s+name="description"[^>]*>/, "").replace(/<meta\s+property="og:[^"]+"[^>]*>/g, "").replace("</head>", `${metadata}</head>`);
        html = html.replace(/<div id="root">[\s\S]*?<\/div>/, `<div id="root"><main id="detail-root">${staticDetail(data, kind, locale)}</main></div>`);
        html = html.replace("</head>", `<script nonce="${nonce}">window.__STORE_DATA__=${safeJson({ kind, data, locale })};</script></head>`);
        const response = secureResponse(new Response(html, { headers: {
            "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=0, s-maxage=60",
            "Content-Security-Policy": csp(nonce, env.MEDIA_ORIGIN), "Vary": "Accept-Encoding"
        } }));
        context.ctx.waitUntil(caches.default.put(key, response.clone()));
        return outward(response, request.method === "HEAD");
    } catch (error) {
        const status = error instanceof HttpError ? error.status : 503;
        return secureResponse(new Response(request.method === "HEAD" ? null : status === 404 ? "Page not found." : "This page is unavailable.", {
            status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...(status === 503 ? { "Retry-After": "60" } : {}) }
        }));
    }
}

export async function sitemapPage(context: EdgeContext): Promise<Response> {
    const { request, env } = context;
    if (!["GET", "HEAD"].includes(request.method)) return secureResponse(new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } }));
    if (!allowedHost(request, env)) return secureResponse(new Response("Not found", { status: 404 }));
    try {
        regionOf(request);
        const path = new URL(request.url).pathname;
        if (path === "/sitemap.xml") {
            const body = `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${LOCALES.map((locale) => `<sitemap><loc>${env.ORIGIN}/sitemaps/${locale}.xml</loc></sitemap>`).join("")}</sitemapindex>`;
            return secureResponse(new Response(request.method === "HEAD" ? null : body, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" } }));
        }
        const locale = path.match(/^\/sitemaps\/(en|zh-CN|ja)\.xml$/)?.[1] as Locale | undefined;
        if (!locale) return secureResponse(new Response("Not found", { status: 404 }));
        const key = await cacheKey(request, env);
        const cached = await caches.default.match(key);
        if (cached) return outward(cached, request.method === "HEAD");
        const urls = await sitemap(request, env, locale);
        const body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${escapeHtml(url)}</loc></url>`).join("")}</urlset>`;
        const response = secureResponse(new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=0, s-maxage=60" } }));
        context.ctx.waitUntil(caches.default.put(key, response.clone()));
        return outward(response, request.method === "HEAD");
    } catch (error) {
        return secureResponse(unavailable(error instanceof HttpError ? error.status : 503));
    }
}
