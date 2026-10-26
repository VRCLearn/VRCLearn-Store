import { z } from "zod";
import type { MerchantProduct, ProductInput, Region, SessionUser, ShopInput, Workspace } from "../shared/contracts";
import type { AppEnv } from "./env";
import { getProduct, getShop, listProducts } from "./catalog";
import { deleteMediaKeys, deletePublicMedia, imageInfo, ownedMedia, publishMedia, releaseMediaStorage, reserveMediaStorage } from "./media";
import { failure, HttpError, jsonBody, mode, readBytes, regionOf, reserve, secureOrigin, session, turnstile } from "./security";
import { decisionSchema, productSchema, regionSchema, searchTokens, shopSchema, submitSchema } from "./validation";

interface ShopRow { id: string; owner_user_id: string; current_revision_id: string | null }
interface RevisionRow { id: string; product_id: string; content_json: string; status: MerchantProduct["status"]; review_reason: string; updated_at: string; submission_token: string | null }
interface ProductRow { id: string; shop_id: string; current_revision_id: string | null; latest_revision_id: string }
const now = () => new Date().toISOString();
const idSchema = z.string().uuid();
const regionBody = z.object({ region: regionSchema }).strict();
const regionReasonBody = z.object({ region: regionSchema, reason: z.string().trim().min(1).max(2000) }).strict();

function response(data: unknown, status = 200): Response {
    return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

async function shopFor(env: AppEnv, userId: string): Promise<ShopRow> {
    const shop = await env.DB.prepare("SELECT * FROM shops WHERE owner_user_id = ?").bind(userId).first<ShopRow>();
    if (!shop) throw new HttpError(409, "MERCHANT_REQUIRED", "Create a merchant shop before using this operation.");
    return shop;
}

async function productFor(env: AppEnv, shopId: string, productId: string): Promise<ProductRow> {
    const product = await env.DB.prepare("SELECT * FROM products WHERE id = ? AND shop_id = ?").bind(productId, shopId).first<ProductRow>();
    if (!product) throw new HttpError(404, "PRODUCT_NOT_FOUND", "This product could not be found.");
    return product;
}

function audit(env: AppEnv, user: SessionUser, action: string, targetId: string, reason = "", region?: Region): D1PreparedStatement {
    return env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_id, region, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), user.id, action, targetId, region ?? null, reason, now());
}

async function invalidate(env: AppEnv): Promise<void> {
    await env.STATE.put("catalog:version", crypto.randomUUID());
}

async function rate(env: AppEnv, user: SessionUser, action: string, maximum = 30): Promise<void> {
    await reserve(env, [{ key: `user:${user.id}:${action}`, limit: maximum, windowSeconds: 60 }]);
}

async function workspace(env: AppEnv, user: SessionUser): Promise<Workspace> {
    const shop = await env.DB.prepare("SELECT * FROM shops WHERE owner_user_id = ?").bind(user.id).first<ShopRow>();
    if (!shop) return { shop: null, permissions: [], products: [] };
    const revision = await env.DB.prepare("SELECT content_json FROM shop_revisions WHERE shop_id = ? ORDER BY created_at DESC LIMIT 1").bind(shop.id).first<{ content_json: string }>();
    const permissions = await env.DB.prepare("SELECT region, status, CASE WHEN review_reason != '' THEN review_reason ELSE reason END AS reason FROM regional_permissions WHERE shop_id = ?").bind(shop.id).all<Workspace["permissions"][number]>();
    const revisions = await env.DB.prepare(`SELECT p.id AS product_id, r.* FROM products p JOIN product_revisions r ON r.id = p.latest_revision_id WHERE p.shop_id = ? ORDER BY p.updated_at DESC LIMIT 201`).bind(shop.id).all<RevisionRow>();
    if (revisions.results.length > 200) throw new HttpError(409, "WORKSPACE_CAPACITY", "The first release supports up to 200 products per shop.");
    const allPublished = await env.DB.prepare("SELECT pub.product_id, pub.region FROM publications pub JOIN products p ON p.id = pub.product_id WHERE p.shop_id = ? AND pub.active = 1").bind(shop.id).all<{ product_id: string; region: Region }>();
    const allRequested = await env.DB.prepare("SELECT req.revision_id, req.region FROM publication_requests req JOIN products p ON p.latest_revision_id = req.revision_id WHERE p.shop_id = ?").bind(shop.id).all<{ revision_id: string; region: Region }>();
    const products: MerchantProduct[] = [];
    for (const item of revisions.results) {
        products.push({ id: item.product_id, content: JSON.parse(item.content_json) as ProductInput, revisionId: item.id, status: item.status, publishedRegions: allPublished.results.filter((row) => row.product_id === item.product_id).map((row) => row.region), requestedRegions: allRequested.results.filter((row) => row.revision_id === item.id).map((row) => row.region), reviewReason: item.review_reason });
    }
    return { shop: revision ? { id: shop.id, ...JSON.parse(revision.content_json) as ShopInput } : null, permissions: permissions.results, products };
}

