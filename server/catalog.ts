import { z } from "zod";
import type { Locale, PageResult, Product, ProductInput, Region, Shop, ShopInput } from "../shared/contracts";
import type { AppEnv } from "./env";
import { HttpError, mode, publicRate, regionOf } from "./security";
import { ftsQuery } from "./validation";

interface PublicRow {
    id: string;
    shop_id: string;
    revision_id: string;
    media_token: string;
    content_json: string;
    shop_json: string;
    updated_at: string;
    score?: number;
    sort_price?: number;
}

const publicFrom = `FROM publications p
    JOIN products g ON g.id = p.product_id AND g.current_revision_id = p.revision_id
    JOIN product_revisions r ON r.id = p.revision_id AND r.status = 'published'
    JOIN shops s ON s.id = g.shop_id
    JOIN shop_revisions sr ON sr.id = s.current_revision_id AND sr.status = 'approved'
    JOIN regional_permissions perm ON perm.shop_id = s.id AND perm.region = p.region AND perm.status = 'approved'
    LEFT JOIN user_profiles owner ON owner.user_id = s.owner_user_id`;
const publicColumns = `g.id, g.shop_id, p.revision_id, p.media_token, r.content_json, sr.content_json AS shop_json, p.updated_at`;
const publicWhere = `p.region = ? AND p.active = 1 AND COALESCE(owner.banned, 0) = 0`;

export function toProduct(row: PublicRow, region: Region, env: AppEnv): Product {
    const content = JSON.parse(row.content_json) as ProductInput;
    const shop = JSON.parse(row.shop_json) as ShopInput;
    return {
        ...content, id: row.id, shopId: row.shop_id, shopName: shop.name, updatedAt: row.updated_at,
        images: content.mediaIds.map((id) => `${env.MEDIA_ORIGIN}/${region}/${row.id}/${row.revision_id}/${row.media_token}/${id}`),
    };
}

const cursorSchema = z.object({ id: z.string().uuid(), time: z.string().datetime(), value: z.number().finite().optional() }).strict();

export async function listProducts(request: Request, env: AppEnv, shopId?: string): Promise<PageResult<Product>> {
    await mode(env);
    const region = regionOf(request);
    await publicRate(request, env);
    const url = new URL(request.url);
    const allowed = new Set(["q", "category", "tag", "model", "platform", "pricing", "currency", "sort", "cursor", "limit"]);
    for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw new HttpError(400, "INVALID_FILTER", "Unsupported search parameter.");
    const limitValue = url.searchParams.get("limit") ?? "24";
    if (!/^\d+$/.test(limitValue) || Number(limitValue) < 1 || Number(limitValue) > 48) throw new HttpError(400, "INVALID_LIMIT", "The page size must be between 1 and 48.");
    const limit = Number(limitValue);
    const query = url.searchParams.get("q")?.trim();
    if (query && ([...query].length < 2 || [...query].length > 80)) throw new HttpError(400, "INVALID_QUERY", "Search queries must contain 2–80 characters.");
    const sort = url.searchParams.get("sort") ?? (query ? "relevance" : "latest");
    if (!["relevance", "latest", "price_asc", "price_desc"].includes(sort)) throw new HttpError(400, "INVALID_SORT", "Unsupported sort order.");
    const priceSort = sort.startsWith("price_");
    if (priceSort && !/^[A-Z]{3}$/.test(url.searchParams.get("currency") ?? "")) throw new HttpError(400, "CURRENCY_REQUIRED", "Select one currency before sorting by price.");
    let cursor: z.infer<typeof cursorSchema> | undefined;
    const rawCursor = url.searchParams.get("cursor");
    if (rawCursor) {
        try {
            if (rawCursor.length > 512) throw new Error();
            cursor = cursorSchema.parse(JSON.parse(atob(rawCursor)));
        } catch { throw new HttpError(400, "INVALID_CURSOR", "The page cursor is invalid."); }
    }
    let from = publicFrom;
    let columns = publicColumns;
    const where: string[] = [publicWhere];
    const values: (string | number)[] = [];
    const match = query ? ftsQuery(query) : "";
    if (query && !match) return { items: [], nextCursor: null };
    const relevance = Boolean(query && sort === "relevance");
    if (query) {
        from = `${publicFrom} JOIN product_search fts ON fts.product_id = g.id`;
        where.push("product_search MATCH ?");
    }
    values.push(region);
    if (query) values.push(match);
    if (shopId) { where.push("s.id = ?"); values.push(shopId); }
    for (const parameter of ["category", "pricing", "currency"]) {
        const value = url.searchParams.get(parameter);
        if (value) {
            if (value.length > 100) throw new HttpError(400, "INVALID_FILTER", "A filter is too long.");
            where.push(`p.${parameter} = ?`);
            values.push(parameter === "currency" ? value.toUpperCase() : value.toLowerCase());
        }
    }
    for (const [parameter, kind] of [["tag", "tag"], ["model", "model"], ["platform", "platform"]]) {
        const value = url.searchParams.get(parameter);
        if (value) {
            if (value.length > 100) throw new HttpError(400, "INVALID_FILTER", "A filter is too long.");
            where.push("EXISTS (SELECT 1 FROM product_facets pf WHERE pf.product_id = g.id AND pf.kind = ? AND pf.value = ?)");
            values.push(kind, value.normalize("NFKC").toLowerCase());
        }
    }
    let ordering = "p.updated_at DESC, p.product_id DESC";
    if (relevance) {
        columns += ", fts.rank AS score";
        ordering = "fts.rank ASC, g.id DESC";
        if (cursor) {
            if (cursor.value === undefined) throw new HttpError(400, "INVALID_CURSOR", "The cursor does not match this sort order.");
            where.push("(fts.rank > ? OR (fts.rank = ? AND g.id < ?))");
            values.push(cursor.value, cursor.value, cursor.id);
        }
    } else if (priceSort) {
        const expression = "p.price";
        columns += `, ${expression} AS sort_price`;
        ordering = `${expression} ${sort === "price_asc" ? "ASC" : "DESC"}, p.product_id DESC`;
        if (cursor) {
            if (cursor.value === undefined) throw new HttpError(400, "INVALID_CURSOR", "The cursor does not match this sort order.");
            where.push(`(${expression} ${sort === "price_asc" ? ">" : "<"} ? OR (${expression} = ? AND g.id < ?))`);
            values.push(cursor.value, cursor.value, cursor.id);
        }
    } else if (cursor) {
        where.push("(p.updated_at < ? OR (p.updated_at = ? AND g.id < ?))");
        values.push(cursor.time, cursor.time, cursor.id);
    }
    values.push(limit + 1);
    const result = await env.DB.prepare(`SELECT ${columns} ${from} WHERE ${where.join(" AND ")} ORDER BY ${ordering} LIMIT ?`).bind(...values).all<PublicRow>();
    const rows = result.results.slice(0, limit);
    const last = rows.at(-1);
    return {
        items: rows.map((row) => toProduct(row, region, env)),
        nextCursor: result.results.length > limit && last ? btoa(JSON.stringify({ id: last.id, time: last.updated_at, ...(relevance ? { value: last.score } : priceSort ? { value: last.sort_price } : {}) })) : null,
    };
}

