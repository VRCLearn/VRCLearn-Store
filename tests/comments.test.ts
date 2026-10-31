import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../server/api";
import { COMMENT_GLOBAL_MAX_ROWS, COMMENT_PRODUCT_MAX_ROWS } from "../shared/comments";
import type { CommentingInfo, PageResult, ProductComment, ProductInput } from "../shared/contracts";
import { admin, edgeRequest, merchant, testEnvironment } from "./helpers";

const content: ProductInput = { title: "Commented avatar", language: "en", summary: "An original avatar", description: "Creator description", category: "avatars", tags: [], compatibleModels: [], platforms: ["pc"], pricing: "paid", price: 10, currency: "USD", purchaseUrl: "https://maker.example.com/codes", mediaIds: [], r18: false };
const time = "2026-11-01T00:00:00.000Z";
const commentBody = "<script>not executable</script>\n**Plain text** https://example.com";

describe("redemption-gated regional product comments", () => {
    let fixture: ReturnType<typeof testEnvironment>;
    let productId: string;
    let revisionId: string;
    let shopId: string;
    const execution = { waitUntil: (promise: Promise<unknown>) => { void promise; } };
    beforeEach(() => {
        fixture = testEnvironment(); productId = crypto.randomUUID(); revisionId = crypto.randomUUID(); shopId = crypto.randomUUID();
        const shopRevision = crypto.randomUUID();
        fixture.database.prepare("INSERT INTO shops(id,owner_user_id,current_revision_id,created_at) VALUES(?,?,?,?)").run(shopId, merchant.id, shopRevision, time);
        fixture.database.prepare("INSERT INTO shop_revisions(id,shop_id,content_json,status,created_at) VALUES(?,?,?,'approved',?)").run(shopRevision, shopId, JSON.stringify({ name: "Maker", description: "Creator", websiteUrl: "https://maker.example.com" }), time);
        fixture.database.prepare("INSERT INTO products(id,shop_id,current_revision_id,latest_revision_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(productId, shopId, revisionId, revisionId, time, time);
        fixture.database.prepare("INSERT INTO product_revisions(id,product_id,content_json,status,created_at,updated_at) VALUES(?,?,?,'published',?,?)").run(revisionId, productId, JSON.stringify(content), time, time);
        for (const region of ["cn", "intl"]) {
            fixture.database.prepare("INSERT INTO regional_permissions(id,shop_id,region,status,reason,updated_at) VALUES(?,?,?,'approved','Approved',?)").run(crypto.randomUUID(), shopId, region, time);
            fixture.database.prepare("INSERT INTO publication_requests(revision_id,region,status) VALUES(?,?,'approved')").run(revisionId, region);
            fixture.database.prepare("INSERT INTO publications(product_id,region,revision_id,media_token,active,category,pricing,currency,price,updated_at) VALUES(?,?,?,?,1,'avatars','paid','USD',10,?)").run(productId, region, revisionId, crypto.randomUUID(), time);
        }
        vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
            const token = new URLSearchParams(String(options?.body)).get("response");
            return Response.json({ success: true, hostname: "store.vrclearn.com", action: token === "import-proof" ? "import-codes" : token === "redeem-proof" ? "redeem" : "comment" });
        }));
    });
    afterEach(() => { fixture.database.close(); vi.unstubAllGlobals(); });
    async function api<T = unknown>(path: string, method = "GET", body?: unknown, user = "outsider", country = "CN") {
        const response = await handleApi(edgeRequest(`/api/v1/${path}`, { method, body, user, country }), fixture.env, execution);
        return { status: response.status, data: await response.json() as T, headers: response.headers };
    }
    const comments = () => `products/${productId}/comments`;
    const status = (user = "outsider", country = "CN") => api<CommentingInfo>(`products/${productId}/commenting`, "GET", undefined, user, country);
    async function redeemed(user = "outsider", country = "CN", code = "Comment-Access-Code") {
        expect((await api(`merchant/products/${productId}/codes`, "POST", { entries: [{ code, content: "Private delivery never in comments" }], turnstileToken: "import-proof" }, "merchant")).status).toBe(201);
        expect((await api(`products/${productId}/redeem`, "POST", { code, turnstileToken: "redeem-proof" }, user, country)).status).toBe(200);
    }
    const post = (body = commentBody, user = "outsider", country = "CN") => api<ProductComment>(comments(), "POST", { body, turnstileToken: "comment-proof" }, user, country);

    it.each(["free", "paid"])("requires a real successful redemption even for a %s product, and publishes no private account or delivery data", async (pricing) => {
        fixture.database.prepare("UPDATE product_revisions SET content_json=json_set(content_json,'$.pricing',?) WHERE id=?").run(pricing, revisionId);
        expect((await status()).data).toEqual({ eligible: false, comment: null, hidden: false });
        expect((await post()).status).toBe(409);
        expect((await post(commentBody, "")).status).toBe(401);
        await redeemed();
        expect((await status()).data).toEqual({ eligible: true, comment: null, hidden: false });
        const created = await post();
        expect(created.status).toBe(201);
        expect(created.data).toEqual({ id: expect.any(String), productId, authorName: "Maker", body: commentBody, createdAt: expect.any(String), updatedAt: expect.any(String), verifiedRedemption: true });
        const list = await api<PageResult<ProductComment>>(comments(), "GET", undefined, "");
        expect(list.status).toBe(200);
        expect(list.headers.get("Cache-Control")).toContain("no-store");
        expect(list.data.items).toEqual([created.data]);
        expect(Object.keys(list.data.items[0]).sort()).toEqual(["authorName", "body", "createdAt", "id", "productId", "updatedAt", "verifiedRedemption"].sort());
        expect(JSON.stringify(list.data)).not.toMatch(/merchant-two|merchant@example|Private delivery|Comment-Access-Code|code_hash/);
        expect((await status()).data.comment).toEqual(created.data);
    });

    it("creates one row under concurrent posts, allows only its owner to edit, and reuses self-deleted identity", async () => {
        await redeemed();
        const results = await Promise.all([post("First body"), post("Second body")]);
        expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
        const row = results.find((result) => result.status === 201)!.data;
        expect((await api(`comments/${row.id}`, "PUT", { body: "Unauthorized", turnstileToken: "comment-proof" }, "admin")).status).toBe(409);
        const edited = await api<ProductComment>(`comments/${row.id}`, "PUT", { body: "Edited plain text", turnstileToken: "comment-proof" });
        expect(edited.status).toBe(200);
        expect(edited.data.body).toBe("Edited plain text");
        expect(edited.data.createdAt).toBe(row.createdAt);
        expect((await api(`comments/${row.id}`, "DELETE", undefined, "admin")).status).toBe(404);
        expect((await api(`comments/${row.id}`, "DELETE")).status).toBe(200);
        expect(fixture.database.prepare("SELECT body,deleted,hidden FROM product_comments WHERE id=?").get(row.id)).toEqual({ body: "", deleted: 1, hidden: 0 });
        const recreated = await post("Replacement body");
        expect(recreated.status).toBe(201);
        expect(recreated.data.id).toBe(row.id);
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM product_comments").get()?.n).toBe(1);
    });

    it("isolates comments, eligibility, edits and reports by actual redemption and request region", async () => {
        await redeemed("outsider", "JP");
        expect((await status()).data.eligible).toBe(false);
        expect((await post()).status).toBe(409);
        const created = await post(commentBody, "outsider", "JP");
        expect(created.status).toBe(201);
        expect((await api<PageResult<ProductComment>>(comments(), "GET", undefined, "")).data.items).toEqual([]);
        expect((await api<PageResult<ProductComment>>(comments(), "GET", undefined, "", "JP")).data.items).toHaveLength(1);
        expect((await api(`comments/${created.data.id}`, "PUT", { body: "CN edit", turnstileToken: "comment-proof" })).status).toBe(409);
        expect((await api(`comments/${created.data.id}`, "DELETE")).status).toBe(404);
        expect((await api(`comments/${created.data.id}/report`, "POST", { reason: "Wrong region report" }, "merchant")).status).toBe(409);
        for (const country of ["XX", "T1"]) {
            expect((await post("Unknown region", "outsider", country)).status).toBe(403);
            expect((await status("outsider", country)).status).toBe(403);
            expect((await api(comments(), "GET", undefined, "", country)).status).toBe(403);
        }
    });

    it.each(["unpublish", "revoke", "adult", "owner-ban", "author-ban", "unapprove"])("rejects stale writes and hides public comments after %s", async (change) => {
        await redeemed();
        const created = await post();
        const apply = () => {
            if (change === "unpublish") fixture.database.prepare("UPDATE publications SET active=0 WHERE product_id=?").run(productId);
            if (change === "revoke") fixture.database.prepare("UPDATE regional_permissions SET status='revoked' WHERE shop_id=?").run(shopId);
            if (change === "adult") fixture.database.prepare("UPDATE product_revisions SET content_json=json_set(content_json,'$.r18',json('true')) WHERE id=?").run(revisionId);
            if (change === "owner-ban") fixture.database.prepare("INSERT INTO user_profiles(user_id,banned) VALUES(?,1)").run(merchant.id);
            if (change === "author-ban") fixture.database.prepare("INSERT INTO user_profiles(user_id,banned) VALUES('merchant-two',1)").run();
            if (change === "unapprove") fixture.database.prepare("UPDATE publication_requests SET status='rejected' WHERE revision_id=?").run(revisionId);
        };
        vi.stubGlobal("fetch", vi.fn(async () => { apply(); return Response.json({ success: true, hostname: "store.vrclearn.com", action: "comment" }); }));
        expect((await api(`comments/${created.data.id}`, "PUT", { body: "Stale write", turnstileToken: "comment-proof" })).status).toBe(409);
        expect(fixture.database.prepare("SELECT body FROM product_comments WHERE id=?").get(created.data.id)?.body).toBe(commentBody);
        const list = await api<PageResult<ProductComment>>(comments(), "GET", undefined, "");
        expect(list.status).toBe(change === "author-ban" ? 200 : 404);
        if (list.status === 200) expect(list.data.items).toEqual([]);
    });

    it("preserves admin hiding across owner deletion/reposting, audits moderation and never restores deleted content", async () => {
        await redeemed();
        const created = await post();
        const route = `admin/comments/${created.data.id}/moderate`;
        expect((await api(route, "POST", { hidden: true, reason: "Moderation reason" })).status).toBe(403);
        expect((await api(route, "POST", { hidden: true, reason: "Moderation reason" }, "admin")).status).toBe(200);
        expect((await status()).data).toMatchObject({ eligible: false, hidden: true, comment: { id: created.data.id, body: commentBody } });
        expect((await api<PageResult<ProductComment>>(comments(), "GET", undefined, "")).data.items).toEqual([]);
        expect((await api(`comments/${created.data.id}`, "PUT", { body: "Evade moderation", turnstileToken: "comment-proof" })).status).toBe(409);
        expect((await api(`comments/${created.data.id}`, "DELETE")).status).toBe(200);
        expect((await post("Repost hidden comment")).status).toBe(409);
        expect((await status()).data).toEqual({ eligible: false, hidden: true, comment: null });
        expect((await api(route, "POST", { hidden: false, reason: "Cannot resurrect deleted text" }, "admin")).status).toBe(409);
        expect(fixture.database.prepare("SELECT body,hidden,deleted FROM product_comments WHERE id=?").get(created.data.id)).toEqual({ body: "", hidden: 1, deleted: 1 });
        expect(fixture.database.prepare("SELECT action,reason FROM audit_log WHERE target_id=?").all(created.data.id)).toEqual([{ action: "comment.hide", reason: "Moderation reason" }]);
    });

    it("can restore an active hidden comment and allows its owner to remove text after product takedown", async () => {
        await redeemed();
        const created = await post();
        const route = `admin/comments/${created.data.id}/moderate`;
        await api(route, "POST", { hidden: true, reason: "Review" }, "admin");
        expect((await api(route, "POST", { hidden: false, reason: "Restored after review" }, "admin")).status).toBe(200);
        expect((await api<PageResult<ProductComment>>(comments(), "GET", undefined, "")).data.items).toHaveLength(1);
        fixture.database.prepare("UPDATE publications SET active=0 WHERE product_id=?").run(productId);
        expect((await api(`comments/${created.data.id}`, "DELETE")).status).toBe(200);
        expect(fixture.database.prepare("SELECT body FROM product_comments WHERE id=?").get(created.data.id)?.body).toBe("");
    });

    it("accepts separate reports for different comments, associates each target, and keeps the admin queue bounded and resolvable", async () => {
        await redeemed(); const one = (await post()).data;
        await redeemed("admin", "CN", "Admin-Redemption-Code"); const two = (await post("Second user comment", "admin")).data;
        for (const comment of [one, two]) expect((await api(`comments/${comment.id}/report`, "POST", { reason: "Please review this comment" }, "merchant")).status).toBe(201);
        expect((await api(`comments/${one.id}/report`, "POST", { reason: "\0" + "x".repeat(20) }, "admin")).status).toBe(400);
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM comment_reports").get()?.n).toBe(2);
        expect((await api(`comments/${one.id}/report`, "POST", { reason: "Duplicate report reason" }, "merchant")).status).toBe(409);
        const queue = (await api<{ reports: { id: string; productId: string; commentId: string; commentBody: string; commentAuthorName: string; commentHidden: boolean; commentDeleted: boolean }[] }>("admin/queue", "GET", undefined, "admin")).data;
        expect(queue.reports).toHaveLength(2);
        expect(new Set(queue.reports.map((row) => row.commentId))).toEqual(new Set([one.id, two.id]));
        expect(queue.reports[0]).toMatchObject({ productId, commentHidden: false, commentDeleted: false, commentBody: expect.any(String), commentAuthorName: expect.any(String) });
        expect(JSON.stringify(queue.reports)).not.toMatch(/Private delivery|Comment-Access-Code|code_hash/);
        expect((await api(`admin/reports/${queue.reports[0].id}/resolve`, "POST", { reason: "Reviewed comment" }, "admin")).status).toBe(200);
        expect(fixture.database.prepare("SELECT status FROM comment_reports WHERE id=?").get(queue.reports[0].id)?.status).toBe("resolved");
        expect((await api<{ reports: unknown[] }>("admin/queue", "GET", undefined, "admin")).data.reports).toHaveLength(1);
    });

    it.each(["product", "comment"] as const)("audits only the winning administrator when two resolvers race for a %s report", async (kind) => {
        let reportId: string;
        if (kind === "comment") {
            await redeemed();
            const created = (await post()).data;
            expect((await api(`comments/${created.id}/report`, "POST", { reason: "Please review this comment" }, "merchant")).status).toBe(201);
            reportId = String(fixture.database.prepare("SELECT id FROM comment_reports").get()!.id);
        } else {
            expect((await api("reports", "POST", { productId, reason: "Please review this product" }, "merchant")).status).toBe(201);
            reportId = String(fixture.database.prepare("SELECT id FROM reports").get()!.id);
        }
        const auth = fixture.env.AUTH.fetch.bind(fixture.env.AUTH);
        fixture.env.AUTH.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            return request.headers.get("x-test-user") === "second-admin" ? Response.json({ ...admin, id: "admin-two" }) : auth(request);
        };
        const choices = [{ user: "admin", actor: admin.id, reason: "First administrator resolution" }, { user: "second-admin", actor: "admin-two", reason: "Second administrator resolution" }];
        const resolved = await Promise.all(choices.map((choice) => api(`admin/reports/${reportId}/resolve`, "POST", { reason: choice.reason }, choice.user)));
        expect(resolved.map((result) => result.status).sort()).toEqual([200, 409]);
        const winner = choices[resolved.findIndex((result) => result.status === 200)];
        expect(fixture.database.prepare("SELECT actor_id,reason FROM audit_log WHERE action='report.resolve' AND target_id=?").all(reportId)).toEqual([{ actor_id: winner.actor, reason: winner.reason }]);
        const table = kind === "comment" ? "comment_reports" : "reports";
        expect(fixture.database.prepare(`SELECT status,resolution FROM ${table} WHERE id=?`).get(reportId)).toEqual({ status: "resolved", resolution: winner.reason });
    });

    it.each(["product", "global"] as const)("bounds retained %s comments while allowing self-deleted rows to reactivate", async (scope) => {
        await redeemed(); const created = (await post()).data;
        await api(`comments/${created.id}`, "DELETE");
        const fillProduct = scope === "product" ? productId : crypto.randomUUID();
        if (scope === "global") fixture.database.prepare("INSERT INTO products(id,shop_id,latest_revision_id,created_at,updated_at) VALUES(?,?,?,?,?)").run(fillProduct, shopId, crypto.randomUUID(), time, time);
        const limit = scope === "product" ? COMMENT_PRODUCT_MAX_ROWS : COMMENT_GLOBAL_MAX_ROWS;
        fixture.database.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < ?)
            INSERT INTO product_comments(id,product_id,user_id,region,author_name,body,created_at,updated_at)
            SELECT printf('fixture-%d',n),?,printf('author-%d',n),'cn','Author','Body',?,? FROM sequence`).run(limit - 1, fillProduct, time, time);
        await redeemed("admin", "CN", "Other-Access-Code");
        expect((await post("Over capacity", "admin")).status).toBe(409);
        const restored = await post("Restored own body");
        expect(restored.status).toBe(201);
        expect(restored.data.id).toBe(created.id);
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM product_comments").get()?.n).toBe(limit);
    });

    it("bounds and validates plaintext input, fails closed on quota/challenge errors and protects private status queries before DB access", async () => {
        for (const body of ["", "x".repeat(2001), "null\0character"]) expect((await post(body)).status).toBe(400);
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
        await redeemed();
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: false })));
        expect((await post()).status).toBe(403);
        fixture.env.QUOTA.getByName = vi.fn(() => { throw new Error("Quota unavailable"); });
        fixture.queries.splice(0);
        expect((await status()).status).toBe(503);
        expect(fixture.queries).toEqual([]);
        expect((await post()).status).toBe(503);
        expect(fixture.database.prepare("SELECT COUNT(*) AS n FROM product_comments").get()?.n).toBe(0);
    });
});
