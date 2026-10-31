import { z } from "zod";
import type { CommentingInfo, PageResult, ProductComment, Region, SessionUser } from "../shared/contracts";
import { commentInputSchema, COMMENT_GLOBAL_MAX_ROWS, COMMENT_PRODUCT_MAX_ROWS, COMMENT_REPORT_GLOBAL_MAX_ROWS } from "../shared/comments";
import { publicFrom, publicWhere } from "./catalog";
import type { AppEnv } from "./env";
import { HttpError, jsonBody, publicRate, regionOf, reserve, turnstile } from "./security";

interface CommentRow {
    id: string; productId: string; authorName: string; body: string; createdAt: string; updatedAt: string;
    hidden?: number; deleted?: number;
}
const columns = "id, product_id AS productId, author_name AS authorName, body, created_at AS createdAt, updated_at AS updatedAt";
const cursorSchema = z.object({ id: z.string().uuid(), time: z.string().datetime() }).strict();
const reportSchema = z.object({ reason: z.string().trim().min(10).max(2000).refine((reason) => !reason.includes("\0"), "Report reasons cannot contain null characters.") }).strict();
const moderationSchema = z.object({ hidden: z.boolean(), reason: z.string().trim().min(1).max(2000) }).strict();
const buyerAllowed = "NOT EXISTS (SELECT 1 FROM user_profiles buyer WHERE buyer.user_id = ? AND buyer.banned = 1)";
const eligibleProduct = `SELECT g.id ${publicFrom} WHERE ${publicWhere} AND g.id = ? AND ${buyerAllowed}
    AND EXISTS (SELECT 1 FROM redemption_codes code WHERE code.product_id = g.id AND code.redeemed_by = ? AND code.redeemed_region = ?)`;
const visibleCommentProduct = `SELECT g.id ${publicFrom} WHERE ${publicWhere} AND g.id = product_comments.product_id`;

function toComment(row: CommentRow): ProductComment {
    return { id: row.id, productId: row.productId, authorName: row.authorName, body: row.body, createdAt: row.createdAt, updatedAt: row.updatedAt, verifiedRedemption: true };
}

async function commentRate(env: AppEnv, user: SessionUser, writing: boolean): Promise<void> {
    await reserve(env, writing ? [
        { key: `comments:write:${user.id}:minute`, limit: 6, windowSeconds: 60 },
        { key: `comments:write:${user.id}:day`, limit: 20, windowSeconds: 86400 },
        { key: "comments:write:global:day", limit: 2000, windowSeconds: 86400 },
    ] : [
        { key: `comments:private:${user.id}:minute`, limit: 30, windowSeconds: 60 },
        { key: `comments:private:${user.id}:day`, limit: 1000, windowSeconds: 86400 },
        { key: "comments:private:global:day", limit: 20000, windowSeconds: 86400 },
    ]);
}

async function requireVisible(env: AppEnv, productId: string, region: Region): Promise<void> {
    const product = await env.DB.prepare(`SELECT g.id ${publicFrom} WHERE ${publicWhere} AND g.id = ?`).bind(region, productId).first();
    if (!product) throw new HttpError(404, "PRODUCT_NOT_FOUND", "This product is not available in your region.");
}

export async function listComments(request: Request, env: AppEnv, productId: string): Promise<PageResult<ProductComment>> {
    const region = regionOf(request);
    const params = new URL(request.url).searchParams;
    for (const key of params.keys()) if (key !== "cursor") throw new HttpError(400, "INVALID_FILTER", "Unsupported comment filter.");
    const raw = params.get("cursor");
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (raw) {
        try {
            if (raw.length > 512) throw new Error();
            cursor = cursorSchema.parse(JSON.parse(atob(raw)));
        } catch { throw new HttpError(400, "INVALID_CURSOR", "The comment page cursor is invalid."); }
    }
    await publicRate(request, env);
    await requireVisible(env, productId, region);
    const rows = await env.DB.prepare(`SELECT ${columns} FROM product_comments WHERE product_id = ? AND region = ? AND hidden = 0 AND deleted = 0
        AND NOT EXISTS (SELECT 1 FROM user_profiles author WHERE author.user_id = product_comments.user_id AND author.banned = 1)
        AND EXISTS (${visibleCommentProduct})
        ${cursor ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
        ORDER BY created_at DESC, id DESC LIMIT 25`).bind(productId, region, region, ...(cursor ? [cursor.time, cursor.time, cursor.id] : [])).all<CommentRow>();
    const items = rows.results.slice(0, 24);
    const last = items.at(-1);
    return { items: items.map(toComment), nextCursor: rows.results.length > 24 && last ? btoa(JSON.stringify({ id: last.id, time: last.createdAt })) : null };
}

export async function commentingInfo(request: Request, env: AppEnv, user: SessionUser, productId: string): Promise<CommentingInfo> {
    const region = regionOf(request);
    await commentRate(env, user, false);
    await requireVisible(env, productId, region);
    const eligible = await env.DB.prepare(eligibleProduct).bind(region, productId, user.id, user.id, region).first();
    const own = await env.DB.prepare(`SELECT ${columns}, hidden, deleted FROM product_comments WHERE product_id = ? AND user_id = ? AND region = ?
        AND EXISTS (${visibleCommentProduct})`).bind(productId, user.id, region, region).first<CommentRow>();
    return { eligible: Boolean(eligible) && !own?.hidden, comment: own && !own.deleted ? toComment(own) : null, hidden: Boolean(own?.hidden) };
}

