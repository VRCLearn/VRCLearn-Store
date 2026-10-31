import { z } from "zod";
import type { PageResult, Redemption, RedemptionInventory, SessionUser } from "../shared/contracts";
import { redemptionCodeSchema, redemptionEntriesSchema, REDEMPTION_GLOBAL_MAX_CODES, REDEMPTION_IMPORT_MAX_BYTES, REDEMPTION_PRODUCT_MAX_CODES, REDEMPTION_SHOP_MAX_CODES } from "../shared/redemption";
import type { AppEnv } from "./env";
import { HttpError, jsonBody, regionOf, reserve, turnstile } from "./security";
import { publicFrom, publicWhere } from "./catalog";

const importSchema = z.object({ entries: redemptionEntriesSchema, turnstileToken: z.string().min(1).max(2048) }).strict();
const redeemSchema = z.object({ code: redemptionCodeSchema, turnstileToken: z.string().min(1).max(2048) }).strict();
const cursorSchema = z.object({ id: z.string().uuid(), time: z.string().datetime() }).strict();

// Match the catalog's complete publication checks at the actual SQL read/write,
// rather than trusting a public response or a preflight that can become stale.
const visibleProduct = `SELECT g.id ${publicFrom} WHERE ${publicWhere}
    AND g.id = redemption_codes.product_id AND s.id = redemption_codes.shop_id`;

async function ownedProduct(env: AppEnv, user: SessionUser, productId: string): Promise<{ shop_id: string }> {
    const product = await env.DB.prepare(`SELECT p.shop_id FROM products p JOIN shops s ON s.id = p.shop_id
        WHERE p.id = ? AND s.owner_user_id = ?`).bind(productId, user.id).first<{ shop_id: string }>();
    if (!product) throw new HttpError(404, "PRODUCT_NOT_FOUND", "This product could not be found.");
    return product;
}

async function digest(value: string): Promise<string> {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function redemptionRate(request: Request, env: AppEnv, user: SessionUser, writing: boolean): Promise<void> {
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip) throw new HttpError(403, "CLIENT_UNVERIFIED", "The request could not be verified at the service edge.");
    const ipHash = await digest(ip);
    await reserve(env, writing ? [
        { key: `redeem:user:${user.id}:minute`, limit: 6, windowSeconds: 60 },
        { key: `redeem:user:${user.id}:day`, limit: 100, windowSeconds: 86400 },
        { key: `redeem:ip:${ipHash}:minute`, limit: 20, windowSeconds: 60 },
        { key: "redeem:global:day", limit: 5000, windowSeconds: 86400 },
    ] : [
        { key: `redemptions:user:${user.id}:minute`, limit: 30, windowSeconds: 60 },
        { key: `redemptions:user:${user.id}:day`, limit: 1000, windowSeconds: 86400 },
        { key: `redemptions:ip:${ipHash}:minute`, limit: 60, windowSeconds: 60 },
        { key: "redemptions:global:day", limit: 45000, windowSeconds: 86400 },
    ]);
}

