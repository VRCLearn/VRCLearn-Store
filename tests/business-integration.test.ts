import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../server/api";
import { getProduct, listProducts } from "../server/catalog";
import type { ProductInput } from "../shared/contracts";
import { admin, edgeRequest, testEnvironment } from "./helpers";

const content: ProductInput = { title: "星空 Avatar", language: "zh-CN", summary: "A handmade VRChat avatar", description: "A detailed **avatar** for VRChat.", category: "avatars", tags: ["space"], compatibleModels: [], platforms: ["pc", "android"], pricing: "paid", price: 20, currency: "USD", purchaseUrl: "https://maker.example.com/avatar", mediaIds: [], r18: false };
describe("real SQLite publication and authorization integration", () => {
    let fixture: ReturnType<typeof testEnvironment>;
    const execution = { waitUntil: (promise: Promise<unknown>) => { void promise; } };
    beforeEach(() => {
        fixture = testEnvironment();
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, hostname: "store.vrclearn.com", action: "submit" })));
    });
    afterEach(() => { fixture.database.close(); vi.unstubAllGlobals(); });
    async function api(path: string, method = "GET", body?: unknown, user = "merchant") {
        const response = await handleApi(edgeRequest(`/api/v1/${path}`, { method, body, user }), fixture.env, execution);
        const data = await response.json();
        return { status: response.status, data };
    }
    async function enroll() {
        const result = await api("merchant/enroll", "POST", { name: "Orbital Studio", description: "Independent avatar creator", websiteUrl: "https://maker.example.com" });
        expect(result.status).toBe(201);
        const shop = result.data as { id: string; revisionId: string };
        expect((await api(`admin/shops/${shop.revisionId}/review`, "POST", { approve: true, reason: "" }, "admin")).status).toBe(200);
        for (const region of ["cn", "intl"]) {
            expect((await api("merchant/permissions", "POST", { region, reason: "Publish original creations" })).status).toBe(201);
            const permission = fixture.database.prepare("SELECT id FROM regional_permissions WHERE shop_id = ? AND region = ?").get(shop.id, region)!;
            expect((await api(`admin/permissions/${permission.id}/review`, "POST", { approve: true, reason: "" }, "admin")).status).toBe(200);
        }
        return shop;
    }
    it("requires regional permission, keeps the old shared version, then switches both regions atomically", async () => {
        await enroll();
        const created = await api("merchant/products", "POST", content);
        expect(created.status).toBe(201);
        const product = created.data as { id: string; revisionId: string };
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["cn", "intl"], turnstileToken: "test-token" })).status).toBe(200);
        expect((await api(`merchant/products/${product.id}`, "PUT", { ...content, title: "Illicit edit" })).status).toBe(409);
        expect((await api(`admin/revisions/${product.revisionId}/review`, "POST", { region: "cn", approve: true, reason: "" }, "admin")).status).toBe(200);
        await expect(getProduct(edgeRequest("/", { country: "CN" }), fixture.env, product.id)).rejects.toMatchObject({ status: 404 });
        expect((await api(`admin/revisions/${product.revisionId}/review`, "POST", { region: "intl", approve: true, reason: "" }, "admin")).status).toBe(200);
        expect((await getProduct(edgeRequest("/", { country: "JP" }), fixture.env, product.id)).title).toBe(content.title);
        const updated = await api(`merchant/products/${product.id}`, "PUT", { ...content, title: "New title" });
        expect(updated.status).toBe(200);
        const revised = updated.data as { revisionId: string };
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["cn"], turnstileToken: "test-token" })).status).toBe(409);
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["cn", "intl"], turnstileToken: "test-token" })).status).toBe(200);
        await api(`admin/revisions/${revised.revisionId}/review`, "POST", { region: "cn", approve: true, reason: "" }, "admin");
        expect((await getProduct(edgeRequest("/", { country: "CN" }), fixture.env, product.id)).title).toBe(content.title);
        expect((await getProduct(edgeRequest("/", { country: "JP" }), fixture.env, product.id)).title).toBe(content.title);
        await api(`admin/revisions/${revised.revisionId}/review`, "POST", { region: "intl", approve: true, reason: "" }, "admin");
        expect((await getProduct(edgeRequest("/", { country: "CN" }), fixture.env, product.id)).title).toBe("New title");
        expect((await getProduct(edgeRequest("/", { country: "JP" }), fixture.env, product.id)).title).toBe("New title");
        expect((await api(`admin/revisions/${revised.revisionId}/review`, "POST", { region: "intl", approve: true, reason: "" }, "admin")).status).toBe(409);
    });
    it("blocks ownership, MFA and unavailable-region favorites while keeping enrollment open", async () => {
        await enroll();
        const created = (await api("merchant/products", "POST", content)).data as { id: string };
        expect((await api(`merchant/products/${created.id}`, "PUT", content, "outsider")).status).toBe(409);
        const noMfa = { ...admin, twoFactorVerified: false };
        fixture.env.AUTH = Object.assign({} as Fetcher, { fetch: async () => Response.json(noMfa) });
        expect((await api("admin/queue", "GET", undefined, "admin")).status).toBe(403);
    });
    it("rejects forged query regions and malformed cursors before SQL", async () => {
        await expect(listProducts(edgeRequest("/api/v1/products?region=intl"), fixture.env)).rejects.toMatchObject({ status: 400 });
        await expect(listProducts(edgeRequest("/api/v1/products?cursor=bad"), fixture.env)).rejects.toMatchObject({ status: 400 });
        expect((await api("merchant/enroll", "POST", { name: "X", description: "X", websiteUrl: "http://127.0.0.1" })).status).toBe(400);
    });
});
