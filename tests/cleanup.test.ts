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
    it("preserves the images of a partially published pending snapshot while removing unrelated expired uploads", async () => {
        const fixture = testEnvironment();
        const db = fixture.database;
        try {
            db.exec(readFileSync("migrations/0002_auth.sql", "utf8"));
            const old = "2026-08-01T00:00:00.000Z";
            const shop = crypto.randomUUID();
            const product = crypto.randomUUID();
            const revision = crypto.randomUUID();
            const keep = crypto.randomUUID();
            const orphan = crypto.randomUUID();
            const publicKey = `cn/${product}/${revision}/approved-cn/${keep}`;
            db.prepare("INSERT INTO shops(id,owner_user_id,created_at) VALUES(?,?,?)").run(shop, "maker", old);
            db.prepare("INSERT INTO products(id,shop_id,current_revision_id,latest_revision_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(product, shop, revision, revision, old, old);
            db.prepare("INSERT INTO product_revisions(id,product_id,content_json,status,submission_token,created_at,updated_at) VALUES(?,?,?,'pending','pending-intl',?,?)").run(revision, product, JSON.stringify({ mediaIds: [keep] }), old, old);
            db.prepare("INSERT INTO publication_requests(revision_id,region,status) VALUES(?,'cn','approved'),(?,'intl','pending')").run(revision, revision);
            db.prepare("INSERT INTO publications(product_id,region,revision_id,media_token,active,updated_at,category,pricing) VALUES(?,'cn',?,'approved-cn',1,?,'avatars','free')").run(product, revision, old);
            const insertMedia = db.prepare("INSERT INTO media(id,shop_id,product_id,private_key,content_type,size,width,height,created_at) VALUES(?,?,?,?,'image/png',4,1,1,?)");
            insertMedia.run(keep, shop, product, keep, old);
            insertMedia.run(orphan, shop, product, orphan, old);
            db.prepare("INSERT INTO public_media(product_id,region,revision_id,media_id,media_token,object_key) VALUES(?,'cn',?,?,'approved-cn',?)").run(product, revision, keep, publicKey);
            fixture.privateMedia.set(keep, new Uint8Array([1, 2, 3, 4]));
            fixture.privateMedia.set(orphan, new Uint8Array([1, 2, 3, 4]));
            fixture.publicMedia.set(publicKey, new Uint8Array([1, 2, 3, 4]));

            const result = await cleanupStaleMedia(fixture.env, Date.parse("2026-10-27T00:00:00Z"));
            expect(result).toMatchObject({ privateDeleted: 1, publicDeleted: 0 });
            expect(fixture.privateMedia.has(keep)).toBe(true);
            expect(fixture.privateMedia.has(orphan)).toBe(false);
            expect(fixture.publicMedia.has(publicKey)).toBe(true);
            expect(db.prepare("SELECT status FROM product_revisions WHERE id = ?").get(revision)?.status).toBe("pending");
            expect(db.prepare("SELECT region, status FROM publication_requests WHERE revision_id = ? ORDER BY region").all(revision)).toEqual([
                { region: "cn", status: "approved" }, { region: "intl", status: "pending" },
            ]);
        } finally { db.close(); }
    });
});
