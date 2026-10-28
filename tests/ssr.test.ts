import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detailPage, sitemapPage } from "../edge/ssr";
import { edgeRequest, testEnvironment } from "./helpers";
import type { AppEnv } from "../server/env";

describe("region-scoped HTML and sitemap", () => {
    let fixture: ReturnType<typeof testEnvironment>;
    const productId = crypto.randomUUID();
    const shopId = crypto.randomUUID();
    const pending: Promise<unknown>[] = [];
    beforeEach(() => {
        fixture = testEnvironment();
        const cache = new Map<string, Response>();
        vi.stubGlobal("caches", { default: { match: async (key: Request) => cache.get(key.url)?.clone(), put: async (key: Request, response: Response) => { cache.set(key.url, response.clone()); } } });
        const revision = crypto.randomUUID();
        const shopRevision = crypto.randomUUID();
        const time = new Date().toISOString();
        const content = { title: "星空 Avatar", language: "zh-CN", summary: "Original avatar", description: "**Visible description**\n\n<script>evil()</script>", category: "avatars", tags: [], compatibleModels: [], platforms: ["pc"], pricing: "paid", price: 10, currency: "USD", purchaseUrl: "https://maker.example.com/product", mediaIds: [], r18: false };
        fixture.database.prepare("INSERT INTO shops(id,owner_user_id,current_revision_id,created_at) VALUES(?,?,?,?)").run(shopId, "maker", shopRevision, time);
        fixture.database.prepare("INSERT INTO shop_revisions(id,shop_id,content_json,status,created_at) VALUES(?,?,?,'approved',?)").run(shopRevision, shopId, JSON.stringify({ name: "Orbit Studio", description: "Original creations", websiteUrl: "https://maker.example.com" }), time);
        fixture.database.prepare("INSERT INTO regional_permissions(id,shop_id,region,status,reason,updated_at) VALUES(?,?,'cn','approved','Original works',?)").run(crypto.randomUUID(), shopId, time);
        fixture.database.prepare("INSERT INTO products(id,shop_id,current_revision_id,latest_revision_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(productId, shopId, revision, revision, time, time);
        fixture.database.prepare("INSERT INTO product_revisions(id,product_id,content_json,status,created_at,updated_at) VALUES(?,?,?,'published',?,?)").run(revision, productId, JSON.stringify(content), time, time);
        fixture.database.prepare("INSERT INTO publication_requests(revision_id,region,status) VALUES(?,'cn','approved')").run(revision);
        fixture.database.prepare("INSERT INTO publications(product_id,region,revision_id,media_token,active,updated_at,category,pricing,currency,price) VALUES(?,'cn',?,'ssr-fixture',1,?,'avatars','paid','USD',10)").run(productId, revision, time);
    });
    afterEach(async () => { await Promise.all(pending.splice(0)); fixture.database.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
    const context = (request: Request) => Object.assign({} as EventContext<AppEnv, string, unknown>, { request, env: fixture.env, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    it("returns searchable HTML, safe Markdown, JSON-LD and a nonce before JavaScript", async () => {
        const response = await detailPage(context(edgeRequest(`/zh-CN/products/${productId}`)), "product");
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("<h1>星空 Avatar</h1>");
        expect(html).toContain("<strong>Visible description</strong>");
        expect(html).not.toContain("<script>evil()");
        expect(html).toContain('type="application/ld+json"');
        expect(html).toContain("window.__STORE_DATA__=");
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(response.headers.get("Content-Security-Policy")).toContain("nonce-");
    });
    it("does not share a mainland cached detail with an international request", async () => {
        expect((await detailPage(context(edgeRequest(`/en/products/${productId}`)), "product")).status).toBe(200);
        await Promise.all(pending.splice(0));
        expect((await detailPage(context(edgeRequest(`/en/products/${productId}`, { country: "JP" })), "product")).status).toBe(404);
    });
    it("sitemap contains only visible-region product URLs and rejects alternate hosts", async () => {
        const mainland = await sitemapPage(context(edgeRequest("/sitemaps/en.xml")));
        expect(await mainland.text()).toContain(productId);
        const international = await sitemapPage(context(edgeRequest("/sitemaps/en.xml", { country: "US" })));
        expect(await international.text()).not.toContain(productId);
        expect((await detailPage(context(new Request(`https://preview.pages.dev/en/products/${productId}`)), "product")).status).toBe(404);
    });
    it.each(["pending", "rejected", "missing"])("serves only the approved region of a pending snapshot when the other regional decision is %s", async (status) => {
        const revision = fixture.database.prepare("SELECT current_revision_id FROM products WHERE id = ?").get(productId)?.current_revision_id;
        fixture.database.prepare("UPDATE product_revisions SET status = 'pending' WHERE id = ?").run(revision!);
        fixture.database.prepare("INSERT INTO regional_permissions(id,shop_id,region,status,reason,updated_at) VALUES(?,?,'intl','approved','Original works',?)").run(crypto.randomUUID(), shopId, new Date().toISOString());
        // Even an active projection must not bypass this region's review decision.
        fixture.database.prepare("INSERT INTO publications(product_id,region,revision_id,media_token,active,updated_at,category,pricing,currency,price) VALUES(?,'intl',?,'unapproved-fixture',1,?,'avatars','paid','USD',10)").run(productId, revision!, new Date().toISOString());
        if (status !== "missing") fixture.database.prepare("INSERT INTO publication_requests(revision_id,region,status) VALUES(?,'intl',?)").run(revision!, status);
        const cnDetail = await detailPage(context(edgeRequest(`/en/products/${productId}`)), "product");
        expect(cnDetail.status).toBe(200);
        expect(await cnDetail.text()).toContain("<h1>星空 Avatar</h1>");
        expect(await (await sitemapPage(context(edgeRequest("/sitemaps/en.xml")))).text()).toContain(productId);
        expect((await detailPage(context(edgeRequest(`/en/products/${productId}`, { country: "JP" })), "product")).status).toBe(404);
        expect(await (await sitemapPage(context(edgeRequest("/sitemaps/en.xml", { country: "JP" })))).text()).not.toContain(productId);
    });
    it.each(["maintenance", "kv-failure"])("stops cached HTML and every sitemap before cache or database access on %s", async (failure) => {
        expect((await detailPage(context(edgeRequest(`/en/products/${productId}`)), "product")).status).toBe(200);
        expect((await detailPage(context(edgeRequest(`/en/shops/${shopId}`)), "shop")).status).toBe(200);
        expect((await sitemapPage(context(edgeRequest("/sitemaps/en.xml")))).status).toBe(200);
        await Promise.all(pending.splice(0));
        const cache = vi.spyOn(caches.default, "match");
        const before = fixture.queries.length;
        if (failure === "maintenance") fixture.state.set("budget:state", JSON.stringify({ mode: "maintenance", updatedAt: new Date().toISOString() }));
        else vi.spyOn(fixture.env.STATE, "get").mockRejectedValue(new Error("KV unavailable"));
        for (const method of ["GET", "HEAD"]) {
            const responses = [
                await detailPage(context(edgeRequest(`/en/products/${productId}`, { method })), "product"),
                await detailPage(context(edgeRequest(`/en/shops/${shopId}`, { method })), "shop"),
                await sitemapPage(context(edgeRequest("/sitemap.xml", { method }))),
                await sitemapPage(context(edgeRequest("/sitemaps/en.xml", { method }))),
            ];
            for (const response of responses) {
                expect(response.status).toBe(503);
                expect(response.headers.get("Cache-Control")).toBe("no-store");
                expect(response.headers.get("Retry-After")).toBe("60");
                expect(await response.text()).not.toContain(productId);
            }
        }
        expect(cache).not.toHaveBeenCalled();
        expect(fixture.queries).toHaveLength(before);
    });
});
