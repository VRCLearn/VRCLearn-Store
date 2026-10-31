import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { handleApi } from "../server/api";
import type { ProductComment } from "../shared/contracts";
import { admin, edgeRequest, merchant, testEnvironment } from "./helpers";
// @ts-expect-error Build tooling intentionally uses native JavaScript modules.
import { migrationStatements, validateAutomaticMigration } from "../scripts/migration-policy.mjs";

describe("private fulfillment and comments on the Workers D1 runtime", () => {
    let runtime: Miniflare;
    let fixture: ReturnType<typeof testEnvironment>;
    const productId = crypto.randomUUID();
    const shopId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const time = "2026-10-31T00:00:00.000Z";
    const execution = { waitUntil: (promise: Promise<unknown>) => { void promise; } };

    beforeAll(async () => {
        fixture = testEnvironment();
        runtime = new Miniflare({
            cf: false, telemetry: { enabled: false },
            workers: [{ config: {
                name: "redemption-d1-fixture", compatibilityDate: "2026-10-23",
                env: { DB: { type: "d1", id: crypto.randomUUID() } },
                manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default { fetch() { return new Response('fixture'); } };" } } },
            } }],
        });
        fixture.env.DB = await runtime.getD1Database("DB");
        for (const name of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
            const sql = readFileSync(`migrations/${name}`, "utf8");
            if (name !== "0001_initial.sql") expect(validateAutomaticMigration(name, sql).initial).toBeUndefined();
            for (const statement of migrationStatements(sql) as { sql: string }[]) await fixture.env.DB.prepare(statement.sql).run();
        }
        const shopRevisionId = crypto.randomUUID();
        await fixture.env.DB.batch([
            fixture.env.DB.prepare("INSERT INTO shops(id,owner_user_id,current_revision_id,created_at) VALUES(?,?,?,?)").bind(shopId, merchant.id, shopRevisionId, time),
            fixture.env.DB.prepare("INSERT INTO shop_revisions(id,shop_id,content_json,status,created_at) VALUES(?,?,?,'approved',?)").bind(shopRevisionId, shopId, JSON.stringify({ name: "Maker", description: "Maker", websiteUrl: "https://maker.example.com" }), time),
            fixture.env.DB.prepare("INSERT INTO regional_permissions(id,shop_id,region,status,reason,updated_at) VALUES(?,?,'cn','approved','Approved',?)").bind(crypto.randomUUID(), shopId, time),
            fixture.env.DB.prepare("INSERT INTO products(id,shop_id,current_revision_id,latest_revision_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(productId, shopId, revisionId, revisionId, time, time),
            fixture.env.DB.prepare("INSERT INTO product_revisions(id,product_id,content_json,status,created_at,updated_at) VALUES(?,?,?,'published',?,?)").bind(revisionId, productId, JSON.stringify({ title: "D1 verified product", r18: false }), time, time),
            fixture.env.DB.prepare("INSERT INTO publication_requests(revision_id,region,status) VALUES(?,'cn','approved')").bind(revisionId),
            fixture.env.DB.prepare("INSERT INTO publications(product_id,region,revision_id,media_token,active,category,pricing,updated_at) VALUES(?,'cn',?,'fixture',1,'tools','free',?)").bind(productId, revisionId, time),
        ]);
        vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const token = new URLSearchParams(String(init?.body)).get("response");
            return Response.json({ success: true, hostname: "store.vrclearn.com", action: token === "import-proof" ? "import-codes" : token === "comment-proof" ? "comment" : "redeem" });
        }));
    }, 30000);
    afterAll(async () => { vi.unstubAllGlobals(); fixture?.database.close(); await runtime?.dispose(); });

    async function api(path: string, body: unknown, user = "merchant", method = "POST") {
        const result = await handleApi(edgeRequest(`/api/v1/${path}`, { method, body, user }), fixture.env, execution);
        return { status: result.status, data: await result.json() };
    }

    it("runs the additive schema, MATERIALIZED all-or-nothing import and conditional UPDATE RETURNING under concurrency", async () => {
        const path = `merchant/products/${productId}/codes`;
        const imported = { entries: [{ code: "D1-Runtime-Code", content: "D1 private delivery" }], turnstileToken: "import-proof" };
        const imports = await Promise.all([api(path, imported), api(path, imported)]);
        expect(imports.map((result) => result.status).sort()).toEqual([201, 409]);
        const partial = await api(path, { entries: [...imported.entries, { code: "D1-Other-Code", content: "Other" }], turnstileToken: "import-proof" });
        expect(partial.status).toBe(409);
        expect(await fixture.env.DB.prepare("SELECT COUNT(*) AS n FROM redemption_codes").first("n")).toBe(1);
        const body = { code: "D1-Runtime-Code", turnstileToken: "redeem-proof" };
        const claimed = await Promise.all([api(`products/${productId}/redeem`, body, "outsider"), api(`products/${productId}/redeem`, body, "admin")]);
        expect(claimed.map((result) => result.status).sort()).toEqual([200, 400]);
        expect(claimed.find((result) => result.status === 200)?.data).toMatchObject({ content: "D1 private delivery", productId, title: "D1 verified product" });
        expect(JSON.stringify(claimed.find((result) => result.status === 400)?.data)).not.toContain("D1 private delivery");
        expect(await fixture.env.DB.prepare("SELECT COUNT(*) AS n FROM redemption_codes WHERE redeemed_by IS NOT NULL").first("n")).toBe(1);
    });

    it("gates comments on the actual winning redemption and atomically rejects duplicate posts or moderation evasion", async () => {
        const claimedBy = await fixture.env.DB.prepare("SELECT redeemed_by FROM redemption_codes WHERE redeemed_by IS NOT NULL LIMIT 1").first<string>("redeemed_by");
        const winner = claimedBy === "admin-one" ? "admin" : "outsider";
        const path = `products/${productId}/comments`;
        const body = { body: "D1 plain comment <b>not HTML</b>", turnstileToken: "comment-proof" };
        expect((await api(path, body)).status).toBe(409);
        const posts = await Promise.all([api(path, body, winner), api(path, body, winner)]);
        expect(posts.map((result) => result.status).sort()).toEqual([201, 409]);
        const comment = posts.find((result) => result.status === 201)!.data as ProductComment;
        expect(comment).toMatchObject({ productId, body: body.body, verifiedRedemption: true });
        expect(await fixture.env.DB.prepare("SELECT COUNT(*) AS n FROM product_comments").first("n")).toBe(1);
        const publicList = await api(path, undefined, "", "GET");
        expect(publicList.status).toBe(200);
        expect(JSON.stringify(publicList.data)).not.toMatch(/redeemed_by|D1 private delivery|code_hash|merchant-two|admin-one/);
        expect((await api(`admin/comments/${comment.id}/moderate`, { hidden: true, reason: "D1 moderation check" }, "admin")).status).toBe(200);
        expect((await api(`comments/${comment.id}`, undefined, winner, "DELETE")).status).toBe(200);
        expect((await api(path, body, winner)).status).toBe(409);
        expect((await api(`admin/comments/${comment.id}/moderate`, { hidden: false, reason: "Must not restore deleted text" }, "admin")).status).toBe(409);
        expect(await fixture.env.DB.prepare("SELECT body,hidden,deleted FROM product_comments WHERE id=?").bind(comment.id).first()).toMatchObject({ body: "", hidden: 1, deleted: 1 });
    });

    it.each(["product", "comment"] as const)("audits exactly the actual winner of a %s report resolution race in one D1 transaction", async (kind) => {
        const reportId = crypto.randomUUID();
        if (kind === "product") {
            await fixture.env.DB.prepare("INSERT INTO reports(id,user_id,product_id,reason,created_at) VALUES(?,?,?,?,?)").bind(reportId, "reporter", productId, "A report for concurrency validation", time).run();
        } else {
            const commentId = crypto.randomUUID();
            await fixture.env.DB.prepare(`INSERT INTO product_comments(id,product_id,user_id,region,author_name,body,created_at,updated_at)
                VALUES(?,?,?,'cn','Author','Reported comment',?,?)`).bind(commentId, productId, "report-author", time, time).run();
            await fixture.env.DB.prepare("INSERT INTO comment_reports(id,user_id,comment_id,reason,created_at) VALUES(?,?,?,?,?)").bind(reportId, "reporter", commentId, "A report for concurrency validation", time).run();
        }
        const auth = fixture.env.AUTH.fetch.bind(fixture.env.AUTH);
        fixture.env.AUTH.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            return request.headers.get("x-test-user") === "second-admin" ? Response.json({ ...admin, id: "admin-two" }) : auth(request);
        };
        const database = fixture.env.DB;
        const batch = database.batch.bind(database);
        let batches = 0;
        let release = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const coordinatedBatch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
            if (++batches === 2) release();
            await gate;
            return batch<T>(statements);
        };
        // Miniflare's RPC proxy does not support overriding a binding method;
        // a forwarding proxy adds only the test barrier around real D1 batches.
        fixture.env.DB = new Proxy(database, { get(target, property) {
            if (property === "batch") return coordinatedBatch;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        } });
        try {
            const choices = [{ user: "admin", actor: admin.id, reason: "First resolution" }, { user: "second-admin", actor: "admin-two", reason: "Second resolution" }];
            const results = await Promise.all(choices.map((choice) => api(`admin/reports/${reportId}/resolve`, { reason: choice.reason }, choice.user)));
            expect(results.map((result) => result.status).sort(), JSON.stringify(results)).toEqual([200, 409]);
            expect(batches).toBe(2);
            const winner = choices[results.findIndex((result) => result.status === 200)];
            const recorded = await fixture.env.DB.prepare("SELECT actor_id,reason FROM audit_log WHERE action='report.resolve' AND target_id=?").bind(reportId).all();
            expect(recorded.results).toEqual([{ actor_id: winner.actor, reason: winner.reason }]);
            const table = kind === "comment" ? "comment_reports" : "reports";
            expect(await fixture.env.DB.prepare(`SELECT status,resolution FROM ${table} WHERE id=?`).bind(reportId).first()).toMatchObject({ status: "resolved", resolution: winner.reason });
        } finally {
            release();
            fixture.env.DB = database;
            fixture.env.AUTH.fetch = auth;
        }
    });
});
