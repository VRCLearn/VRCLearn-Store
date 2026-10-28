import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../server/api";
import { getProduct, listProducts, sitemap } from "../server/catalog";
import type { ProductInput, Region } from "../shared/contracts";
import type { AppEnv } from "../server/env";
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
    async function create(regions: Region[] = ["cn", "intl"]) {
        const result = await api("merchant/products", "POST", content);
        expect(result.status).toBe(201);
        const product = result.data as { id: string; revisionId: string };
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions, turnstileToken: "test-token" })).status).toBe(200);
        return product;
    }
    async function decide(revisionId: string, region: Region, approve = true) {
        const result = await api(`admin/revisions/${revisionId}/review`, "POST", { region, approve, reason: approve ? "" : "Unsuitable for this region" }, "admin");
        expect(result.status).toBe(200);
        return result;
    }
    async function visible(productId: string, country: string, title?: string) {
        if (title === undefined) await expect(getProduct(edgeRequest("/", { country }), fixture.env, productId)).rejects.toMatchObject({ status: 404 });
        else expect((await getProduct(edgeRequest("/", { country }), fixture.env, productId)).title).toBe(title);
        const products = await listProducts(edgeRequest("/api/v1/products", { country }), fixture.env);
        if (title === undefined) expect(products.items.map((item) => item.id)).not.toContain(productId);
        else expect(products.items).toContainEqual(expect.objectContaining({ id: productId, title }));
    }
    async function queued(revisionId: string) {
        const result = await api("admin/queue", "GET", undefined, "admin");
        expect(result.status).toBe(200);
        const products = (result.data as { products: { id: string; canRetry: boolean; regions: { region: Region; status: string }[] }[] }).products;
        return products.find((item) => item.id === revisionId);
    }
    it.each([{ regions: ["cn"] }, { regions: ["cn", "intl"] }] as { regions: Region[] }[])("rejects adult submissions to $regions before challenges, submission quota or review writes", async ({ regions }) => {
        await enroll();
        const created = await api("merchant/products", "POST", { ...content, r18: true });
        expect(created.status).toBe(201);
        const product = created.data as { id: string; revisionId: string };
        const quotaLimits: string[] = [];
        fixture.env.QUOTA = Object.assign({} as AppEnv["QUOTA"], { getByName: () => ({ fetch: async (_input: unknown, init: RequestInit) => {
            const body = JSON.parse(String(init.body)) as { limits: { key: string }[] };
            quotaLimits.push(...body.limits.map((limit) => limit.key));
            return Response.json({ allowed: true });
        } }) });
        vi.mocked(fetch).mockClear();
        const result = await api(`merchant/products/${product.id}/submit`, "POST", { regions, turnstileToken: "test-token" });
        expect(result).toMatchObject({ status: 400, data: { error: { code: "ADULT_CN_FORBIDDEN" } } });
        expect(fetch).not.toHaveBeenCalled();
        expect(quotaLimits.some((key) => key.startsWith("submit:"))).toBe(false);
        expect(fixture.database.prepare("SELECT status FROM product_revisions WHERE id=?").get(product.revisionId)?.status).toBe("draft");
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM publication_requests WHERE revision_id=?").get(product.revisionId)?.n).toBe(0);
    });
    it("publishes adult products internationally and blocks stale mainland review approval and public reads", async () => {
        await enroll();
        const product = (await api("merchant/products", "POST", { ...content, r18: true })).data as { id: string; revisionId: string };
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["intl"], turnstileToken: "test-token" })).status).toBe(200);
        fixture.database.prepare("INSERT INTO publication_requests(revision_id,region,status) VALUES(?,'cn','pending')").run(product.revisionId);
        expect((await api(`admin/revisions/${product.revisionId}/review`, "POST", { region: "cn", approve: true }, "admin"))).toMatchObject({ status: 400, data: { error: { code: "ADULT_CN_FORBIDDEN" } } });
        await decide(product.revisionId, "cn", false);
        await decide(product.revisionId, "intl");
        expect((await getProduct(edgeRequest("/", { country: "JP" }), fixture.env, product.id)).r18).toBe(true);
        await visible(product.id, "CN");
        // Even a stale or corrupt mainland publication cannot expose Adult content.
        fixture.database.prepare("UPDATE publication_requests SET status='approved' WHERE revision_id=? AND region='cn'").run(product.revisionId);
        fixture.database.prepare("INSERT INTO publications(product_id,region,revision_id,media_token,active,updated_at,category,pricing,currency,price) SELECT product_id,'cn',revision_id,media_token,active,updated_at,category,pricing,currency,price FROM publications WHERE product_id=? AND region='intl'").run(product.id);
        await visible(product.id, "CN");
        expect(await sitemap(edgeRequest("/sitemap.xml", { country: "CN" }), fixture.env)).not.toContain(`${fixture.env.ORIGIN}/en/products/${product.id}`);
    });
    it("requires the mainland listing to be removed before an adult revision can replace a shared product", async () => {
        await enroll();
        const product = await create();
        await decide(product.revisionId, "cn");
        await decide(product.revisionId, "intl");
        const revision = (await api(`merchant/products/${product.id}`, "PUT", { ...content, r18: true })).data as { revisionId: string };
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["intl"], turnstileToken: "test-token" }))).toMatchObject({ status: 409, data: { error: { code: "ALL_REGIONS_REQUIRED" } } });
        expect((await api(`merchant/products/${product.id}/unpublish`, "POST", { region: "cn" })).status).toBe(200);
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["intl"], turnstileToken: "test-token" })).status).toBe(200);
        await decide(revision.revisionId, "intl");
        await visible(product.id, "CN");
        expect((await getProduct(edgeRequest("/", { country: "JP" }), fixture.env, product.id)).r18).toBe(true);
    });
    it("requires regional permission, keeps the old shared version, then switches both regions atomically", async () => {
        await enroll();
        const created = await api("merchant/products", "POST", content);
        expect(created.status).toBe(201);
        const product = created.data as { id: string; revisionId: string };
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["cn", "intl"], turnstileToken: "test-token" })).status).toBe(200);
        expect((await api(`merchant/products/${product.id}`, "PUT", { ...content, title: "Illicit edit" })).status).toBe(409);
        expect((await api(`admin/revisions/${product.revisionId}/review`, "POST", { region: "cn", approve: true, reason: "" }, "admin")).status).toBe(200);
        await visible(product.id, "CN", content.title);
        await visible(product.id, "JP");
        expect(await queued(product.revisionId)).toMatchObject({ canRetry: false, regions: expect.arrayContaining([expect.objectContaining({ region: "intl", status: "pending" })]) });
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
    it.each(["before", "after"])("keeps first-publication CN approval independent of an Intl rejection %s it", async (order) => {
        await enroll();
        const product = await create();
        if (order === "before") await decide(product.revisionId, "intl", false);
        await decide(product.revisionId, "cn");
        if (order === "after") await decide(product.revisionId, "intl", false);
        await visible(product.id, "CN", content.title);
        await visible(product.id, "JP");
        expect(fixture.database.prepare("SELECT region, status FROM publication_requests WHERE revision_id = ? ORDER BY region").all(product.revisionId)).toEqual([
            { region: "cn", status: "approved" }, { region: "intl", status: "rejected" },
        ]);
        expect(fixture.database.prepare("SELECT current_revision_id FROM products WHERE id = ?").get(product.id)?.current_revision_id).toBe(product.revisionId);
    });
    it.each(["pending", "rejected"])("switches the existing CN content while an additional Intl request is %s", async (intlStatus) => {
        await enroll();
        const product = await create(["cn"]);
        await decide(product.revisionId, "cn");
        const revised = (await api(`merchant/products/${product.id}`, "PUT", { ...content, title: "Updated CN content" })).data as { revisionId: string };
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["cn", "intl"], turnstileToken: "test-token" })).status).toBe(200);
        if (intlStatus === "rejected") await decide(revised.revisionId, "intl", false);
        await decide(revised.revisionId, "cn");
        await visible(product.id, "CN", "Updated CN content");
        await visible(product.id, "JP");
        expect(fixture.database.prepare("SELECT current_revision_id FROM products WHERE id = ?").get(product.id)?.current_revision_id).toBe(revised.revisionId);
        if (intlStatus === "pending") {
            expect(await queued(revised.revisionId)).toMatchObject({ canRetry: false });
            await decide(revised.revisionId, "intl");
            await visible(product.id, "JP", "Updated CN content");
        }
    });
    it("does not publish a newly approved region before all existing regions approve a content replacement", async () => {
        await enroll();
        const product = await create(["cn"]);
        await decide(product.revisionId, "cn");
        const revised = (await api(`merchant/products/${product.id}`, "PUT", { ...content, title: "Replacement content" })).data as { revisionId: string };
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["cn", "intl"], turnstileToken: "test-token" })).status).toBe(200);
        await decide(revised.revisionId, "intl");
        await visible(product.id, "CN", content.title);
        await visible(product.id, "JP");
        expect(await queued(revised.revisionId)).toMatchObject({ canRetry: false });
        await decide(revised.revisionId, "cn");
        await visible(product.id, "CN", "Replacement content");
        await visible(product.id, "JP", "Replacement content");
        expect(fixture.database.prepare("SELECT DISTINCT revision_id FROM publications WHERE product_id = ? AND active = 1").all(product.id)).toEqual([{ revision_id: revised.revisionId }]);
    });
    it("retains both previous regional publications when a required existing-region review rejects a replacement", async () => {
        await enroll();
        const product = await create();
        await decide(product.revisionId, "cn");
        await decide(product.revisionId, "intl");
        const revised = (await api(`merchant/products/${product.id}`, "PUT", { ...content, title: "Rejected replacement" })).data as { revisionId: string };
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["cn", "intl"], turnstileToken: "test-token" })).status).toBe(200);
        await decide(revised.revisionId, "cn");
        await decide(revised.revisionId, "intl", false);
        await visible(product.id, "CN", content.title);
        await visible(product.id, "JP", content.title);
        expect(fixture.database.prepare("SELECT DISTINCT revision_id FROM publications WHERE product_id = ? AND active = 1").all(product.id)).toEqual([{ revision_id: product.revisionId }]);
    });
    it.each([{ regions: ["intl"] as Region[] }, { regions: ["cn", "intl"] as Region[] }])("extends a published snapshot using requested regions $regions without resetting its live approval", async ({ regions }) => {
        await enroll();
        const product = await create(["cn"]);
        await decide(product.revisionId, "cn");
        const before = fixture.database.prepare("SELECT revision_id, media_token FROM publications WHERE product_id = ? AND region = 'cn'").get(product.id)!;
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions, turnstileToken: "test-token" })).status).toBe(200);
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM product_revisions WHERE product_id = ?").get(product.id)?.n).toBe(1);
        expect(fixture.database.prepare("SELECT status FROM publication_requests WHERE revision_id = ? AND region = 'cn'").get(product.revisionId)?.status).toBe("approved");
        expect(fixture.database.prepare("SELECT revision_id, media_token FROM publications WHERE product_id = ? AND region = 'cn'").get(product.id)).toEqual(before);
        await visible(product.id, "CN", content.title);
        await visible(product.id, "JP");
        expect(await queued(product.revisionId)).toMatchObject({ canRetry: false });
        await decide(product.revisionId, "intl");
        await visible(product.id, "JP", content.title);
        expect(fixture.database.prepare("SELECT revision_id, media_token FROM publications WHERE product_id = ? AND region = 'cn'").get(product.id)).toEqual(before);
        expect(fixture.database.prepare("SELECT media_token FROM publications WHERE product_id = ? AND region = 'intl'").get(product.id)?.media_token).not.toBe(before.media_token);
    });
    it.each(["withdraw", "unpublish", "revoke"])("cancels outstanding regional review through %s without hiding an already live CN snapshot", async (operation) => {
        const shop = await enroll();
        const product = await create();
        await decide(product.revisionId, "cn");
        const before = fixture.database.prepare("SELECT revision_id, media_token FROM publications WHERE product_id = ? AND region = 'cn'").get(product.id)!;
        const result = operation === "withdraw"
            ? await api(`merchant/products/${product.id}/withdraw`, "POST")
            : operation === "unpublish"
                ? await api(`merchant/products/${product.id}/unpublish`, "POST", { region: "intl" })
                : await api(`admin/shops/${shop.id}/revoke`, "POST", { region: "intl", reason: "Stop regional distribution" }, "admin");
        expect(result.status).toBe(200);
        await visible(product.id, "CN", content.title);
        await visible(product.id, "JP");
        expect(fixture.database.prepare("SELECT revision_id, media_token FROM publications WHERE product_id = ? AND region = 'cn'").get(product.id)).toEqual(before);
        expect(fixture.database.prepare("SELECT status FROM publication_requests WHERE revision_id = ? AND region = 'cn'").get(product.revisionId)?.status).toBe("approved");
        expect(fixture.database.prepare("SELECT submission_token FROM product_revisions WHERE id = ?").get(product.revisionId)?.submission_token).toBeNull();
        expect((await api(`admin/revisions/${product.revisionId}/review`, "POST", { region: "intl", approve: true }, "admin")).status).toBe(409);
    });
    it("keeps final regional decisions immutable and requires a new revision to request a rejected region again", async () => {
        await enroll();
        const product = await create();
        await decide(product.revisionId, "cn");
        await decide(product.revisionId, "intl", false);
        const decisions = fixture.database.prepare("SELECT region, status, reason FROM publication_requests WHERE revision_id = ? ORDER BY region").all(product.revisionId);
        const workspace = (await api("merchant/workspace")).data as { products: { id: string; regionalReviews: unknown[] }[] };
        expect(workspace.products.find((item) => item.id === product.id)?.regionalReviews).toEqual([
            { region: "cn", status: "approved", reason: "" }, { region: "intl", status: "rejected", reason: "Unsuitable for this region" },
        ]);
        const repeat = await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["intl"], turnstileToken: "test-token" });
        expect(repeat.status).toBe(409);
        expect(repeat.data).toMatchObject({ error: { code: "REVISION_REQUIRED" } });
        expect(fixture.database.prepare("SELECT region, status, reason FROM publication_requests WHERE revision_id = ? ORDER BY region").all(product.revisionId)).toEqual(decisions);
        await visible(product.id, "CN", content.title);
        await visible(product.id, "JP");
        const revised = await api(`merchant/products/${product.id}`, "PUT", content);
        expect(revised.status).toBe(200);
        const nextRevision = (revised.data as { revisionId: string }).revisionId;
        expect(nextRevision).not.toBe(product.revisionId);
        expect(fixture.database.prepare("SELECT region, status, reason FROM publication_requests WHERE revision_id = ? ORDER BY region").all(product.revisionId)).toEqual(decisions);
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["cn", "intl"], turnstileToken: "test-token" })).status).toBe(200);
        await decide(nextRevision, "intl");
        await visible(product.id, "JP");
        await decide(nextRevision, "cn");
        await visible(product.id, "CN", content.title);
        await visible(product.id, "JP", content.title);
    });
    it("requires a fresh revision after every requested region rejects without replacing either rejection record", async () => {
        await enroll();
        const product = await create();
        await decide(product.revisionId, "cn", false);
        await decide(product.revisionId, "intl", false);
        const decisions = fixture.database.prepare("SELECT region, status, reason FROM publication_requests WHERE revision_id = ? ORDER BY region").all(product.revisionId);
        const repeat = await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["cn"], turnstileToken: "test-token" });
        expect(repeat.status).toBe(409);
        expect(repeat.data).toMatchObject({ error: { code: "REVISION_REQUIRED" } });
        const saved = await api(`merchant/products/${product.id}`, "PUT", { ...content, summary: "Adjusted after regional review" });
        expect(saved.status).toBe(200);
        const nextRevision = (saved.data as { revisionId: string }).revisionId;
        expect(nextRevision).not.toBe(product.revisionId);
        expect(fixture.database.prepare("SELECT region, status, reason FROM publication_requests WHERE revision_id = ? ORDER BY region").all(product.revisionId)).toEqual(decisions);
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["cn"], turnstileToken: "test-token" })).status).toBe(200);
        await decide(nextRevision, "cn");
        await visible(product.id, "CN", content.title);
        await visible(product.id, "JP");
    });
    it("allows a withdrawn undecided revision to submit again with a fresh generation token", async () => {
        await enroll();
        const product = await create();
        const oldToken = fixture.database.prepare("SELECT submission_token FROM product_revisions WHERE id = ?").get(product.revisionId)?.submission_token;
        expect((await api(`merchant/products/${product.id}/withdraw`, "POST")).status).toBe(200);
        expect(fixture.database.prepare("SELECT region FROM publication_requests WHERE revision_id = ?").all(product.revisionId)).toEqual([]);
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["intl"], turnstileToken: "test-token" })).status).toBe(200);
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM product_revisions WHERE product_id = ?").get(product.id)?.n).toBe(1);
        const newToken = fixture.database.prepare("SELECT submission_token FROM product_revisions WHERE id = ?").get(product.revisionId)?.submission_token;
        expect(newToken).toEqual(expect.any(String));
        expect(newToken).not.toBe(oldToken);
        expect(fixture.database.prepare("SELECT region, status FROM publication_requests WHERE revision_id = ?").all(product.revisionId)).toEqual([{ region: "intl", status: "pending" }]);
        await decide(product.revisionId, "intl");
        await visible(product.id, "JP", content.title);
        await visible(product.id, "CN");
    });
    it("preserves an approval after unpublication and requires a new revision to publish that region again", async () => {
        await enroll();
        const product = await create();
        await decide(product.revisionId, "cn");
        await decide(product.revisionId, "intl");
        const approved = fixture.database.prepare("SELECT region, status, reason FROM publication_requests WHERE revision_id = ? ORDER BY region").all(product.revisionId);
        expect((await api(`merchant/products/${product.id}/unpublish`, "POST", { region: "intl" })).status).toBe(200);
        const repeat = await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["intl"], turnstileToken: "test-token" });
        expect(repeat.status).toBe(409);
        expect(repeat.data).toMatchObject({ error: { code: "REVISION_REQUIRED" } });
        expect(fixture.database.prepare("SELECT region, status, reason FROM publication_requests WHERE revision_id = ? ORDER BY region").all(product.revisionId)).toEqual(approved);
        await visible(product.id, "CN", content.title);
        await visible(product.id, "JP");
        const saved = await api(`merchant/products/${product.id}`, "PUT", content);
        expect(saved.status).toBe(200);
        const nextRevision = (saved.data as { revisionId: string }).revisionId;
        expect((await api(`merchant/products/${product.id}/submit`, "POST", { regions: ["cn", "intl"], turnstileToken: "test-token" })).status).toBe(200);
        await decide(nextRevision, "intl");
        await visible(product.id, "JP");
        await decide(nextRevision, "cn");
        await visible(product.id, "JP", content.title);
        expect(fixture.database.prepare("SELECT region, status, reason FROM publication_requests WHERE revision_id = ? ORDER BY region").all(product.revisionId)).toEqual(approved);
    });
    it("enforces ownership and blocks non-administrators, restricted and unverified accounts while keeping enrollment open", async () => {
        await enroll();
        const created = (await api("merchant/products", "POST", content)).data as { id: string };
        expect((await api(`merchant/products/${created.id}`, "PUT", content, "outsider")).status).toBe(409);
        for (const user of [{ ...admin, role: "user" }, { ...admin, banned: true }, { ...admin, emailVerified: false }]) {
            fixture.env.AUTH = Object.assign({} as Fetcher, { fetch: async () => Response.json(user) });
            expect((await api("admin/queue", "GET", undefined, "admin")).status).toBe(user.emailVerified ? 403 : 401);
        }
        fixture.env.AUTH = Object.assign({} as Fetcher, { fetch: async () => Response.json(admin) });
        expect((await api("admin/queue", "GET", undefined, "admin")).status).toBe(200);
    });
    it("rejects forged query regions and malformed cursors before SQL", async () => {
        await expect(listProducts(edgeRequest("/api/v1/products?region=intl"), fixture.env)).rejects.toMatchObject({ status: 400 });
        await expect(listProducts(edgeRequest("/api/v1/products?cursor=bad"), fixture.env)).rejects.toMatchObject({ status: 400 });
        expect((await api("merchant/enroll", "POST", { name: "X", description: "X", websiteUrl: "http://127.0.0.1" })).status).toBe(400);
    });
});
