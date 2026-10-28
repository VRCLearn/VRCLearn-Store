import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "../server/api";
import { edgeRequest, testEnvironment } from "./helpers";

describe("regional home recommendations", () => {
    let f: ReturnType<typeof testEnvironment>;
    const shopId = crypto.randomUUID();
    const productIds = Array.from({ length: 8 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    beforeEach(() => {
        f = testEnvironment();
        const time = new Date().toISOString();
        const shopRevision = crypto.randomUUID();
        f.database.prepare("INSERT INTO shops(id,owner_user_id,current_revision_id,created_at) VALUES(?,?,?,?)").run(shopId, "maker", shopRevision, time);
        f.database.prepare("INSERT INTO shop_revisions(id,shop_id,content_json,status,created_at) VALUES(?,?,?,'approved',?)").run(shopRevision, shopId, JSON.stringify({ name: "Featured shop", description: "Original creations", websiteUrl: "https://maker.example.com" }), time);
        for (const region of ["cn", "intl"]) f.database.prepare("INSERT INTO regional_permissions(id,shop_id,region,status,reason,updated_at) VALUES(?,?,?,'approved','Original works',?)").run(crypto.randomUUID(), shopId, region, time);
        for (const [index, id] of productIds.entries()) {
            const publishedAt = new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString();
            const revision = crypto.randomUUID();
            const content = { title: id, language: "en", summary: "Original avatar", description: [1, 2, 5].includes(index) ? "x".repeat(300) : "Creator content", category: "avatars", tags: [], compatibleModels: [1, 3, 5].includes(index) ? ["Original avatar"] : [], platforms: ["pc"], pricing: "free", price: null, currency: null, purchaseUrl: "https://maker.example.com/product", mediaIds: [1, 4, 5].includes(index) ? [crypto.randomUUID()] : [], r18: false };
            f.database.prepare("INSERT INTO products(id,shop_id,current_revision_id,latest_revision_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, shopId, revision, revision, time, time);
            f.database.prepare("INSERT INTO product_revisions(id,product_id,content_json,status,created_at,updated_at) VALUES(?,?,?,'published',?,?)").run(revision, id, JSON.stringify(content), time, time);
            for (const region of ["cn", "intl"]) {
                f.database.prepare("INSERT INTO publication_requests(revision_id,region,status) VALUES(?,?,'approved')").run(revision, region);
                f.database.prepare("INSERT INTO publications(product_id,region,revision_id,media_token,active,updated_at,category,pricing,currency,price) VALUES(?,?,?,'test-featured',1,?,'avatars','free',NULL,NULL)").run(id, region, revision, publishedAt);
            }
        }
    });
    afterEach(() => f.database.close());
    async function api(path: string, options: Parameters<typeof edgeRequest>[1] = {}) {
        const response = await handleApi(edgeRequest(`/api/v1/${path}`, options), f.env, { waitUntil() {} });
        return { status: response.status, body: await response.json() as { items: { id: string }[] } };
    }
    it("automatically ranks presentation completeness ahead of recency and limits results to six", async () => {
        const result = await api("recommendations");
        expect(result.status).toBe(200);
        expect(result.body.items.map((item) => item.id)).toEqual([5, 1, 4, 2, 3, 7].map((index) => productIds[index]));
        expect(f.database.prepare("SELECT COUNT(*) AS n FROM audit_log").get()?.n).toBe(0);
        expect(f.database.prepare("SELECT name FROM sqlite_master WHERE name='home_recommendations'").all()).toEqual([]);
        expect(f.queries.some((query) => /favorites|^\s*(INSERT|UPDATE|DELETE)\b/i.test(query.sql))).toBe(false);
    });
    it("breaks equal quality and timestamp ties by product ID consistently", async () => {
        f.database.exec("UPDATE publications SET updated_at='2026-10-01T00:00:00.000Z'");
        expect((await api("recommendations")).body.items.map((item) => item.id)).toEqual([5, 1, 4, 2, 3, 7].map((index) => productIds[index]));
    });
    it("scores only the latest 96 active regional candidates through the catalog index", async () => {
        const recentIds: string[] = [];
        for (let index = 0; index < 96; index++) {
            const id = `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
            const revision = crypto.randomUUID();
            recentIds.push(id);
            f.database.prepare("INSERT INTO products(id,shop_id,current_revision_id,latest_revision_id,created_at,updated_at) SELECT ?,shop_id,?,?,created_at,updated_at FROM products WHERE id=?").run(id, revision, revision, productIds[0]);
            f.database.prepare("INSERT INTO product_revisions(id,product_id,content_json,status,created_at,updated_at) SELECT ?,?,content_json,status,created_at,updated_at FROM product_revisions WHERE product_id=?").run(revision, id, productIds[0]);
            f.database.prepare("INSERT INTO publication_requests(revision_id,region,status) VALUES(?,'cn','approved')").run(revision);
            f.database.prepare("INSERT INTO publications(product_id,region,revision_id,media_token,active,updated_at,category,pricing,currency,price) SELECT ?,region,?,media_token,active,'2026-10-02T00:00:00.000Z',category,pricing,currency,price FROM publications WHERE product_id=? AND region='cn'").run(id, revision, productIds[0]);
        }
        const result = await api("recommendations");
        // Older complete listings do not expand the bounded candidate scan.
        expect(result.body.items.map((item) => item.id)).toEqual(recentIds.slice(-6).reverse());
        const query = f.queries.at(-1)!;
        const plan = f.database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.values).map((row) => String(row.detail));
        expect(plan.some((step) => step.includes("MATERIALIZE recent"))).toBe(true);
        expect(plan.some((step) => /SEARCH publications USING INDEX publications_catalog/.test(step))).toBe(true);
        expect(plan.some((step) => /USE TEMP B-TREE FOR ORDER BY/.test(step))).toBe(true);
        // Filtering after candidate selection must not refill from older rows.
        f.database.prepare("UPDATE publication_requests SET status='pending' WHERE revision_id IN (SELECT revision_id FROM publications WHERE product_id LIKE '10000000-%')").run();
        expect((await api("recommendations")).body.items).toEqual([]);
    });
    it("keeps region visibility and public media prefixes separate", async () => {
        f.database.exec("UPDATE publications SET active=0 WHERE region='cn'");
        expect((await api("recommendations")).body.items).toEqual([]);
        const result = await api("recommendations", { country: "JP" });
        expect(result.body.items).toHaveLength(6);
        expect(JSON.stringify(result.body.items)).toContain("/intl/");
        expect(JSON.stringify(result.body.items)).not.toContain("/cn/");
    });
    it("allows approved Adult recommendations only in the international region", async () => {
        f.database.exec("UPDATE product_revisions SET content_json=json_set(content_json,'$.r18',json('true'))");
        expect((await api("recommendations", { country: "CN" })).body.items).toEqual([]);
        const international = await api("recommendations", { country: "JP" });
        expect(international.status).toBe(200);
        expect(international.body.items).toHaveLength(6);
        expect(international.body.items.every((item) => "r18" in item && item.r18 === true)).toBe(true);
        expect(JSON.stringify(international.body.items)).not.toContain("/cn/");
    });
    it.each([
        "UPDATE publications SET active=0 WHERE region='cn'",
        "UPDATE publication_requests SET status='pending' WHERE region='cn'",
        "UPDATE regional_permissions SET status='revoked' WHERE region='cn'",
        "INSERT INTO user_profiles(user_id,role,banned) VALUES('maker','user',1)",
        "UPDATE product_revisions SET content_json=json_set(content_json,'$.r18',json('true'))",
    ])("filters recommendations when visibility changes: %s", async (sql) => {
        f.database.exec(sql);
        expect((await api("recommendations")).body.items).toEqual([]);
    });
    it("rejects client region overrides and unknown countries", async () => {
        expect((await api("recommendations?region=intl")).status).toBe(400);
        expect((await api("recommendations", { country: "XX" })).status).toBe(403);
    });
});