export async function createComment(request: Request, env: AppEnv, user: SessionUser, productId: string): Promise<ProductComment> {
    const region = regionOf(request);
    const body = await jsonBody(request, commentInputSchema);
    await commentRate(env, user, true);
    await turnstile(request, env, body.turnstileToken, "comment");
    const timestamp = new Date().toISOString();
    const row = await env.DB.prepare(`INSERT INTO product_comments (id, product_id, user_id, region, author_name, body, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${eligibleProduct})
            AND (EXISTS (SELECT 1 FROM product_comments existing WHERE existing.product_id = ? AND existing.user_id = ? AND existing.region = ?)
                OR ((SELECT COUNT(*) FROM product_comments) < ? AND (SELECT COUNT(*) FROM product_comments WHERE product_id = ?) < ?))
        ON CONFLICT(product_id, user_id, region) DO UPDATE SET body = excluded.body, author_name = excluded.author_name, updated_at = excluded.updated_at, deleted = 0
            WHERE product_comments.deleted = 1 AND product_comments.hidden = 0
        RETURNING ${columns}`).bind(crypto.randomUUID(), productId, user.id, region, user.name, body.body, timestamp, timestamp,
        region, productId, user.id, user.id, region, productId, user.id, region, COMMENT_GLOBAL_MAX_ROWS, productId, COMMENT_PRODUCT_MAX_ROWS).first<CommentRow>();
    if (!row) throw new HttpError(409, "COMMENT_UNAVAILABLE", "A successful redemption is required and this comment must be available for posting.");
    return toComment(row);
}

export async function editComment(request: Request, env: AppEnv, user: SessionUser, commentId: string): Promise<ProductComment> {
    const region = regionOf(request);
    const body = await jsonBody(request, commentInputSchema);
    await commentRate(env, user, true);
    await turnstile(request, env, body.turnstileToken, "comment");
    const row = await env.DB.prepare(`UPDATE product_comments SET body = ?, author_name = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND region = ? AND deleted = 0 AND hidden = 0 AND ${buyerAllowed}
        AND EXISTS (${visibleCommentProduct})
        AND EXISTS (SELECT 1 FROM redemption_codes code WHERE code.product_id = product_comments.product_id AND code.redeemed_by = ? AND code.redeemed_region = ?)
        RETURNING ${columns}`).bind(body.body, user.name, new Date().toISOString(), commentId, user.id, region, user.id, region, user.id, region).first<CommentRow>();
    if (!row) throw new HttpError(409, "COMMENT_UNAVAILABLE", "This comment is not available for editing.");
    return toComment(row);
}

export async function deleteComment(request: Request, env: AppEnv, user: SessionUser, commentId: string): Promise<{ ok: true }> {
    const region = regionOf(request);
    await commentRate(env, user, true);
    const result = await env.DB.prepare(`UPDATE product_comments SET body = '', deleted = 1, updated_at = ?
        WHERE id = ? AND user_id = ? AND region = ? AND ${buyerAllowed}`).bind(new Date().toISOString(), commentId, user.id, region, user.id).run();
    if (!result.meta.changes) throw new HttpError(404, "COMMENT_NOT_FOUND", "This comment could not be found.");
    return { ok: true };
}

export async function moderateComment(request: Request, env: AppEnv, user: SessionUser, commentId: string): Promise<{ ok: true }> {
    const body = await jsonBody(request, moderationSchema);
    await commentRate(env, user, true);
    const timestamp = new Date().toISOString();
    const token = crypto.randomUUID();
    const result = await env.DB.batch([
        env.DB.prepare("UPDATE product_comments SET hidden = ?, updated_at = ? WHERE id = ? AND (? = 1 OR deleted = 0)").bind(body.hidden ? 1 : 0, timestamp, commentId, body.hidden ? 1 : 0),
        env.DB.prepare(`INSERT INTO audit_log(id, actor_id, action, target_id, region, reason, created_at)
            SELECT ?, ?, ?, id, region, ?, ? FROM product_comments WHERE id = ? AND hidden = ? AND updated_at = ? AND (? = 1 OR deleted = 0)`)
            .bind(token, user.id, body.hidden ? "comment.hide" : "comment.restore", body.reason, timestamp, commentId, body.hidden ? 1 : 0, timestamp, body.hidden ? 1 : 0),
    ]);
    if (!result[0].meta.changes) throw new HttpError(409, "COMMENT_UNAVAILABLE", "This comment is deleted or unavailable for moderation.");
    return { ok: true };
}

export async function reportComment(request: Request, env: AppEnv, user: SessionUser, commentId: string): Promise<{ ok: true }> {
    const region = regionOf(request);
    const body = await jsonBody(request, reportSchema);
    await reserve(env, [
        { key: `report:${user.id}`, limit: 10, windowSeconds: 86400 },
        { key: "comments:reports:global:day", limit: 2000, windowSeconds: 86400 },
    ]);
    const result = await env.DB.prepare(`INSERT INTO comment_reports(id,user_id,comment_id,reason,created_at)
        SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM comment_reports) < ? AND ${buyerAllowed}
            AND EXISTS (SELECT 1 FROM product_comments WHERE id = ? AND region = ? AND hidden = 0 AND deleted = 0
                AND NOT EXISTS (SELECT 1 FROM user_profiles author WHERE author.user_id = product_comments.user_id AND author.banned = 1)
                AND EXISTS (${visibleCommentProduct}))
        ON CONFLICT(user_id,comment_id) DO NOTHING`).bind(crypto.randomUUID(), user.id, commentId, body.reason, new Date().toISOString(),
        COMMENT_REPORT_GLOBAL_MAX_ROWS, user.id, commentId, region, region).run();
    if (!result.meta.changes) throw new HttpError(409, "COMMENT_REPORT_UNAVAILABLE", "This comment cannot be reported or was already reported by this account.");
    return { ok: true };
}
