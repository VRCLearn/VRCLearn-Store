import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { handleApi } from "../server/api";
import type { ProductInput } from "../shared/contracts";
import { edgeRequest, testEnvironment } from "./helpers";

const content: ProductInput = { title: "Version A", language: "en", summary: "An original product", description: "Original creator content", category: "avatars", tags: [], compatibleModels: [], platforms: ["pc"], pricing: "paid", price: 5, currency: "USD", purchaseUrl: "https://maker.example.com/product", mediaIds: [], r18: false };
const profile = { name: "Studio", description: "Original creations", websiteUrl: "https://maker.example.com" };
const execution = { waitUntil(promise: Promise<unknown>) { void promise; } };
interface Result { id: string; revisionId: string; error?: { code: string } }

describe("retained revision storage", () => {
    let fixture: ReturnType<typeof testEnvironment>;
    beforeEach(() => {
        fixture = testEnvironment();
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, hostname: "store.vrclearn.com", action: "submit" })));
    });
    afterEach(() => { fixture.database.close(); vi.unstubAllGlobals(); });
    async function api(path: string, method = "GET", body?: unknown, user = "merchant") {
        const response = await handleApi(edgeRequest(`/api/v1/${path}`, { method, body, user }), fixture.env, execution);
        return { status: response.status, data: await response.json() as Result };
    }
    async function setup(approved = false) {
        const shop = (await api("merchant/enroll", "POST", profile)).data;
        if (approved) {
            expect((await api(`admin/shops/${shop.revisionId}/review`, "POST", { approve: true }, "admin")).status).toBe(200);
            const permission = (await api("merchant/permissions", "POST", { region: "cn", reason: "Publish original works" })).data;
            expect((await api(`admin/permissions/${permission.id}/review`, "POST", { approve: true }, "admin")).status).toBe(200);
        }
        const product = (await api("merchant/products", "POST", content)).data;
        return { shop, product };
    }
    function totals() { return fixture.database.prepare("SELECT row_count, content_bytes FROM revision_storage_total WHERE id = 1").get()!; }
    function assertAllocation() {
        const actual = fixture.database.prepare("SELECT COUNT(*) AS row_count, COALESCE(SUM(length(CAST(content_json AS BLOB))), 0) AS content_bytes FROM (SELECT content_json FROM shop_revisions UNION ALL SELECT content_json FROM product_revisions)").get();
        expect(totals()).toEqual(actual);
        const actualShops = fixture.database.prepare(`SELECT s.id AS shop_id, COUNT(r.content_json) AS row_count, COALESCE(SUM(length(CAST(r.content_json AS BLOB))), 0) AS content_bytes FROM shops s LEFT JOIN (SELECT shop_id, content_json FROM shop_revisions UNION ALL SELECT p.shop_id, r.content_json FROM product_revisions r JOIN products p ON p.id = r.product_id) r ON r.shop_id = s.id GROUP BY s.id ORDER BY s.id`).all();
        expect(fixture.database.prepare("SELECT shop_id, row_count, content_bytes FROM revision_storage_shops ORDER BY shop_id").all()).toEqual(actualShops);
    }
    // Interleave a second operation after the first request has read its snapshot.
    function beforeBatch(action: () => Promise<void>) {
        const batch = fixture.env.DB.batch.bind(fixture.env.DB);
        let fired = false;
        fixture.env.DB.batch = async (statements) => {
            if (!fired) { fired = true; await action(); }
            return batch(statements);
        };
        return () => expect(fired).toBe(true);
    }

    it("keeps repeated product draft saves bounded while issuing fresh revision IDs", async () => {
        const { product } = await setup();
        let previous = product.revisionId;
        for (let index = 0; index < 20; index++) {
            const result = await api(`merchant/products/${product.id}`, "PUT", { ...content, title: `Version ${index}` });
            expect(result.status).toBe(200);
            expect(result.data.revisionId).not.toBe(previous);
            expect(fixture.database.prepare("SELECT id FROM product_revisions WHERE id = ?").get(previous)).toBeUndefined();
            previous = result.data.revisionId;
        }
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM product_revisions").get()?.n).toBe(1);
        assertAllocation();
    });
    it("keeps repeated pending shop saves bounded and invalidates stale review IDs", async () => {
        const { shop } = await setup();
        let previous = shop.revisionId;
        for (let index = 0; index < 20; index++) {
            const result = await api("merchant/shop", "PUT", { ...profile, name: `Studio ${index}` });
            expect(result.status).toBe(200);
            expect(result.data.revisionId).not.toBe(previous);
            expect((await api(`admin/shops/${previous}/review`, "POST", { approve: true }, "admin")).status).toBe(409);
            previous = result.data.revisionId;
        }
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM shop_revisions").get()?.n).toBe(1);
        assertAllocation();
    });
    it("retains approved and rejected shop snapshots", async () => {
        const { shop } = await setup(true);
        const rejected = (await api("merchant/shop", "PUT", { ...profile, name: "Rejected profile" })).data;
        expect((await api(`admin/shops/${rejected.revisionId}/review`, "POST", { approve: false, reason: "Incorrect details" }, "admin")).status).toBe(200);
        const saved = await api("merchant/shop", "PUT", { ...profile, name: "New profile" });
        expect(saved.status).toBe(200);
        expect(fixture.database.prepare("SELECT status, content_json FROM shop_revisions WHERE id = ?").get(shop.revisionId)).toMatchObject({ status: "approved", content_json: JSON.stringify(profile) });
        expect(fixture.database.prepare("SELECT status, review_reason FROM shop_revisions WHERE id = ?").get(rejected.revisionId)).toMatchObject({ status: "rejected", review_reason: "Incorrect details" });
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM shop_revisions").get()?.n).toBe(3);
        assertAllocation();
    });
    it.each(["withdrawn", "rejected", "published"])("retains submitted %s product content and review references", async (status) => {
        const { product } = await setup();
        fixture.database.prepare("UPDATE product_revisions SET status = ?, review_reason = 'Decision' WHERE id = ?").run(status, product.revisionId);
        fixture.database.prepare("INSERT INTO publication_requests (revision_id, region, status) VALUES (?, 'cn', 'rejected')").run(product.revisionId);
        const saved = await api(`merchant/products/${product.id}`, "PUT", { ...content, title: "New content" });
        expect(saved.status).toBe(200);
        expect(fixture.database.prepare("SELECT content_json, status FROM product_revisions WHERE id = ?").get(product.revisionId)).toMatchObject({ status, content_json: JSON.stringify(content) });
        expect(fixture.database.prepare("SELECT revision_id FROM publication_requests").get()?.revision_id).toBe(product.revisionId);
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM product_revisions").get()?.n).toBe(2);
        assertAllocation();
    });
    it.each(["request", "inactive publication", "public media", "current"])("does not replace a draft with a %s reference", async (reference) => {
        const { shop, product } = await setup();
        if (reference === "request") fixture.database.prepare("INSERT INTO publication_requests (revision_id, region) VALUES (?, 'cn')").run(product.revisionId);
        if (reference === "inactive publication") fixture.database.prepare("INSERT INTO publications (product_id, region, revision_id, media_token, active, category, pricing, updated_at) VALUES (?, 'cn', ?, 'old', 0, 'avatars', 'free', ?)").run(product.id, product.revisionId, new Date().toISOString());
        if (reference === "current") fixture.database.prepare("UPDATE products SET current_revision_id = ? WHERE id = ?").run(product.revisionId, product.id);
        if (reference === "public media") {
            const mediaId = crypto.randomUUID();
            fixture.database.prepare("INSERT INTO media (id, shop_id, product_id, private_key, content_type, size, width, height, created_at) VALUES (?, ?, ?, ?, 'image/png', 33, 1, 1, ?)").run(mediaId, shop.id, product.id, mediaId, new Date().toISOString());
            fixture.database.prepare("INSERT INTO public_media (product_id, region, revision_id, media_id, media_token, object_key) VALUES (?, 'cn', ?, ?, 'old', ?)").run(product.id, product.revisionId, mediaId, mediaId);
        }
        expect((await api(`merchant/products/${product.id}`, "PUT", { ...content, title: "Changed" })).status).toBe(200);
        expect(fixture.database.prepare("SELECT content_json FROM product_revisions WHERE id = ?").get(product.revisionId)?.content_json).toBe(JSON.stringify(content));
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM product_revisions").get()?.n).toBe(2);
        assertAllocation();
    });
    it("does not erase a shop revision approved after the save snapshot", async () => {
        const { shop } = await setup();
        const assertFired = beforeBatch(async () => {
            expect((await api(`admin/shops/${shop.revisionId}/review`, "POST", { approve: true }, "admin")).status).toBe(200);
        });
        const result = await api("merchant/shop", "PUT", { ...profile, name: "New profile" });
        assertFired();
        expect(result.status).toBe(409);
        expect(fixture.database.prepare("SELECT status, content_json FROM shop_revisions WHERE id = ?").get(shop.revisionId)).toMatchObject({ status: "approved", content_json: JSON.stringify(profile) });
        expect(fixture.database.prepare("SELECT current_revision_id FROM shops WHERE id = ?").get(shop.id)?.current_revision_id).toBe(shop.revisionId);
        assertAllocation();
    });
    it("rejects a cached shop review after its pending content was replaced", async () => {
        const { shop } = await setup();
        let savedId = "";
        const assertFired = beforeBatch(async () => {
            const saved = await api("merchant/shop", "PUT", { ...profile, name: "Updated profile" });
            expect(saved.status).toBe(200);
            savedId = saved.data.revisionId;
        });
        expect((await api(`admin/shops/${shop.revisionId}/review`, "POST", { approve: true }, "admin")).status).toBe(409);
        assertFired();
        expect(fixture.database.prepare("SELECT id, status FROM shop_revisions").get()).toMatchObject({ id: savedId, status: "pending" });
        expect(fixture.database.prepare("SELECT current_revision_id FROM shops WHERE id = ?").get(shop.id)?.current_revision_id).toBeNull();
        assertAllocation();
    });
    it("allows only one of two saves based on the same draft snapshot", async () => {
        const { product } = await setup();
        let savedId = "";
        const assertFired = beforeBatch(async () => {
            const saved = await api(`merchant/products/${product.id}`, "PUT", { ...content, title: "Winning draft" });
            expect(saved.status).toBe(200);
            savedId = saved.data.revisionId;
        });
        expect((await api(`merchant/products/${product.id}`, "PUT", { ...content, title: "Stale draft" })).status).toBe(409);
        assertFired();
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM product_revisions").get()?.n).toBe(1);
        expect(fixture.database.prepare("SELECT latest_revision_id FROM products WHERE id = ?").get(product.id)?.latest_revision_id).toBe(savedId);
        assertAllocation();
    });
    it("rejects a stale submission when its never-submitted draft was replaced", async () => {
        const { product } = await setup(true);
        const assertFired = beforeBatch(async () => {
            expect((await api(`merchant/products/${product.id}`, "PUT", { ...content, title: "New draft" })).status).toBe(200);
        });
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["cn"], turnstileToken: "test" })).status).toBe(409);
        assertFired();
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM publication_requests").get()?.n).toBe(0);
        expect(fixture.database.prepare("SELECT status FROM product_revisions").get()?.status).toBe("draft");
        assertAllocation();
    });
    it("does not replace a draft submitted after the save snapshot", async () => {
        const { product } = await setup(true);
        const assertFired = beforeBatch(async () => {
            expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["cn"], turnstileToken: "test" })).status).toBe(200);
        });
        expect((await api(`merchant/products/${product.id}`, "PUT", { ...content, title: "Racing edit" })).status).toBe(409);
        assertFired();
        expect(fixture.database.prepare("SELECT id, status FROM product_revisions").get()).toMatchObject({ id: product.revisionId, status: "pending" });
        assertAllocation();
    });
    it("uses shared per-shop rows for product creation and shop saves, with complete batch rollback", async () => {
        const { shop, product } = await setup(true);
        fixture.database.prepare("UPDATE revision_storage_policy SET shop_row_limit = 2 WHERE id = 1").run();
        expect((await api("merchant/products", "POST", content)).status).toBe(429);
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM products").get()?.n).toBe(1);
        const shopSave = await api("merchant/shop", "PUT", profile);
        expect(shopSave.status).toBe(429);
        expect(shopSave.data.error?.code).toBe("REVISION_STORAGE_QUOTA_EXCEEDED");
        expect(fixture.database.prepare("SELECT current_revision_id FROM shops WHERE id = ?").get(shop.id)?.current_revision_id).toBe(shop.revisionId);
        expect((await api(`merchant/products/${product.id}`, "PUT", content)).status).toBe(200);
        assertAllocation();
    });
    it("applies global row allocation across shops atomically", async () => {
        await setup();
        fixture.database.prepare("UPDATE revision_storage_policy SET global_row_limit = 3 WHERE id = 1").run();
        const results = await Promise.all([api("merchant/enroll", "POST", profile, "outsider"), api("merchant/products", "POST", content)]);
        expect(results.map((result) => result.status).sort()).toEqual([201, 429]);
        expect(totals().row_count).toBe(3);
        assertAllocation();
    });
    it.each(["global", "shop"])("counts UTF-8 bytes and rolls back growth at the %s byte limit", async (scope) => {
        const { shop, product } = await setup();
        const originalTotal = totals();
        const original = fixture.database.prepare("SELECT * FROM product_revisions WHERE id = ?").get(product.revisionId);
        const bytes = Number(originalTotal.content_bytes);
        fixture.database.prepare(`UPDATE revision_storage_policy SET ${scope}_byte_limit = ? WHERE id = 1`).run(bytes);
        // The replacement consumes only its net delta, even with no spare rows or bytes.
        fixture.database.prepare("UPDATE revision_storage_policy SET global_row_limit = 2, shop_row_limit = 2 WHERE id = 1").run();
        const equal = await api(`merchant/products/${product.id}`, "PUT", { ...content, title: "Version B" });
        expect(equal.status).toBe(200);
        expect(totals()).toEqual(originalTotal);
        const beforeFailure = fixture.database.prepare("SELECT * FROM product_revisions WHERE id = ?").get(equal.data.revisionId);
        const failed = await api(`merchant/products/${product.id}`, "PUT", { ...content, title: "版本版本版本" });
        expect(failed.status).toBe(429);
        expect(failed.data.error?.code).toBe("REVISION_STORAGE_QUOTA_EXCEEDED");
        expect(fixture.database.prepare("SELECT latest_revision_id FROM products WHERE id = ?").get(product.id)?.latest_revision_id).toBe(equal.data.revisionId);
        expect(fixture.database.prepare("SELECT content_json FROM product_revisions WHERE id = ?").get(equal.data.revisionId)?.content_json).toBe(JSON.stringify({ ...content, title: "Version B" }));
        expect(fixture.database.prepare("SELECT * FROM product_revisions WHERE id = ?").get(equal.data.revisionId)).toEqual(beforeFailure);
        expect(fixture.database.prepare("SELECT id FROM product_revisions WHERE id = ?").get(product.revisionId)).toBeUndefined();
        expect(original?.content_json).toBe(JSON.stringify(content));
        expect(fixture.database.prepare("SELECT shop_id FROM revision_storage_shops WHERE shop_id = ?").get(shop.id)?.shop_id).toBe(shop.id);
        assertAllocation();
    });
    it("supports shop pending replacement at a full shared row and byte boundary", async () => {
        const { shop } = await setup();
        fixture.database.prepare("UPDATE revision_storage_policy SET global_row_limit = 2, shop_row_limit = 2, global_byte_limit = ?, shop_byte_limit = ? WHERE id = 1").run(totals().content_bytes, totals().content_bytes);
        const saved = await api("merchant/shop", "PUT", { ...profile, name: "Studio" });
        expect(saved.status).toBe(200);
        const before = totals();
        expect((await api("merchant/shop", "PUT", { ...profile, name: "Longer studio" })).status).toBe(429);
        expect(fixture.database.prepare("SELECT id FROM shop_revisions").get()?.id).toBe(saved.data.revisionId);
        expect(saved.data.revisionId).not.toBe(shop.revisionId);
        expect(totals()).toEqual(before);
        assertAllocation();
    });
    it("releases exact content allocation on delete and accounts direct cross-shop updates", async () => {
        const { product } = await setup();
        const second = (await api("merchant/enroll", "POST", profile, "outsider")).data;
        const secondProduct = (await api("merchant/products", "POST", content, "outsider")).data;
        fixture.database.prepare("UPDATE product_revisions SET product_id = ?, content_json = ? WHERE id = ?").run(secondProduct.id, JSON.stringify({ ...content, title: "中文标题" }), product.revisionId);
        assertAllocation();
        const before = Number(totals().content_bytes);
        const bytes = Buffer.byteLength(JSON.stringify({ ...content, title: "中文标题" }));
        fixture.database.prepare("DELETE FROM product_revisions WHERE id = ?").run(product.revisionId);
        expect(totals().content_bytes).toBe(before - bytes);
        expect(fixture.database.prepare("SELECT row_count FROM revision_storage_shops WHERE shop_id = ?").get(second.id)?.row_count).toBe(2);
        assertAllocation();
        fixture.database.prepare("UPDATE products SET shop_id = (SELECT id FROM shops WHERE owner_user_id = 'merchant-one') WHERE id = ?").run(secondProduct.id);
        assertAllocation();
        const shopContentBytes = Buffer.byteLength(JSON.stringify(profile));
        const beforeShopDeletion = Number(totals().content_bytes);
        fixture.database.prepare("DELETE FROM shop_revisions WHERE id = ?").run(second.revisionId);
        expect(totals().content_bytes).toBe(beforeShopDeletion - shopContentBytes);
        expect(fixture.database.prepare("SELECT row_count FROM revision_storage_shops WHERE shop_id = ?").get(second.id)?.row_count).toBe(0);
        assertAllocation();
    });
    it("initializes empty allocation ledgers and accounts UTF-8 content from the first insert", () => {
        const database = new DatabaseSync(":memory:");
        try {
            database.exec(readFileSync("migrations/0001_initial.sql", "utf8"));
            expect(database.prepare("SELECT row_count, content_bytes FROM revision_storage_total").get()).toEqual({ row_count: 0, content_bytes: 0 });
            expect(database.prepare("SELECT * FROM revision_storage_shops").all()).toEqual([]);
            database.prepare("INSERT INTO shops (id, owner_user_id, created_at) VALUES ('shop', 'owner', 'now')").run();
            expect(database.prepare("SELECT row_count, content_bytes FROM revision_storage_shops WHERE shop_id = 'shop'").get()).toEqual({ row_count: 0, content_bytes: 0 });
            database.prepare("INSERT INTO shop_revisions (id, shop_id, content_json, status, created_at) VALUES ('shop-revision', 'shop', ?, 'approved', 'now')").run('{"name":"中文"}');
            database.prepare("INSERT INTO products (id, shop_id, latest_revision_id, created_at, updated_at) VALUES ('product', 'shop', 'revision', 'now', 'now')").run();
            database.prepare("INSERT INTO product_revisions (id, product_id, content_json, status, created_at, updated_at) VALUES ('revision', 'product', ?, 'published', 'now', 'now')").run('{"name":"é"}');
            const expected = Buffer.byteLength('{"name":"中文"}') + Buffer.byteLength('{"name":"é"}');
            expect(database.prepare("SELECT row_count, content_bytes FROM revision_storage_total").get()).toEqual({ row_count: 2, content_bytes: expected });
            expect(database.prepare("SELECT row_count, content_bytes FROM revision_storage_shops WHERE shop_id = 'shop'").get()).toEqual({ row_count: 2, content_bytes: expected });
            expect(database.prepare("SELECT global_row_limit, global_byte_limit, shop_row_limit, shop_byte_limit FROM revision_storage_policy").get()).toMatchObject({ global_row_limit: 100000, global_byte_limit: 1073741824, shop_row_limit: 2000, shop_byte_limit: 33554432 });
            expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally { database.close(); }
    });
});
