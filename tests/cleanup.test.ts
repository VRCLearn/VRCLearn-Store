import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanupStaleMedia } from "../edge/cleanup";
import { testEnvironment } from "./helpers";

describe("bounded object cleanup", () => {
    it("removes unattached expired uploads while preserving a published product image", async () => {
        const fixture = testEnvironment();
        const db = fixture.database;
        try {
            db.exec(readFileSync("migrations/0002_auth.sql", "utf8"));
            const old = "2026-08-01T00:00:00.000Z";
            const shop = crypto.randomUUID();
            const product = crypto.randomUUID();
            const revision = crypto.randomUUID();
            const keep = crypto.randomUUID();
            const remove = crypto.randomUUID();
            db.prepare("INSERT INTO shops(id,owner_user_id,created_at) VALUES(?,?,?)").run(shop, "maker", old);
            db.prepare("INSERT INTO products(id,shop_id,current_revision_id,latest_revision_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(product, shop, revision, revision, old, old);
            db.prepare("INSERT INTO product_revisions(id,product_id,content_json,status,created_at,updated_at) VALUES(?,?,?,'published',?,?)").run(revision, product, JSON.stringify({ mediaIds: [keep] }), old, old);
            const media = db.prepare("INSERT INTO media(id,shop_id,product_id,private_key,content_type,size,width,height,created_at) VALUES(?,?,?,?,'image/png',4,1,1,?)");
            media.run(keep, shop, product, keep, old);
            media.run(remove, shop, product, remove, old);
            fixture.privateMedia.set(keep, new Uint8Array([1, 2, 3, 4]));
            fixture.privateMedia.set(remove, new Uint8Array([1, 2, 3, 4]));
            const result = await cleanupStaleMedia(fixture.env, Date.parse("2026-10-26T00:00:00Z"));
            expect(result.privateDeleted).toBe(1);
            expect(fixture.privateMedia.has(keep)).toBe(true);
            expect(fixture.privateMedia.has(remove)).toBe(false);
            expect(db.prepare("SELECT count(*) AS count FROM media").get()?.count).toBe(1);
        } finally { db.close(); }
    });
});
