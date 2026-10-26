import { describe, expect, it } from "vitest";
import { listProducts } from "../server/catalog";
import { searchTokens } from "../server/validation";
import { edgeRequest, testEnvironment } from "./helpers";
import type { ProductInput } from "../shared/contracts";

describe("10,000-product indexed catalog", () => {
    it("uses publication indexes, indexed FTS, and stable keyset pages", async () => {
        const fixture = testEnvironment();
        const db = fixture.database;
        try {
            const time = "2026-10-26T00:00:00.000Z";
            const shopInsert = db.prepare("INSERT INTO shops(id, owner_user_id, current_revision_id, created_at) VALUES(?,?,?,?)");
            const shopRevision = db.prepare("INSERT INTO shop_revisions(id,shop_id,content_json,status,created_at) VALUES(?,?,?,'approved',?)");
            const permission = db.prepare("INSERT INTO regional_permissions(id,shop_id,region,status,reason,updated_at) VALUES(?,?,'cn','approved','Capacity fixture',?)");
            const productInsert = db.prepare("INSERT INTO products(id,shop_id,current_revision_id,latest_revision_id,created_at,updated_at) VALUES(?,?,?,?,?,?)");
            const revisionInsert = db.prepare("INSERT INTO product_revisions(id,product_id,content_json,status,created_at,updated_at) VALUES(?,?,?,'published',?,?)");
            const publication = db.prepare("INSERT INTO publications(product_id,region,revision_id,media_token,active,updated_at,category,pricing,currency,price) VALUES(?,'cn',?,'capacity-fixture',1,?,'avatars','paid','USD',?)");
            const search = db.prepare("INSERT INTO product_search(product_id,tokens) VALUES(?,?)");
            db.exec("BEGIN");
            for (let maker = 0; maker < 100; maker++) {
                const shopId = crypto.randomUUID();
                const shopRevisionId = crypto.randomUUID();
                shopInsert.run(shopId, `maker-${maker}`, shopRevisionId, time);
                shopRevision.run(shopRevisionId, shopId, JSON.stringify({ name: `Studio ${maker}`, description: "An independent maker", websiteUrl: "https://maker.example.com" }), time);
                permission.run(crypto.randomUUID(), shopId, time);
                for (let item = 0; item < 100; item++) {
                    const id = crypto.randomUUID();
                    const revision = crypto.randomUUID();
                    const content: ProductInput = { title: `星空 Avatar ${maker}-${item}`, language: "zh-CN", summary: "A VRChat avatar", description: "Original product", category: "avatars", tags: [], compatibleModels: [], platforms: ["pc"], pricing: "paid", price: item + 1, currency: "USD", purchaseUrl: "https://maker.example.com/product", mediaIds: [], r18: false };
                    productInsert.run(id, shopId, revision, revision, time, time);
                    revisionInsert.run(revision, id, JSON.stringify(content), time, time);
                    publication.run(id, revision, time, item + 1);
                    search.run(id, searchTokens(content.title).join(" "));
                }
            }
            db.exec("COMMIT; ANALYZE");
            const started = performance.now();
            const first = await listProducts(edgeRequest("/api/v1/products?category=avatars"), fixture.env);
            const second = await listProducts(edgeRequest(`/api/v1/products?category=avatars&cursor=${encodeURIComponent(first.nextCursor ?? "")}`), fixture.env);
            expect(first.items).toHaveLength(24);
            expect(second.items).toHaveLength(24);
            expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(48);
            const latestQuery = fixture.queries.at(-1)!;
            const plan = db.prepare(`EXPLAIN QUERY PLAN ${latestQuery.sql}`).all(...latestQuery.values).map((row) => String(row.detail));
            expect(plan.some((step) => /SEARCH p USING INDEX publications_/.test(step))).toBe(true);
            const chinese = await listProducts(edgeRequest("/api/v1/products?q=" + encodeURIComponent("星空")), fixture.env);
            expect(chinese.items).toHaveLength(24);
            const ftsQuery = fixture.queries.at(-1)!;
            const ftsPlan = db.prepare(`EXPLAIN QUERY PLAN ${ftsQuery.sql}`).all(...ftsQuery.values).map((row) => String(row.detail));
            expect(ftsPlan.some((step) => step.includes("VIRTUAL TABLE INDEX"))).toBe(true);
            const price = await listProducts(edgeRequest("/api/v1/products?currency=USD&sort=price_asc"), fixture.env);
            expect(price.items[0].price).toBe(1);
            expect(performance.now() - started).toBeLessThan(3000);
            console.info(JSON.stringify({ fixture: "100 shops / 10000 products", catalogQueryPlan: plan, ftsQueryPlan: ftsPlan, localElapsedMs: Math.round(performance.now() - started), note: "SQLite query-plan evidence; actual D1 billed rows require staging metrics." }));
        } finally { db.close(); }
    });
});
