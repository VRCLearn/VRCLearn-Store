import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../server/api";
import { detailPage } from "../edge/ssr";
import { redemptionEntriesSchema, REDEMPTION_GLOBAL_MAX_CODES, REDEMPTION_PRODUCT_MAX_CODES, REDEMPTION_SHOP_MAX_CODES } from "../shared/redemption";
import type { PageResult, ProductInput, Redemption, RedemptionInventory } from "../shared/contracts";
import { edgeRequest, merchant, testEnvironment } from "./helpers";

const content: ProductInput = { title: "Original avatar", language: "en", summary: "An original avatar", description: "Creator description", category: "avatars", tags: [], compatibleModels: [], platforms: ["pc"], pricing: "paid", price: 10, currency: "USD", purchaseUrl: "https://maker.example.com/codes", mediaIds: [], r18: false };
const timestamp = "2026-10-31T00:00:00.000Z";

describe("private code inventory and atomic redemption", () => {
    let fixture: ReturnType<typeof testEnvironment>;
    let productId: string;
    let revisionId: string;
    let shopId: string;
    const execution = { waitUntil: (promise: Promise<unknown>) => { void promise; } };
    const delivery = "https://downloads.example.com/private?token=secret\nPrivate instructions <script>never execute</script>";
    beforeEach(() => {
        fixture = testEnvironment();
        productId = crypto.randomUUID(); revisionId = crypto.randomUUID(); shopId = crypto.randomUUID();
        const shopRevision = crypto.randomUUID();
        fixture.database.prepare("INSERT INTO shops(id,owner_user_id,current_revision_id,created_at) VALUES(?,?,?,?)").run(shopId, merchant.id, shopRevision, timestamp);
        fixture.database.prepare("INSERT INTO shop_revisions(id,shop_id,content_json,status,created_at) VALUES(?,?,?,'approved',?)").run(shopRevision, shopId, JSON.stringify({ name: "Maker", description: "Independent maker", websiteUrl: "https://maker.example.com" }), timestamp);
        fixture.database.prepare("INSERT INTO products(id,shop_id,current_revision_id,latest_revision_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(productId, shopId, revisionId, revisionId, timestamp, timestamp);
        fixture.database.prepare("INSERT INTO product_revisions(id,product_id,content_json,status,created_at,updated_at) VALUES(?,?,?,'published',?,?)").run(revisionId, productId, JSON.stringify(content), timestamp, timestamp);
        for (const region of ["cn", "intl"]) {
            fixture.database.prepare("INSERT INTO regional_permissions(id,shop_id,region,status,reason,updated_at) VALUES(?,?,?,'approved','Approved',?)").run(crypto.randomUUID(), shopId, region, timestamp);
            fixture.database.prepare("INSERT INTO publication_requests(revision_id,region,status) VALUES(?,?,'approved')").run(revisionId, region);
            fixture.database.prepare("INSERT INTO publications(product_id,region,revision_id,media_token,active,category,pricing,currency,price,updated_at) VALUES(?,?,?,?,1,'avatars','paid','USD',10,?)").run(productId, region, revisionId, crypto.randomUUID(), timestamp);
        }
        vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
            expect(String(url)).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
            const token = new URLSearchParams(String(options?.body)).get("response");
            return Response.json({ success: true, hostname: "store.vrclearn.com", action: token === "import-proof" ? "import-codes" : "redeem" });
        }));
    });
    afterEach(() => { fixture.database.close(); vi.unstubAllGlobals(); });

    async function api(path: string, method = "GET", body?: unknown, user = "merchant", country = "CN") {
        const response = await handleApi(edgeRequest(`/api/v1/${path}`, { method, body, user, country }), fixture.env, execution);
        return { status: response.status, data: await response.json() as Partial<Redemption & RedemptionInventory & PageResult<Redemption>>, headers: response.headers };
    }
    const codePath = () => `merchant/products/${productId}/codes`;
    const redeemPath = () => `products/${productId}/redeem`;
    const entries = (code = "Case-Sensitive-123", value = delivery) => [{ code, content: value }];
    async function load(code = "Case-Sensitive-123", value = delivery) {
        const result = await api(codePath(), "POST", { entries: entries(code, value), turnstileToken: "import-proof" });
        expect(result.status).toBe(201);
        expect(result.data).toEqual({ imported: 1 });
    }
    const redeem = (code = "Case-Sensitive-123", user = "outsider", country = "CN") => api(redeemPath(), "POST", { code, turnstileToken: "redeem-proof" }, user, country);

    it("stores only product-scoped code hashes, withholds delivery publicly, and returns only inventory counts to the owner", async () => {
        await load();
        const stored = fixture.database.prepare("SELECT * FROM redemption_codes").get()!;
        expect(stored.code_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(stored)).not.toContain("Case-Sensitive-123");
        expect((await api(codePath())).data).toEqual({ total: 1, available: 1, redeemed: 0 });
        expect((await api(codePath(), "GET", undefined, "outsider")).status).toBe(404);
        expect((await api(codePath(), "POST", { entries: entries("Another-Code"), turnstileToken: "import-proof" }, "outsider")).status).toBe(404);
        for (const path of [`products/${productId}`, "products", "recommendations", "merchant/workspace"]) {
            const result = await api(path);
            expect(result.status).toBe(200);
            expect(JSON.stringify(result.data)).not.toContain("Case-Sensitive-123");
            expect(JSON.stringify(result.data)).not.toContain("Private instructions");
            expect(JSON.stringify(result.data)).not.toContain(stored.code_hash);
        }
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE reason LIKE '%Private instructions%' OR reason LIKE '%Case-Sensitive%'").get()?.n).toBe(0);
    });

    it("charges inventory quota for unknown and non-owned products and fails closed before any ownership query", async () => {
        const getQuota = vi.fn(fixture.env.QUOTA.getByName.bind(fixture.env.QUOTA));
        fixture.env.QUOTA.getByName = getQuota;
        for (const id of [productId, crypto.randomUUID()]) {
            const before = getQuota.mock.calls.length;
            expect((await api(`merchant/products/${id}/codes`, "GET", undefined, "outsider")).status).toBe(404);
            expect(getQuota.mock.calls.length).toBe(before + 1);
        }
        fixture.queries.splice(0);
        fixture.env.QUOTA.getByName = vi.fn(() => { throw new Error("Quota unavailable"); });
        const result = await api(`merchant/products/${crypto.randomUUID()}/codes`, "GET", undefined, "outsider");
        expect(result.status).toBe(503);
        expect(result.data).toMatchObject({ error: { code: "QUOTA_UNAVAILABLE" } });
        expect(fixture.queries).toEqual([]);
    });

    it("never serializes imported codes or delivery content into public detail HTML", async () => {
        await load();
        const pending: Promise<unknown>[] = [];
        vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => undefined } });
        const response = await detailPage({ request: edgeRequest(`/zh-CN/products/${productId}`), env: fixture.env, ctx: { waitUntil: (promise) => pending.push(promise) } }, "product");
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).not.toContain("Private instructions");
        expect(html).not.toContain("Case-Sensitive-123");
        expect(html).not.toContain("secret");
        await Promise.all(pending);
    });

    it("claims one code once, preserves exact private text, and makes a retry by its owner idempotent", async () => {
        await load();
        const first = await redeem();
        expect(first.status).toBe(200);
        expect(first.headers.get("Cache-Control")).toContain("no-store");
        expect(first.data).toEqual({ id: expect.any(String), productId, title: content.title, content: delivery, redeemedAt: expect.any(String) });
        expect((await redeem()).data).toEqual(first.data);
        expect((await redeem("Case-Sensitive-123", "admin")).data).toMatchObject({ error: { code: "CODE_UNAVAILABLE" } });
        expect((await api(codePath())).data).toEqual({ total: 1, available: 0, redeemed: 1 });
        expect((await api("redemptions", "GET", undefined, "outsider")).data).toEqual({ items: [first.data], nextCursor: null });
        expect((await api("redemptions", "GET", undefined, "admin")).data).toEqual({ items: [], nextCursor: null });
    });

    it("allows exactly one account to win simultaneous redemption and never leaks delivery to a loser", async () => {
        await load();
        const results = await Promise.all([redeem(), redeem("Case-Sensitive-123", "admin")]);
        expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
        expect(JSON.stringify(results.find((result) => result.status === 400)?.data)).not.toContain("Private instructions");
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM redemption_codes WHERE redeemed_by IS NOT NULL").get()?.n).toBe(1);
    });

    it("rejects duplicate batches atomically, including concurrent identical imports", async () => {
        const request = { entries: entries(), turnstileToken: "import-proof" };
        const results = await Promise.all([api(codePath(), "POST", request), api(codePath(), "POST", request)]);
        expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
        const duplicate = await api(codePath(), "POST", { entries: [...entries("A-New-Code"), ...entries()], turnstileToken: "import-proof" });
        expect(duplicate.status).toBe(409);
        expect((await api(codePath())).data).toEqual({ total: 1, available: 1, redeemed: 0 });
        expect(redemptionEntriesSchema.safeParse([...entries(), ...entries(" Case-Sensitive-123 ")]).success).toBe(false);
    });

    it("cannot partially import or exceed product inventory capacity when two imports race for the last slot", async () => {
        const insert = fixture.database.prepare("INSERT INTO redemption_codes(id,product_id,shop_id,code_hash,delivery_content,imported_at) VALUES(?,?,?,?,?,?)");
        fixture.database.exec("BEGIN");
        for (let index = 0; index < REDEMPTION_PRODUCT_MAX_CODES - 1; index++) insert.run(crypto.randomUUID(), productId, shopId, index.toString(16).padStart(64, "0"), "Existing delivery", timestamp);
        fixture.database.exec("COMMIT");
        const tooMany = await api(codePath(), "POST", { entries: [...entries("First-New-Code"), ...entries("Second-New-Code")], turnstileToken: "import-proof" });
        expect(tooMany.status).toBe(409);
        expect((await api(codePath())).data.total).toBe(REDEMPTION_PRODUCT_MAX_CODES - 1);
        const results = await Promise.all(["First-New-Code", "Second-New-Code"].map((code) => api(codePath(), "POST", { entries: entries(code), turnstileToken: "import-proof" })));
        expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
        expect((await api(codePath())).data.total).toBe(REDEMPTION_PRODUCT_MAX_CODES);
    });

    it.each(["shop", "global"] as const)("enforces the %s retained inventory cap atomically", async (scope) => {
        const otherProduct = crypto.randomUUID();
        const otherShop = scope === "shop" ? shopId : crypto.randomUUID();
        if (scope === "global") fixture.database.prepare("INSERT INTO shops(id,owner_user_id,created_at) VALUES(?,'another-owner',?)").run(otherShop, timestamp);
        fixture.database.prepare("INSERT INTO products(id,shop_id,latest_revision_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(otherProduct, otherShop, crypto.randomUUID(), timestamp, timestamp);
        const limit = scope === "shop" ? REDEMPTION_SHOP_MAX_CODES : REDEMPTION_GLOBAL_MAX_CODES;
        fixture.database.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < ?)
            INSERT INTO redemption_codes(id,product_id,shop_id,code_hash,delivery_content,imported_at)
            SELECT printf('fixture-%d',n),?,?,printf('%064x',n),'Delivery',? FROM sequence`).run(limit - 1, otherProduct, otherShop, timestamp);
        const tooMany = await api(codePath(), "POST", { entries: [...entries("First-New-Code"), ...entries("Second-New-Code")], turnstileToken: "import-proof" });
        expect(tooMany.status).toBe(409);
        expect((await api(codePath())).data.total).toBe(0);
        await load("Last-New-Code");
        expect((await api(codePath(), "POST", { entries: entries("Overflow-Code"), turnstileToken: "import-proof" })).status).toBe(409);
        expect((await api(codePath())).data.total).toBe(1);
    });

    it("scopes a matching code to its product, trims surrounding whitespace and retains case sensitivity", async () => {
        await load();
        expect((await redeem("case-sensitive-123")).status).toBe(400);
        const missing = await api(`products/${crypto.randomUUID()}/redeem`, "POST", { code: "Case-Sensitive-123", turnstileToken: "redeem-proof" }, "outsider");
        expect(missing.status).toBe(400);
        expect((await redeem(" Case-Sensitive-123 ")).data.content).toBe(delivery);
    });

    it.each(["unpublish", "revoke", "ban", "adult", "shop", "review"])("withholds new claims and old receipts after a region becomes unavailable through %s", async (operation) => {
        await load();
        expect((await redeem()).status).toBe(200);
        await load("Unclaimed-Code");
        if (operation === "unpublish") fixture.database.prepare("UPDATE publications SET active=0 WHERE product_id=? AND region='cn'").run(productId);
        if (operation === "revoke") fixture.database.prepare("UPDATE regional_permissions SET status='revoked' WHERE shop_id=? AND region='cn'").run(shopId);
        if (operation === "ban") fixture.database.prepare("INSERT INTO user_profiles(user_id,banned) VALUES(?,1)").run(merchant.id);
        if (operation === "adult") fixture.database.prepare("UPDATE product_revisions SET content_json=? WHERE id=?").run(JSON.stringify({ ...content, r18: true }), revisionId);
        if (operation === "shop") fixture.database.prepare("UPDATE shop_revisions SET status='rejected' WHERE shop_id=?").run(shopId);
        if (operation === "review") fixture.database.prepare("UPDATE publication_requests SET status='rejected' WHERE revision_id=? AND region='cn'").run(revisionId);
        const result = await redeem("Unclaimed-Code");
        expect(result.status).toBe(400);
        expect(result.data).toMatchObject({ error: { code: "CODE_UNAVAILABLE" } });
        expect((await api("redemptions", "GET", undefined, "outsider")).data.items).toEqual([]);
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM redemption_codes WHERE redeemed_by IS NULL").get()?.n).toBe(1);
    });

    it("keeps receipt content in its claimed region and rejects unknown country without consuming a code", async () => {
        await load();
        expect((await redeem("Case-Sensitive-123", "outsider", "JP")).status).toBe(200);
        expect((await api("redemptions", "GET", undefined, "outsider", "CN")).data.items).toEqual([]);
        expect((await api("redemptions", "GET", undefined, "outsider", "JP")).data.items).toHaveLength(1);
        expect((await redeem()).status).toBe(400);
        for (const country of ["XX", "T1"]) {
            expect((await redeem("Unused-Code", "outsider", country)).data).toMatchObject({ error: { code: "REGION_UNKNOWN" } });
            expect((await api("redemptions", "GET", undefined, "outsider", country)).status).toBe(403);
        }
    });

    it("rechecks publication and buyer restrictions after verification instead of trusting a stale page", async () => {
        await load();
        vi.stubGlobal("fetch", vi.fn(async () => {
            fixture.database.prepare("UPDATE publications SET active=0 WHERE product_id=?").run(productId);
            return Response.json({ success: true, hostname: "store.vrclearn.com", action: "redeem" });
        }));
        expect((await redeem()).status).toBe(400);
        expect(fixture.database.prepare("SELECT redeemed_by FROM redemption_codes").get()?.redeemed_by).toBeNull();
        fixture.database.prepare("UPDATE publications SET active=1 WHERE product_id=?").run(productId);
        vi.stubGlobal("fetch", vi.fn(async () => {
            fixture.database.prepare("INSERT INTO user_profiles(user_id,banned) VALUES('merchant-two',1)").run();
            return Response.json({ success: true, hostname: "store.vrclearn.com", action: "redeem" });
        }));
        expect((await redeem()).status).toBe(400);
        expect((await api("redemptions", "GET", undefined, "outsider")).data.items).toEqual([]);
    });

    it("requires ownership and approved permission at the import statement after verification", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => {
            fixture.database.prepare("UPDATE regional_permissions SET status='revoked' WHERE shop_id=?").run(shopId);
            return Response.json({ success: true, hostname: "store.vrclearn.com", action: "import-codes" });
        }));
        expect((await api(codePath(), "POST", { entries: entries(), turnstileToken: "import-proof" })).status).toBe(409);
        expect((await api(codePath())).data.total).toBe(0);
    });

    it("bounds untrusted imports, rejects extra properties, and does not call challenges for invalid input", async () => {
        for (const imported of [[], Array.from({ length: 101 }, (_, index) => ({ code: `Code-${index.toString().padStart(4, "0")}`, content: "Delivery" })), [{ code: "short", content: delivery }], [{ code: "A-Code-123", content: delivery, productId }], [{ code: "Invisible\u200bCode", content: delivery }]]) {
            expect((await api(codePath(), "POST", { entries: imported, turnstileToken: "import-proof" })).status).toBe(400);
        }
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
        const oversized = { entries: [{ code: "Valid-Code", content: "x".repeat(131073) }], turnstileToken: "import-proof" };
        expect((await api(codePath(), "POST", oversized)).status).toBe(413);
        expect((await api(codePath())).data.total).toBe(0);
    });

    it("requires authentication, same-origin writes, a valid challenge and healthy quota before any claim", async () => {
        await load();
        expect((await api(redeemPath(), "POST", { code: "Case-Sensitive-123", turnstileToken: "proof" }, "")).status).toBe(401);
        expect((await api("redemptions", "GET", undefined, "")).status).toBe(401);
        const crossSite = edgeRequest(`/api/v1/${redeemPath()}`, { method: "POST", body: { code: "Case-Sensitive-123", turnstileToken: "proof" }, user: "outsider" });
        crossSite.headers.set("Origin", "https://evil.example.com");
        expect((await handleApi(crossSite, fixture.env, execution)).status).toBe(403);
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: false })));
        expect((await redeem()).status).toBe(403);
        fixture.env.QUOTA.getByName = vi.fn(() => { throw new Error("Quota unavailable"); });
        expect((await redeem()).status).toBe(503);
        expect(fixture.database.prepare("SELECT redeemed_by FROM redemption_codes").get()?.redeemed_by).toBeNull();
    });

    it("paginates bounded owner-only delivery history without allowing forged account or region filters", async () => {
        const batch = Array.from({ length: 27 }, (_, index) => ({ code: `Page-Code-${index.toString().padStart(4, "0")}`, content: `Private delivery ${index}` }));
        expect((await api(codePath(), "POST", { entries: batch, turnstileToken: "import-proof" })).status).toBe(201);
        for (const entry of batch) expect((await redeem(entry.code)).status).toBe(200);
        const first = (await api("redemptions", "GET", undefined, "outsider")).data as { items: Redemption[]; nextCursor: string };
        expect(first.items).toHaveLength(24);
        expect(first.nextCursor).toBeTruthy();
        const second = (await api(`redemptions?cursor=${encodeURIComponent(first.nextCursor)}`, "GET", undefined, "outsider")).data as { items: Redemption[]; nextCursor: string | null };
        expect(second.items).toHaveLength(3);
        expect(second.nextCursor).toBeNull();
        expect(new Set([...first.items, ...second.items].map((row) => row.id)).size).toBe(27);
        for (const query of ["userId=merchant-two", "region=intl", "cursor=bad"]) expect((await api(`redemptions?${query}`, "GET", undefined, "outsider")).status).toBe(400);
    });
});