async function queue(env: AppEnv): Promise<unknown> {
    const permissions = await env.DB.prepare(`SELECT perm.*, json_extract(sr.content_json, '$.name') AS shopName FROM regional_permissions perm JOIN shops s ON s.id = perm.shop_id LEFT JOIN shop_revisions sr ON sr.id = COALESCE(s.current_revision_id, (SELECT id FROM shop_revisions WHERE shop_id = s.id ORDER BY created_at DESC LIMIT 1)) WHERE perm.status = 'pending' ORDER BY perm.updated_at LIMIT 100`).all<{ id: string; shop_id: string; shopName: string; region: Region; status: string; reason: string }>();
    const products = await env.DB.prepare(`SELECT r.*, s.id AS shop_id, json_extract(sr.content_json, '$.name') AS shop_name FROM product_revisions r JOIN products p ON p.id = r.product_id JOIN shops s ON s.id = p.shop_id LEFT JOIN shop_revisions sr ON sr.id = s.current_revision_id WHERE r.status = 'pending' ORDER BY r.created_at LIMIT 100`).all<RevisionRow & { shop_id: string; shop_name: string }>();
    const productItems = [];
    for (const row of products.results) {
        const regions = await env.DB.prepare("SELECT region, status, reason FROM publication_requests WHERE revision_id = ? ORDER BY region").bind(row.id).all<{ region: Region; status: string; reason: string }>();
        productItems.push({ id: row.id, productId: row.product_id, shopName: row.shop_name, content: JSON.parse(row.content_json) as ProductInput, regions: regions.results });
    }
    const shops = await env.DB.prepare("SELECT id, shop_id, content_json, status FROM shop_revisions WHERE status = 'pending' ORDER BY created_at LIMIT 100").all<{ id: string; shop_id: string; content_json: string; status: string }>();
    const reports = await env.DB.prepare("SELECT id, product_id, reason, status FROM reports WHERE status = 'pending' ORDER BY created_at LIMIT 100").all<{ id: string; product_id: string; reason: string; status: string }>();
    return { permissions: permissions.results.map((row) => ({ id: row.id, shopId: row.shop_id, shopName: row.shopName, region: row.region, status: row.status, reason: row.reason })), products: productItems, shops: shops.results.map((row) => ({ id: row.id, shopId: row.shop_id, content: JSON.parse(row.content_json) as ShopInput, status: row.status })), reports: reports.results.map((row) => ({ id: row.id, productId: row.product_id, reason: row.reason, status: row.status })) };
}