export async function codeInventory(env: AppEnv, user: SessionUser, productId: string): Promise<RedemptionInventory> {
    await reserve(env, [
        { key: `codes:inventory:${user.id}:minute`, limit: 30, windowSeconds: 60 },
        { key: `codes:inventory:${user.id}:day`, limit: 1000, windowSeconds: 86400 },
        { key: "codes:inventory:global:day", limit: 10000, windowSeconds: 86400 },
    ]);
    await ownedProduct(env, user, productId);
    const row = await env.DB.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(redeemed_by IS NOT NULL), 0) AS redeemed
        FROM redemption_codes WHERE product_id = ?`).bind(productId).first<{ total: number; redeemed: number }>();
    const total = row?.total ?? 0;
    const redeemed = row?.redeemed ?? 0;
    return { total, available: total - redeemed, redeemed };
}

export async function importCodes(request: Request, env: AppEnv, user: SessionUser, productId: string): Promise<{ imported: number }> {
    const product = await ownedProduct(env, user, productId);
    const body = await jsonBody(request, importSchema, REDEMPTION_IMPORT_MAX_BYTES);
    await reserve(env, [
        { key: `codes:import:${user.id}:hour`, limit: 10, windowSeconds: 3600 },
        { key: `codes:import:${user.id}:day`, limit: 1000, windowSeconds: 86400, amount: body.entries.length },
        { key: "codes:import:global:day", limit: 10000, windowSeconds: 86400, amount: body.entries.length },
    ]);
    await turnstile(request, env, body.turnstileToken, "import-codes");
    const entries = await Promise.all(body.entries.map(async (entry) => ({ id: crypto.randomUUID(), hash: await digest(`${productId}\n${entry.code}`), content: entry.content })));
    const encoded = JSON.stringify(entries);
    const timestamp = new Date().toISOString();
    // One INSERT SELECT makes the capacity and duplicate checks atomic with all
    // imported rows. A duplicate/capacity failure cannot leave a partial import.
    const result = await env.DB.prepare(`WITH permitted AS MATERIALIZED (SELECT 1 AS allowed WHERE
        EXISTS (SELECT 1 FROM products p JOIN shops s ON s.id = p.shop_id
            JOIN shop_revisions sr ON sr.id = s.current_revision_id AND sr.status = 'approved'
            WHERE p.id = ? AND s.id = ? AND s.owner_user_id = ?
                AND NOT EXISTS (SELECT 1 FROM user_profiles owner WHERE owner.user_id = s.owner_user_id AND owner.banned = 1)
                AND EXISTS (SELECT 1 FROM regional_permissions perm WHERE perm.shop_id = s.id AND perm.status = 'approved'))
        AND (SELECT COUNT(*) FROM redemption_codes WHERE product_id = ?) + ? <= ?
        AND (SELECT COUNT(*) FROM redemption_codes WHERE shop_id = ?) + ? <= ?
        AND (SELECT COUNT(*) FROM redemption_codes) + ? <= ?
        AND NOT EXISTS (SELECT 1 FROM redemption_codes existing JOIN json_each(?) incoming
            ON existing.code_hash = json_extract(incoming.value, '$.hash') WHERE existing.product_id = ?))
        INSERT INTO redemption_codes (id, product_id, shop_id, code_hash, delivery_content, imported_at)
        SELECT json_extract(entry.value, '$.id'), ?, ?, json_extract(entry.value, '$.hash'), json_extract(entry.value, '$.content'), ?
        FROM json_each(?) entry CROSS JOIN permitted
        RETURNING id`).bind(productId, product.shop_id, user.id,
        productId, entries.length, REDEMPTION_PRODUCT_MAX_CODES, product.shop_id, entries.length, REDEMPTION_SHOP_MAX_CODES,
        entries.length, REDEMPTION_GLOBAL_MAX_CODES, encoded, productId,
        productId, product.shop_id, timestamp, encoded).all<{ id: string }>();
    if (result.results.length !== entries.length) throw new HttpError(409, "CODE_IMPORT_CONFLICT", "No codes were imported. Check duplicates, inventory limits and approved publishing permission.");
    return { imported: result.results.length };
}

export async function redeemCode(request: Request, env: AppEnv, user: SessionUser, productId: string): Promise<Redemption> {
    const region = regionOf(request);
    const body = await jsonBody(request, redeemSchema);
    await redemptionRate(request, env, user, true);
    await turnstile(request, env, body.turnstileToken, "redeem");
    const hash = await digest(`${productId}\n${body.code}`);
    // The conditional UPDATE both claims and returns the private delivery. Only
    // the winner (or that same account repeating its request) can see the row.
    const result = await env.DB.prepare(`UPDATE redemption_codes SET
        redeemed_by = COALESCE(redeemed_by, ?), redeemed_at = COALESCE(redeemed_at, ?), redeemed_region = COALESCE(redeemed_region, ?),
        redeemed_title = COALESCE(redeemed_title, (SELECT json_extract(r.content_json, '$.title') FROM products p
            JOIN product_revisions r ON r.id = p.current_revision_id WHERE p.id = redemption_codes.product_id))
        WHERE product_id = ? AND code_hash = ? AND (redeemed_by IS NULL OR (redeemed_by = ? AND redeemed_region = ?))
            AND NOT EXISTS (SELECT 1 FROM user_profiles buyer WHERE buyer.user_id = ? AND buyer.banned = 1)
            AND EXISTS (${visibleProduct})
        RETURNING id, product_id AS productId, redeemed_title AS title, delivery_content AS content, redeemed_at AS redeemedAt`)
        .bind(user.id, new Date().toISOString(), region, productId, hash, user.id, region, user.id, region).first<Redemption>();
    if (!result) throw new HttpError(400, "CODE_UNAVAILABLE", "This code cannot be redeemed for this product in your region.");
    return result;
}

export async function listRedemptions(request: Request, env: AppEnv, user: SessionUser): Promise<PageResult<Redemption>> {
    const region = regionOf(request);
    const url = new URL(request.url);
    for (const key of url.searchParams.keys()) if (key !== "cursor") throw new HttpError(400, "INVALID_FILTER", "Unsupported redemption filter.");
    let cursor: z.infer<typeof cursorSchema> | undefined;
    const raw = url.searchParams.get("cursor");
    if (raw) {
        try {
            if (raw.length > 512) throw new Error();
            cursor = cursorSchema.parse(JSON.parse(atob(raw)));
        } catch { throw new HttpError(400, "INVALID_CURSOR", "The redemption page cursor is invalid."); }
    }
    await redemptionRate(request, env, user, false);
    const rows = await env.DB.prepare(`SELECT id, product_id AS productId, redeemed_title AS title,
        delivery_content AS content, redeemed_at AS redeemedAt FROM redemption_codes
        WHERE redeemed_by = ? AND redeemed_region = ? AND EXISTS (${visibleProduct})
            AND NOT EXISTS (SELECT 1 FROM user_profiles buyer WHERE buyer.user_id = ? AND buyer.banned = 1)
            ${cursor ? "AND (redeemed_at < ? OR (redeemed_at = ? AND id < ?))" : ""}
        ORDER BY redeemed_at DESC, id DESC LIMIT 25`).bind(user.id, region, region, user.id,
        ...(cursor ? [cursor.time, cursor.time, cursor.id] : [])).all<Redemption>();
    const items = rows.results.slice(0, 24);
    const last = items.at(-1);
    return { items, nextCursor: rows.results.length > 24 && last ? btoa(JSON.stringify({ id: last.id, time: last.redeemedAt })) : null };
}