export async function getProduct(request: Request, env: AppEnv, id: string): Promise<Product> {
    await mode(env);
    const region = regionOf(request);
    await publicRate(request, env);
    const row = await env.DB.prepare(`SELECT ${publicColumns} ${publicFrom} WHERE ${publicWhere} AND g.id = ? LIMIT 1`).bind(region, id).first<PublicRow>();
    if (!row) throw new HttpError(404, "PRODUCT_NOT_FOUND", "This product is not available in your region.");
    return toProduct(row, region, env);
}

export async function getShop(request: Request, env: AppEnv, id: string): Promise<Shop> {
    await mode(env);
    const region = regionOf(request);
    await publicRate(request, env);
    const row = await env.DB.prepare(`SELECT s.id, sr.content_json FROM shops s
        JOIN shop_revisions sr ON sr.id = s.current_revision_id AND sr.status = 'approved'
        JOIN regional_permissions perm ON perm.shop_id = s.id AND perm.region = ? AND perm.status = 'approved'
        LEFT JOIN user_profiles owner ON owner.user_id = s.owner_user_id
        WHERE s.id = ? AND COALESCE(owner.banned, 0) = 0 LIMIT 1`).bind(region, id).first<{ id: string; content_json: string }>();
    if (!row) throw new HttpError(404, "SHOP_NOT_FOUND", "This shop is not available in your region.");
    return { id: row.id, ...JSON.parse(row.content_json) as ShopInput };
}

export async function sitemap(request: Request, env: AppEnv, locale: Locale = "en"): Promise<string[]> {
    await mode(env);
    const region = regionOf(request);
    await publicRate(request, env);
    const rows = await env.DB.prepare(`SELECT g.id, g.shop_id ${publicFrom} WHERE ${publicWhere} ORDER BY g.id LIMIT 10001`).bind(region).all<{ id: string; shop_id: string }>();
    if (rows.results.length > 10000) throw new HttpError(503, "SITEMAP_CAPACITY", "The sitemap must be partitioned before serving this catalog size.");
    const urls = rows.results.map((row) => `${env.ORIGIN}/${locale}/products/${row.id}`);
    for (const id of new Set(rows.results.map((row) => row.shop_id))) urls.push(`${env.ORIGIN}/${locale}/shops/${id}`);
    return urls;
}