async function finalize(env: AppEnv, revisionId: string): Promise<boolean> {
    const revision = await env.DB.prepare(`SELECT r.*, p.shop_id, p.latest_revision_id, p.current_revision_id FROM product_revisions r JOIN products p ON p.id = r.product_id WHERE r.id = ?`).bind(revisionId).first<RevisionRow & { shop_id: string; latest_revision_id: string; current_revision_id: string | null }>();
    if (!revision || revision.status !== "pending" || revision.latest_revision_id !== revisionId) return false;
    const submissionToken = revision.submission_token;
    if (!submissionToken) return false;
    const previousObjects = revision.current_revision_id ? await env.DB.prepare("SELECT object_key FROM public_media WHERE product_id = ? AND revision_id = ? LIMIT 101").bind(revision.product_id, revision.current_revision_id).all<{ object_key: string }>() : { results: [] };
    if (previousObjects.results.length > 100) throw new HttpError(503, "MEDIA_CLEANUP_REQUIRED", "Media cleanup is required before this operation can complete.");
    const requests = await env.DB.prepare(`SELECT req.region, req.status, perm.status AS permission_status FROM publication_requests req LEFT JOIN regional_permissions perm ON perm.shop_id = ? AND perm.region = req.region WHERE req.revision_id = ?`).bind(revision.shop_id, revisionId).all<{ region: Region; status: string; permission_status: string }>();
    if (!requests.results.length || requests.results.some((row) => row.status !== "approved" || row.permission_status !== "approved")) return false;
    await mode(env, true);
    const content = JSON.parse(revision.content_json) as ProductInput;
    await publishMedia(env, revision.product_id, revisionId, submissionToken, revision.shop_id, content, requests.results.map((row) => row.region));
    const timestamp = now();
    const guard = `EXISTS (SELECT 1 FROM products gp JOIN product_revisions gr ON gr.id = gp.latest_revision_id WHERE gp.id = ? AND gp.current_revision_id = ? AND gr.id = ? AND gr.status = 'pending' AND gr.submission_token = ?)`;
    const args = [revision.product_id, revisionId, revisionId, submissionToken];
    const statements: D1PreparedStatement[] = [env.DB.prepare(`UPDATE products SET current_revision_id = ?, updated_at = ? WHERE id = ? AND latest_revision_id = ? AND EXISTS (SELECT 1 FROM product_revisions WHERE id = ? AND status = 'pending' AND submission_token = ?)
        AND NOT EXISTS (SELECT 1 FROM publication_requests req LEFT JOIN regional_permissions perm ON perm.shop_id = products.shop_id AND perm.region = req.region WHERE req.revision_id = ? AND (req.status != 'approved' OR COALESCE(perm.status, '') != 'approved'))
        AND NOT EXISTS (SELECT 1 FROM publications pub WHERE pub.product_id = products.id AND pub.active = 1 AND NOT EXISTS (SELECT 1 FROM publication_requests req WHERE req.revision_id = ? AND req.region = pub.region))
        AND NOT EXISTS (SELECT 1 FROM shops s JOIN user_profiles u ON u.user_id = s.owner_user_id WHERE s.id = products.shop_id AND u.banned = 1)`).bind(revisionId, timestamp, revision.product_id, revisionId, revisionId, submissionToken, revisionId, revisionId)];
    for (const row of requests.results) statements.push(env.DB.prepare(`INSERT INTO publications (product_id, region, revision_id, media_token, active, updated_at, category, pricing, currency, price) SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?, ? WHERE ${guard} ON CONFLICT(product_id, region) DO UPDATE SET revision_id = excluded.revision_id, media_token = excluded.media_token, active = 1, updated_at = excluded.updated_at, category = excluded.category, pricing = excluded.pricing, currency = excluded.currency, price = excluded.price`).bind(revision.product_id, row.region, revisionId, submissionToken, timestamp, content.category, content.pricing, content.currency, content.price, ...args));
    statements.push(env.DB.prepare(`DELETE FROM product_search WHERE product_id = ? AND ${guard}`).bind(revision.product_id, ...args));
    statements.push(env.DB.prepare(`INSERT INTO product_search (product_id, tokens) SELECT ?, ? WHERE ${guard}`).bind(revision.product_id, searchTokens(`${content.title} ${content.summary} ${content.description} ${content.tags.join(" ")} ${content.compatibleModels.join(" ")}`).join(" "), ...args));
    statements.push(env.DB.prepare(`DELETE FROM product_facets WHERE product_id = ? AND ${guard}`).bind(revision.product_id, ...args));
    const facets: [string, string][] = [["category", content.category], ["pricing", content.pricing], ...content.tags.map((value): [string, string] => ["tag", value]), ...content.compatibleModels.map((value): [string, string] => ["model", value]), ...content.platforms.map((value): [string, string] => ["platform", value])];
    if (content.currency) facets.push(["currency", content.currency]);
    for (const [kind, value] of facets) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO product_facets (product_id, kind, value) SELECT ?, ?, ? WHERE ${guard}`).bind(revision.product_id, kind, value.normalize("NFKC").toLowerCase(), ...args));
    statements.push(env.DB.prepare(`UPDATE product_revisions SET status = 'published', updated_at = ? WHERE id = ? AND ${guard}`).bind(timestamp, revisionId, ...args));
    await env.DB.batch(statements);
    const published = await env.DB.prepare("SELECT status, submission_token FROM product_revisions WHERE id = ?").bind(revisionId).first<{ status: string; submission_token: string }>();
    if (published?.status !== "published" || published.submission_token !== submissionToken) {
        await deletePublicMedia(env, revision.product_id, undefined, revisionId, submissionToken);
        return false;
    }
    await deleteMediaKeys(env, previousObjects.results.map((row) => row.object_key));
    await invalidate(env);
    return true;
}

async function unpublish(env: AppEnv, productId: string, region: Region, user: SessionUser, reason: string): Promise<void> {
    await env.DB.batch([
        env.DB.prepare("UPDATE publications SET active = 0, updated_at = ? WHERE product_id = ? AND region = ?").bind(now(), productId, region),
        env.DB.prepare("UPDATE product_revisions SET status = 'withdrawn', submission_token = NULL, updated_at = ? WHERE product_id = ? AND status = 'pending'").bind(now(), productId),
        audit(env, user, "product.unpublish", productId, reason, region),
    ]);
    await deletePublicMedia(env, productId, region);
    await invalidate(env);
}

export async function handleApi(request: Request, env: AppEnv, _ctx: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
        const url = new URL(request.url);
        const path = url.pathname.replace(/^\/api\/v1\/?/, "").replace(/\/$/, "");
        const parts = path.split("/");
        const writing = !["GET", "HEAD"].includes(request.method);
        if (writing) secureOrigin(request, env);
        if (path === "config" && request.method === "GET") return response({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || "" });
        await mode(env);
        if (path === "me" && request.method === "GET") {
            try { return response({ user: await session(request, env) }); }
            catch (error) { if (error instanceof HttpError && error.status === 401) return response({ user: null }); throw error; }
        }
        if (request.method === "GET" && parts[0] === "products") {
            if (parts.length === 1) return response(await listProducts(request, env));
            if (parts.length === 2) return response(await getProduct(request, env, idSchema.parse(parts[1])));
        }
        if (request.method === "GET" && parts[0] === "shops" && parts.length >= 2) {
            const id = idSchema.parse(parts[1]);
            if (parts.length === 2) return response(await getShop(request, env, id));
            if (parts.length === 3 && parts[2] === "products") { await getShop(request, env, id); return response(await listProducts(request, env, id)); }
        }
        const user = await session(request, env, parts[0] === "admin");
        if (writing) await rate(env, user, parts.slice(0, 2).join(":"));
        if (parts[0] === "favorites") {
            const region = regionOf(request);
            if (parts.length === 1 && request.method === "GET") {
                const cursor = url.searchParams.get("cursor");
                if (cursor && !idSchema.safeParse(cursor).success) throw new HttpError(400, "INVALID_CURSOR", "Invalid favorites cursor.");
                const rows = await env.DB.prepare(`SELECT product_id FROM favorites WHERE user_id = ? ${cursor ? "AND product_id > ?" : ""} ORDER BY product_id LIMIT 25`).bind(user.id, ...(cursor ? [cursor] : [])).all<{ product_id: string }>();
                const items = [];
                for (const row of rows.results.slice(0, 24)) {
                    try { items.push({ productId: row.product_id, product: await getProduct(request, env, row.product_id) }); }
                    catch (error) { if (error instanceof HttpError && error.status === 404) items.push({ productId: row.product_id, product: null }); else throw error; }
                }
                return response({ items, nextCursor: rows.results.length > 24 ? rows.results[23].product_id : null });
            }
            if (parts.length === 2) {
                const id = idSchema.parse(parts[1]);
                if (request.method === "PUT") { await getProduct(request, env, id); await env.DB.prepare("INSERT OR IGNORE INTO favorites (user_id, product_id, created_at) VALUES (?, ?, ?)").bind(user.id, id, now()).run(); return response({ ok: true, region }); }
                if (request.method === "DELETE") { await env.DB.prepare("DELETE FROM favorites WHERE user_id = ? AND product_id = ?").bind(user.id, id).run(); return response({ ok: true }); }
            }
        }
        if (path === "reports" && request.method === "POST") {
            const body = await jsonBody(request, z.object({ productId: z.string().uuid(), reason: z.string().trim().min(10).max(2000) }).strict());
            await getProduct(request, env, body.productId);
            await reserve(env, [{ key: `report:${user.id}`, limit: 10, windowSeconds: 86400 }]);
            await env.DB.prepare("INSERT INTO reports (id, user_id, product_id, reason, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, product_id) DO NOTHING").bind(crypto.randomUUID(), user.id, body.productId, body.reason, now()).run();
            return response({ ok: true }, 201);
        }
        if (path === "merchant/workspace" && request.method === "GET") return response(await workspace(env, user));
        if (parts[0] === "merchant" && parts[1] === "media" && parts.length === 3 && request.method === "GET") {
            const id = idSchema.parse(parts[2]);
            if (user.role === "admin") await session(request, env, true);
            const item = await env.DB.prepare(`SELECT m.private_key, m.content_type FROM media m JOIN shops s ON s.id = m.shop_id WHERE m.id = ? AND (? = 1 OR s.owner_user_id = ?)`).bind(id, user.role === "admin" ? 1 : 0, user.id).first<{ private_key: string; content_type: string }>();
            if (!item) throw new HttpError(404, "MEDIA_NOT_FOUND", "The image could not be found.");
            const object = await env.PRIVATE_MEDIA.get(item.private_key);
            if (!object) throw new HttpError(404, "MEDIA_NOT_FOUND", "The image could not be found.");
            return new Response(object.body, { headers: { "Content-Type": item.content_type, "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
        }
        if (path === "merchant/enroll" && request.method === "POST") {
            const body = await jsonBody(request, shopSchema);
            const existing = await env.DB.prepare("SELECT id FROM shops WHERE owner_user_id = ?").bind(user.id).first();
            if (existing) throw new HttpError(409, "ALREADY_MERCHANT", "This account already owns a shop.");
            const id = crypto.randomUUID();
            const revisionId = crypto.randomUUID();
            await env.DB.batch([env.DB.prepare("INSERT INTO shops (id, owner_user_id, created_at) VALUES (?, ?, ?)").bind(id, user.id, now()), env.DB.prepare("INSERT INTO shop_revisions (id, shop_id, content_json, status, created_at) VALUES (?, ?, ?, 'pending', ?)").bind(revisionId, id, JSON.stringify(body), now()), audit(env, user, "shop.enroll", id)]);
            return response({ id, revisionId }, 201);
        }
        if (parts[0] === "merchant") {
            const shop = await shopFor(env, user.id);
            if (path === "merchant/shop" && request.method === "PUT") {
                const body = await jsonBody(request, shopSchema);
                const revisionId = crypto.randomUUID();
                await env.DB.batch([env.DB.prepare("UPDATE shop_revisions SET status = 'withdrawn' WHERE shop_id = ? AND status = 'pending'").bind(shop.id), env.DB.prepare("INSERT INTO shop_revisions (id, shop_id, content_json, status, created_at) VALUES (?, ?, ?, 'pending', ?)").bind(revisionId, shop.id, JSON.stringify(body), now()), audit(env, user, "shop.submit", shop.id)]);
                return response({ revisionId });
            }
            if (path === "merchant/permissions" && request.method === "POST") {
                const body = await jsonBody(request, z.object({ region: regionSchema, reason: z.string().trim().min(10).max(2000) }).strict());
                const existing = await env.DB.prepare("SELECT status FROM regional_permissions WHERE shop_id = ? AND region = ?").bind(shop.id, body.region).first<{ status: string }>();
                if (existing && ["approved", "pending"].includes(existing.status)) throw new HttpError(409, "PERMISSION_EXISTS", "This region permission is already granted or pending review.");
                const id = crypto.randomUUID();
                await env.DB.batch([env.DB.prepare("INSERT INTO regional_permissions (id, shop_id, region, status, reason, updated_at) VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT(shop_id, region) DO UPDATE SET id = excluded.id, status = 'pending', reason = excluded.reason, review_reason = '', updated_at = excluded.updated_at WHERE regional_permissions.status IN ('rejected', 'revoked')").bind(id, shop.id, body.region, body.reason, now()), audit(env, user, "permission.request", shop.id, body.reason, body.region)]);
                return response({ id }, 201);
            }
            if (path === "merchant/products" && request.method === "POST") {
                await mode(env, true);
                const body = await jsonBody(request, productSchema);
                if (body.mediaIds.length) throw new HttpError(400, "UPLOAD_AFTER_CREATE", "Create the product before attaching images.");
                const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM products WHERE shop_id = ?").bind(shop.id).first<{ count: number }>();
                if ((count?.count ?? 0) >= 200) throw new HttpError(409, "SHOP_PRODUCT_LIMIT", "This shop has reached its initial 200-product limit.");
                const id = crypto.randomUUID();
                const revisionId = crypto.randomUUID();
                const timestamp = now();
                const result = await env.DB.batch([env.DB.prepare("INSERT INTO products (id, shop_id, latest_revision_id, created_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM products WHERE shop_id = ?) < 200").bind(id, shop.id, revisionId, timestamp, timestamp, shop.id), env.DB.prepare("INSERT INTO product_revisions (id, product_id, content_json, status, created_at, updated_at) SELECT ?, ?, ?, 'draft', ?, ? WHERE EXISTS (SELECT 1 FROM products WHERE id = ?)").bind(revisionId, id, JSON.stringify(body), timestamp, timestamp, id)]);
                if (!result[0].meta.changes) throw new HttpError(409, "SHOP_PRODUCT_LIMIT", "This shop has reached its initial 200-product limit.");
                return response({ id, revisionId }, 201);
            }
            if (parts[1] === "products" && parts.length >= 3) {
                const id = idSchema.parse(parts[2]);
                const product = await productFor(env, shop.id, id);
                const revision = await env.DB.prepare("SELECT * FROM product_revisions WHERE id = ?").bind(product.latest_revision_id).first<RevisionRow>();
                if (!revision) throw new HttpError(409, "REVISION_UNAVAILABLE", "The latest revision is unavailable.");
                if (parts.length === 3 && request.method === "PUT") {
                    await mode(env, true);
                    if (revision.status === "pending") throw new HttpError(409, "WITHDRAW_REQUIRED", "Withdraw the pending revision before editing.");
                    const body = await jsonBody(request, productSchema);
                    await ownedMedia(env, id, shop.id, body.mediaIds);
                    const revisionId = crypto.randomUUID();
                    const timestamp = now();
                    await env.DB.batch([env.DB.prepare(`INSERT INTO product_revisions (id, product_id, content_json, status, created_at, updated_at) SELECT ?, ?, ?, 'draft', ?, ? WHERE EXISTS (SELECT 1 FROM products p JOIN product_revisions r ON r.id = p.latest_revision_id WHERE p.id = ? AND p.latest_revision_id = ? AND r.status != 'pending')
                        AND NOT EXISTS (SELECT 1 FROM json_each(?, '$.mediaIds') refs LEFT JOIN media m ON m.id = refs.value AND m.product_id = ? AND m.shop_id = ? AND m.retiring = 0 WHERE m.id IS NULL)`).bind(revisionId, id, JSON.stringify(body), timestamp, timestamp, id, revision.id, JSON.stringify(body), id, shop.id), env.DB.prepare("UPDATE products SET latest_revision_id = ?, updated_at = ? WHERE id = ? AND latest_revision_id = ? AND EXISTS (SELECT 1 FROM product_revisions WHERE id = ?)").bind(revisionId, timestamp, id, revision.id, revisionId)]);
                    const check = await env.DB.prepare("SELECT latest_revision_id FROM products WHERE id = ?").bind(id).first<{ latest_revision_id: string }>();
                    if (check?.latest_revision_id !== revisionId) throw new HttpError(409, "REVISION_CONFLICT", "This product changed while you were editing. Refresh and try again.");
                    return response({ id, revisionId });
                }
                if (parts[3] === "submit" && request.method === "POST") {
                    await mode(env, true);
                    const body = await jsonBody(request, submitSchema);
                    if (!["draft", "withdrawn", "rejected"].includes(revision.status)) throw new HttpError(409, "INVALID_REVISION_STATE", "Only an editable revision can be submitted.");
                    await turnstile(request, env, body.turnstileToken, "submit");
                    await reserve(env, [{ key: `submit:${user.id}`, limit: 20, windowSeconds: 86400 }, { key: "submit:global", limit: 1000, windowSeconds: 86400 }]);
                    const published = await env.DB.prepare("SELECT region FROM publications WHERE product_id = ? AND active = 1").bind(id).all<{ region: Region }>();
                    if (published.results.some((row) => !body.regions.includes(row.region))) throw new HttpError(409, "ALL_REGIONS_REQUIRED", "A revision must include every currently published region.");
                    const permissions = await env.DB.prepare("SELECT region FROM regional_permissions WHERE shop_id = ? AND status = 'approved'").bind(shop.id).all<{ region: Region }>();
                    if (body.regions.some((region) => !permissions.results.some((row) => row.region === region))) throw new HttpError(403, "REGION_PERMISSION_REQUIRED", "Publication permission is required for every requested region.");
                    if (!shop.current_revision_id) throw new HttpError(409, "SHOP_REVIEW_REQUIRED", "The shop profile must be approved before publishing products.");
                    await ownedMedia(env, id, shop.id, (JSON.parse(revision.content_json) as ProductInput).mediaIds);
                    const timestamp = now();
                    const submissionToken = crypto.randomUUID();
                    const changes = await env.DB.batch([env.DB.prepare(`UPDATE product_revisions SET status = 'pending', review_reason = '', updated_at = ?, submission_token = ? WHERE id = ? AND status IN ('draft', 'withdrawn', 'rejected') AND EXISTS (SELECT 1 FROM products WHERE id = ? AND latest_revision_id = ?)
                        AND NOT EXISTS (SELECT 1 FROM json_each(product_revisions.content_json, '$.mediaIds') refs LEFT JOIN media m ON m.id = refs.value AND m.product_id = product_revisions.product_id AND m.shop_id = ? AND m.retiring = 0 WHERE m.id IS NULL)`).bind(timestamp, submissionToken, revision.id, id, revision.id, shop.id), env.DB.prepare("DELETE FROM publication_requests WHERE revision_id = ? AND EXISTS (SELECT 1 FROM product_revisions WHERE id = ? AND status = 'pending' AND submission_token = ?)").bind(revision.id, revision.id, submissionToken), ...body.regions.map((region) => env.DB.prepare("INSERT INTO publication_requests (revision_id, region, status) SELECT ?, ?, 'pending' WHERE EXISTS (SELECT 1 FROM product_revisions WHERE id = ? AND status = 'pending' AND submission_token = ?)").bind(revision.id, region, revision.id, submissionToken)), audit(env, user, "product.submit", id)]);
                    if (!changes[0].meta.changes) throw new HttpError(409, "REVISION_CONFLICT", "This revision has already changed.");
                    return response({ ok: true, revisionId: revision.id });
                }
                if (parts[3] === "withdraw" && request.method === "POST") {
                    const result = await env.DB.prepare("UPDATE product_revisions SET status = 'withdrawn', submission_token = NULL, updated_at = ? WHERE id = ? AND status = 'pending'").bind(now(), revision.id).run();
                    if (!result.meta.changes) throw new HttpError(409, "NOT_PENDING", "This revision is not pending review.");
                    return response({ ok: true });
                }
                if (parts[3] === "unpublish" && request.method === "POST") {
                    const body = await jsonBody(request, regionBody);
                    await unpublish(env, id, body.region, user, "Merchant requested unpublication.");
                    return response({ ok: true });
                }
            }
            if (path === "merchant/uploads" && request.method === "POST") {
                await mode(env, true);
                const productId = idSchema.parse(request.headers.get("X-Product-Id"));
                const product = await productFor(env, shop.id, productId);
                const revision = await env.DB.prepare("SELECT status FROM product_revisions WHERE id = ?").bind(product.latest_revision_id).first<{ status: string }>();
                if (revision?.status === "pending") throw new HttpError(409, "WITHDRAW_REQUIRED", "Withdraw the revision before adding images.");
                const key = request.headers.get("Idempotency-Key");
                if (!key || !idSchema.safeParse(key).success) throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "A new UUID Idempotency-Key is required for each upload attempt.");
                await turnstile(request, env, request.headers.get("X-Turnstile-Token") ?? "", "upload");
                const bytes = await readBytes(request, 2097152);
                const info = imageInfo(bytes);
                const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM media WHERE product_id = ?").bind(productId).first<{ count: number }>();
                if ((count?.count ?? 0) >= 30) throw new HttpError(409, "PRODUCT_MEDIA_LIMIT", "This product has reached its 30-upload revision allowance.");
                await reserve(env, [{ key: `upload:${user.id}:daily`, limit: 100, windowSeconds: 86400 }, { key: "upload:global:daily", limit: 1000, windowSeconds: 86400 }, { key: "upload:global:month:bytes", limit: 2147483648, windowSeconds: 2678400, period: "month", amount: bytes.byteLength }], `upload:${user.id}:${key}`);
                const id = crypto.randomUUID();
                const privateKey = `${shop.id}/${productId}/${id}`;
                await reserveMediaStorage(env, "private", privateKey, bytes.byteLength);
                await env.PRIVATE_MEDIA.put(privateKey, bytes, { httpMetadata: { contentType: info.contentType, cacheControl: "private, no-store" } });
                try {
                    const inserted = await env.DB.prepare("INSERT INTO media (id, shop_id, product_id, private_key, content_type, size, width, height, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM media WHERE product_id = ?) < 30").bind(id, shop.id, productId, privateKey, info.contentType, bytes.byteLength, info.width, info.height, now(), productId).run();
                    if (!inserted.meta.changes) throw new HttpError(409, "PRODUCT_MEDIA_LIMIT", "This product has reached its 30-upload revision allowance.");
                } catch (error) { await env.PRIVATE_MEDIA.delete(privateKey); await releaseMediaStorage(env, "private", privateKey); throw error; }
                return response({ id, previewUrl: `/api/v1/merchant/media/${id}` }, 201);
            }
        }
        if (parts[0] === "admin") {
            if (path === "admin/queue" && request.method === "GET") return response(await queue(env));
            if (parts.length === 4 && request.method === "POST") {
                const id = parts[1] === "users" ? z.string().min(1).max(128).regex(/^[\w-]+$/).parse(parts[2]) : idSchema.parse(parts[2]);
                if (parts[1] === "permissions" && parts[3] === "review") {
                    const body = await jsonBody(request, decisionSchema);
                    const result = await env.DB.batch([env.DB.prepare("UPDATE regional_permissions SET status = ?, review_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(body.approve ? "approved" : "rejected", body.reason, now(), id), audit(env, user, "permission.review", id, body.reason)]);
                    if (!result[0].meta.changes) throw new HttpError(409, "REVIEW_CONFLICT", "This permission application has already changed.");
                    await invalidate(env);
                    return response({ ok: true });
                }
                if (parts[1] === "revisions" && parts[3] === "review") {
                    const body = await jsonBody(request, z.object({ region: regionSchema, approve: z.boolean(), reason: z.string().trim().max(2000).default("") }).strict().refine((value) => value.approve || value.reason.length > 0));
                    const revision = await env.DB.prepare("SELECT r.*, p.shop_id FROM product_revisions r JOIN products p ON p.id = r.product_id WHERE r.id = ? AND p.latest_revision_id = r.id AND r.status = 'pending'").bind(id).first<RevisionRow & { shop_id: string }>();
                    if (!revision) throw new HttpError(409, "REVIEW_CONFLICT", "This revision is no longer pending review.");
                    const result = await env.DB.batch([env.DB.prepare(`UPDATE publication_requests SET status = ?, reason = ? WHERE revision_id = ? AND region = ? AND status = 'pending'
                        AND EXISTS (SELECT 1 FROM product_revisions WHERE id = ? AND status = 'pending')
                        AND EXISTS (SELECT 1 FROM regional_permissions WHERE shop_id = ? AND region = ? AND status = 'approved')`).bind(body.approve ? "approved" : "rejected", body.reason, id, body.region, id, revision.shop_id, body.region), ...(!body.approve ? [env.DB.prepare("UPDATE product_revisions SET status = 'rejected', review_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM publication_requests WHERE revision_id = ? AND region = ? AND status = 'rejected')").bind(body.reason, now(), id, id, body.region)] : []), audit(env, user, "product.review", id, body.reason, body.region)]);
                    if (!result[0].meta.changes) {
                        const prior = await env.DB.prepare("SELECT req.status, r.status AS revision_status FROM publication_requests req JOIN product_revisions r ON r.id = req.revision_id WHERE req.revision_id = ? AND req.region = ?").bind(id, body.region).first<{ status: string; revision_status: string }>();
                        if (body.approve && prior?.status === "approved" && prior.revision_status === "pending") return response({ ok: true, published: await finalize(env, id) });
                        throw new HttpError(409, "REVIEW_CONFLICT", "This region review has already changed or permission was revoked.");
                    }
                    return response({ ok: true, published: body.approve ? await finalize(env, id) : false });
                }
                if (parts[1] === "shops" && parts[3] === "review") {
                    const body = await jsonBody(request, decisionSchema);
                    const revision = await env.DB.prepare("SELECT shop_id FROM shop_revisions WHERE id = ? AND status = 'pending'").bind(id).first<{ shop_id: string }>();
                    if (!revision) throw new HttpError(409, "REVIEW_CONFLICT", "This shop revision is no longer pending.");
                    const decisionToken = crypto.randomUUID();
                    const result = await env.DB.batch([env.DB.prepare("UPDATE shop_revisions SET status = ?, review_reason = ?, decision_token = ? WHERE id = ? AND status = 'pending'").bind(body.approve ? "approved" : "rejected", body.reason, decisionToken, id), ...(body.approve ? [env.DB.prepare("UPDATE shops SET current_revision_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM shop_revisions WHERE id = ? AND status = 'approved' AND decision_token = ?)").bind(id, revision.shop_id, id, decisionToken)] : []), audit(env, user, "shop.review", revision.shop_id, body.reason)]);
                    if (!result[0].meta.changes) throw new HttpError(409, "REVIEW_CONFLICT", "This shop revision has already changed.");
                    await invalidate(env);
                    return response({ ok: true });
                }
                if (parts[1] === "products" && parts[3] === "unpublish") {
                    const body = await jsonBody(request, regionReasonBody);
                    await unpublish(env, id, body.region, user, body.reason);
                    return response({ ok: true });
                }
                if (parts[1] === "shops" && parts[3] === "revoke") {
                    const body = await jsonBody(request, regionReasonBody);
                    const products = await env.DB.prepare("SELECT p.id FROM products p JOIN publications pub ON pub.product_id = p.id WHERE p.shop_id = ? AND pub.region = ? AND pub.active = 1 LIMIT 201").bind(id, body.region).all<{ id: string }>();
                    if (products.results.length > 200) throw new HttpError(503, "REVOCATION_CAPACITY", "This operation requires batched maintenance.");
                    await env.DB.batch([env.DB.prepare("UPDATE regional_permissions SET status = 'revoked', review_reason = ?, updated_at = ? WHERE shop_id = ? AND region = ?").bind(body.reason, now(), id, body.region), env.DB.prepare("UPDATE publications SET active = 0 WHERE region = ? AND product_id IN (SELECT id FROM products WHERE shop_id = ?)").bind(body.region, id), env.DB.prepare("UPDATE product_revisions SET status = 'withdrawn', submission_token = NULL WHERE status = 'pending' AND product_id IN (SELECT id FROM products WHERE shop_id = ?) AND EXISTS (SELECT 1 FROM publication_requests req WHERE req.revision_id = product_revisions.id AND req.region = ?)").bind(id, body.region), audit(env, user, "permission.revoke", id, body.reason, body.region)]);
                    for (const product of products.results) await deletePublicMedia(env, product.id, body.region);
                    await invalidate(env);
                    return response({ ok: true });
                }
                if (parts[1] === "users" && parts[3] === "ban") {
                    const body = await jsonBody(request, z.object({ banned: z.boolean(), reason: z.string().trim().min(1).max(2000) }).strict());
                    if (id === user.id) throw new HttpError(409, "SELF_RESTRICTION", "Administrators cannot restrict their own account.");
                    const products = body.banned ? await env.DB.prepare("SELECT p.id FROM products p JOIN shops s ON s.id = p.shop_id WHERE s.owner_user_id = ? LIMIT 201").bind(id).all<{ id: string }>() : { results: [] };
                    if (products.results.length > 200) throw new HttpError(503, "REVOCATION_CAPACITY", "This operation requires batched maintenance.");
                    await env.DB.batch([env.DB.prepare("INSERT INTO user_profiles (user_id, banned) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET banned = excluded.banned").bind(id, body.banned ? 1 : 0), ...(body.banned ? [env.DB.prepare("UPDATE publications SET active = 0 WHERE product_id IN (SELECT p.id FROM products p JOIN shops s ON s.id = p.shop_id WHERE s.owner_user_id = ?)").bind(id), env.DB.prepare("UPDATE product_revisions SET status = 'withdrawn', submission_token = NULL WHERE status = 'pending' AND product_id IN (SELECT p.id FROM products p JOIN shops s ON s.id = p.shop_id WHERE s.owner_user_id = ?)").bind(id)] : []), audit(env, user, "user.restrict", id, body.reason)]);
                    for (const product of products.results) await deletePublicMedia(env, product.id);
                    await invalidate(env);
                    return response({ ok: true });
                }
                if (parts[1] === "reports" && parts[3] === "resolve") {
                    const body = await jsonBody(request, z.object({ reason: z.string().trim().min(1).max(2000) }).strict());
                    const result = await env.DB.batch([env.DB.prepare("UPDATE reports SET status = 'resolved', resolution = ? WHERE id = ? AND status = 'pending'").bind(body.reason, id), audit(env, user, "report.resolve", id, body.reason)]);
                    if (!result[0].meta.changes) throw new HttpError(409, "REVIEW_CONFLICT", "This report has already been handled.");
                    return response({ ok: true });
                }
            }
        }
        throw new HttpError(404, "ENDPOINT_NOT_FOUND", "This API endpoint could not be found.");
    } catch (error) {
        if (error instanceof z.ZodError) return failure(new HttpError(400, "INVALID_INPUT", "The request contains invalid identifiers or values."), requestId);
        return failure(error, requestId);
    }
}
