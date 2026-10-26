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
        fixture.database.prepare("INSERT INTO publications(product_id,region,revision_id,media_token,active,updated_at,category,pricing,currency,price) VALUES(?,'cn',?,'ssr-fixture',1,?,'avatars','paid','USD',10)").run(productId, revision, time);
    });
    afterEach(async () => { await Promise.all(pending.splice(0)); fixture.database.close(); vi.unstubAllGlobals(); });
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
});
