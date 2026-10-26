import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../server/api";
import { getProduct } from "../server/catalog";
import { releaseMediaStorage, reserveMediaStorage } from "../server/media";
import type { ProductInput } from "../shared/contracts";
import { edgeRequest, testEnvironment } from "./helpers";

const content: ProductInput = { title: "Version A", language: "en", summary: "An original product", description: "Original creator content", category: "avatars", tags: [], compatibleModels: [], platforms: ["pc"], pricing: "paid", price: 5, currency: "USD", purchaseUrl: "https://maker.example.com/product", mediaIds: [], r18: false };
const execution = { waitUntil(promise: Promise<unknown>) { void promise; } };

describe("publication races with real SQLite and reentrant R2", () => {
    let fixture: ReturnType<typeof testEnvironment>;
    beforeEach(() => {
        fixture = testEnvironment();
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, hostname: "store.vrclearn.com", action: "submit" })));
    });
    afterEach(() => { fixture.database.close(); vi.unstubAllGlobals(); });
    async function api(path: string, method = "GET", body?: unknown, user = "merchant") {
        const result = await handleApi(edgeRequest(`/api/v1/${path}`, { method, body, user }), fixture.env, execution);
        return { status: result.status, data: await result.json() };
    }
    async function setup() {
        const enrolled = await api("merchant/enroll", "POST", { name: "Studio", description: "Original creations", websiteUrl: "https://maker.example.com" });
        const shop = enrolled.data as { id: string; revisionId: string };
        await api(`admin/shops/${shop.revisionId}/review`, "POST", { approve: true }, "admin");
        for (const region of ["cn", "intl"]) {
            const permission = (await api("merchant/permissions", "POST", { region, reason: "Publish original works" })).data as { id: string };
            await api(`admin/permissions/${permission.id}/review`, "POST", { approve: true }, "admin");
        }
        const product = (await api("merchant/products", "POST", content)).data as { id: string; revisionId: string };
        const imageId = crypto.randomUUID();
        const key = `${shop.id}/${product.id}/${imageId}`;
        fixture.privateMedia.set(key, new Uint8Array(33));
        fixture.database.prepare("INSERT INTO media (id, shop_id, product_id, private_key, content_type, size, width, height, created_at) VALUES (?, ?, ?, ?, 'image/png', 33, 1, 1, ?)").run(imageId, shop.id, product.id, key, new Date().toISOString());
        const withImage = { ...content, mediaIds: [imageId] };
        fixture.database.prepare("UPDATE product_revisions SET content_json = ? WHERE id = ?").run(JSON.stringify(withImage), product.revisionId);
        return { shop, product, withImage };
    }
    async function submit(productId: string, regions = ["cn"]) {
        expect((await api(`merchant/products/${productId}/submit`, "POST", { regions, turnstileToken: "test-proof" })).status).toBe(200);
    }
    async function approve(revisionId: string, region = "cn") {
        const result = await api(`admin/revisions/${revisionId}/review`, "POST", { region, approve: true }, "admin");
        expect(result.status).toBe(200);
        return result;
    }
    it("a concurrent unpublish invalidates finalization before any catalog activation", async () => {
        const { product } = await setup();
        await submit(product.id);
        const originalPut = fixture.env.PUBLIC_MEDIA.put.bind(fixture.env.PUBLIC_MEDIA);
        let interrupted = false;
        fixture.env.PUBLIC_MEDIA.put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
            const result = await originalPut(...args);
            if (!interrupted) {
                interrupted = true;
                expect((await api(`merchant/products/${product.id}/unpublish`, "POST", { region: "cn" })).status).toBe(200);
            }
            return result;
        });
        const result = await approve(product.revisionId);
        expect(result.data).toMatchObject({ published: false });
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM publications WHERE product_id = ? AND active = 1").get(product.id)?.n).toBe(0);
        expect(fixture.publicMedia.size).toBe(0);
        expect(fixture.database.prepare("SELECT status, submission_token FROM product_revisions WHERE id = ?").get(product.revisionId)).toMatchObject({ status: "withdrawn", submission_token: null });
    });
    it("a stale submission cannot overwrite or erase a re-submitted region generation", async () => {
        const { product } = await setup();
        await submit(product.id, ["cn"]);
        const oldToken = fixture.database.prepare("SELECT submission_token FROM product_revisions WHERE id = ?").get(product.revisionId)?.submission_token;
        const originalPut = fixture.env.PUBLIC_MEDIA.put.bind(fixture.env.PUBLIC_MEDIA);
        let interrupted = false;
        fixture.env.PUBLIC_MEDIA.put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
            const result = await originalPut(...args);
            if (!interrupted) {
                interrupted = true;
                expect((await api(`merchant/products/${product.id}/withdraw`, "POST")).status).toBe(200);
                await submit(product.id, ["intl"]);
                await approve(product.revisionId, "intl");
            }
            return result;
        });
        const result = await approve(product.revisionId, "cn");
        expect(result.data).toMatchObject({ published: false });
        const publications = fixture.database.prepare("SELECT region, media_token FROM publications WHERE product_id = ? AND active = 1").all(product.id);
        expect(publications).toHaveLength(1);
        expect(publications[0].region).toBe("intl");
        expect(publications[0].media_token).not.toBe(oldToken);
        expect([...fixture.publicMedia.keys()]).toHaveLength(1);
        expect([...fixture.publicMedia.keys()][0]).toContain(`/${publications[0].media_token}/`);
        expect([...fixture.publicMedia.keys()][0]).toMatch(/^intl\//);
        await expect(getProduct(edgeRequest("/", { country: "CN" }), fixture.env, product.id)).rejects.toMatchObject({ status: 404 });
    });
    it("old-version cleanup retains another revision published during R2 deletion", async () => {
        const { product, withImage } = await setup();
        await submit(product.id);
        await approve(product.revisionId);
        const revised = (await api(`merchant/products/${product.id}`, "PUT", { ...withImage, title: "Version B" })).data as { revisionId: string };
        await submit(product.id);
        const originalDelete = fixture.env.PUBLIC_MEDIA.delete.bind(fixture.env.PUBLIC_MEDIA);
        let interrupted = false;
        let thirdRevision = "";
        fixture.env.PUBLIC_MEDIA.delete = vi.fn(async (keys: string | string[]) => {
            if (!interrupted) {
                interrupted = true;
                const third = (await api(`merchant/products/${product.id}`, "PUT", { ...withImage, title: "Version C" })).data as { revisionId: string };
                thirdRevision = third.revisionId;
                await submit(product.id);
                await approve(third.revisionId);
            }
            return originalDelete(keys);
        });
        await approve(revised.revisionId);
        const current = await getProduct(edgeRequest("/"), fixture.env, product.id);
        expect(current.title).toBe("Version C");
        expect([...fixture.publicMedia.keys()]).toHaveLength(1);
        expect([...fixture.publicMedia.keys()][0]).toContain(`/${thirdRevision}/`);
        const keys = fixture.database.prepare("SELECT object_key FROM public_media").all().map((row) => row.object_key);
        expect(keys).toEqual([...fixture.publicMedia.keys()]);
    });
    it("reserves combined storage atomically and releases only recorded object bytes", async () => {
        fixture.database.prepare("UPDATE media_storage_total SET bytes = ? WHERE id = 1").run(8589934592 - 100);
        await expect(reserveMediaStorage(fixture.env, "private", "too-large", 101)).rejects.toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED" });
        await reserveMediaStorage(fixture.env, "private", "fits", 100);
        expect(fixture.database.prepare("SELECT bytes FROM media_storage_total WHERE id = 1").get()?.bytes).toBe(8589934592);
        await reserveMediaStorage(fixture.env, "private", "fits", 100);
        expect(fixture.database.prepare("SELECT bytes FROM media_storage_total WHERE id = 1").get()?.bytes).toBe(8589934592);
        await expect(reserveMediaStorage(fixture.env, "public", "over-limit", 1)).rejects.toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED" });
        await releaseMediaStorage(fixture.env, "private", "fits");
        await releaseMediaStorage(fixture.env, "private", "fits");
        expect(fixture.database.prepare("SELECT bytes FROM media_storage_total WHERE id = 1").get()?.bytes).toBe(8589934592 - 100);
    });
    it("can retry a fully approved publication after storage quota recovery", async () => {
        const { product } = await setup();
        await submit(product.id);
        fixture.database.prepare("UPDATE media_storage_total SET bytes = ? WHERE id = 1").run(8589934592 - 1);
        const limited = await api(`admin/revisions/${product.revisionId}/review`, "POST", { region: "cn", approve: true }, "admin");
        expect(limited.status).toBe(429);
        expect(fixture.publicMedia.size).toBe(0);
        expect(fixture.database.prepare("SELECT status FROM product_revisions WHERE id = ?").get(product.revisionId)?.status).toBe("pending");
        expect(fixture.database.prepare("SELECT status FROM publication_requests WHERE revision_id = ?").get(product.revisionId)?.status).toBe("approved");
        fixture.database.prepare("UPDATE media_storage_total SET bytes = 0 WHERE id = 1").run();
        const retried = await approve(product.revisionId);
        expect(retried.data).toMatchObject({ published: true });
        expect(fixture.publicMedia.size).toBe(1);
    });
    it("the 200-product allowance remains enforced when the preflight count is stale", async () => {
        const { shop } = await setup();
        const statement = fixture.database.prepare("INSERT INTO products (id, shop_id, latest_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
        const timestamp = new Date().toISOString();
        for (let index = 0; index < 198; index++) statement.run(crypto.randomUUID(), shop.id, crypto.randomUUID(), timestamp, timestamp);
        const prepare = fixture.env.DB.prepare.bind(fixture.env.DB);
        let interrupted = false;
        fixture.env.DB.prepare = (sql: string) => {
            const statement = prepare(sql);
            if (sql === "SELECT COUNT(*) AS count FROM products WHERE shop_id = ?") {
                const bind = statement.bind.bind(statement);
                statement.bind = (...values: unknown[]) => {
                    const bound = bind(...values);
                    const first = bound.first;
                    bound.first = async <T>(column?: string): Promise<T | null> => {
                        const result = column === undefined ? await first<T>() : await first<T>(column);
                        if (!interrupted) {
                            interrupted = true;
                            expect((await api("merchant/products", "POST", content)).status).toBe(201);
                        }
                        return result;
                    };
                    return bound;
                };
            }
            return statement;
        };
        expect((await api("merchant/products", "POST", content)).status).toBe(409);
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM products WHERE shop_id = ?").get(shop.id)?.n).toBe(200);
    });
    it("an image retired after ownership preflight cannot be newly referenced by a draft", async () => {
        const { product, withImage } = await setup();
        fixture.database.prepare("UPDATE product_revisions SET content_json = ? WHERE id = ?").run(JSON.stringify(content), product.revisionId);
        const prepare = fixture.env.DB.prepare.bind(fixture.env.DB);
        let interrupted = false;
        fixture.env.DB.prepare = (sql: string) => {
            const statement = prepare(sql);
            if (sql.startsWith("SELECT * FROM media WHERE product_id = ?")) {
                const bind = statement.bind.bind(statement);
                statement.bind = (...values: unknown[]) => {
                    const bound = bind(...values);
                    const all = bound.all;
                    bound.all = async <T>() => {
                        const result = await all<T>();
                        if (!interrupted) {
                            interrupted = true;
                            fixture.database.prepare("UPDATE media SET retiring = 1 WHERE id = ?").run(withImage.mediaIds[0]);
                        }
                        return result;
                    };
                    return bound;
                };
            }
            return statement;
        };
        const changed = await api(`merchant/products/${product.id}`, "PUT", withImage);
        expect(changed.status).toBe(409);
        expect(fixture.database.prepare("SELECT latest_revision_id FROM products WHERE id = ?").get(product.id)?.latest_revision_id).toBe(product.revisionId);
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM product_revisions WHERE product_id = ?").get(product.id)?.n).toBe(1);
    });
});
