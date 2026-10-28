import type { ProductInput, Region } from "../shared/contracts";
import type { AppEnv } from "./env";
import { HttpError } from "./security";

export interface MediaRow {
    id: string;
    shop_id: string;
    product_id: string;
    private_key: string;
    content_type: string;
    size: number;
    width: number;
    height: number;
}

export async function reserveMediaStorage(env: Pick<AppEnv, "DB">, bucket: "private" | "public", key: string, size: number): Promise<void> {
    try {
        await env.DB.prepare("INSERT INTO media_storage_objects (bucket, object_key, size, created_at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM media_storage_objects WHERE bucket = ? AND object_key = ?)").bind(bucket, key, size, new Date().toISOString(), bucket, key).run();
    } catch (error) {
        if (error instanceof Error && error.message.includes("STORAGE_QUOTA_EXCEEDED")) throw new HttpError(429, "STORAGE_QUOTA_EXCEEDED", "The service storage allowance has been reached. Uploads and publication are paused.", 86400);
        throw error;
    }
}

export async function releaseMediaStorage(env: Pick<AppEnv, "DB">, bucket: "private" | "public", key: string): Promise<void> {
    await env.DB.prepare("DELETE FROM media_storage_objects WHERE bucket = ? AND object_key = ?").bind(bucket, key).run();
}

function uint24(data: Uint8Array, offset: number): number {
    return data[offset] + (data[offset + 1] << 8) + (data[offset + 2] << 16);
}

export function imageInfo(bytes: Uint8Array): { contentType: string; width: number; height: number } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let width = 0;
    let height = 0;
    let contentType = "";
    if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) && view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452) {
        width = view.getUint32(16);
        height = view.getUint32(20);
        contentType = "image/png";
    } else if (bytes.length >= 20 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
        let offset = 2;
        while (offset + 4 < bytes.length) {
            if (bytes[offset] !== 0xff) break;
            while (bytes[offset] === 0xff) offset++;
            const marker = bytes[offset++];
            if (marker === 0xd9 || marker === 0xda) break;
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
            if (offset + 2 > bytes.length) break;
            const length = view.getUint16(offset);
            if (length < 2 || offset + length > bytes.length) break;
            if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
                height = view.getUint16(offset + 3);
                width = view.getUint16(offset + 5);
                contentType = "image/jpeg";
                break;
            }
            offset += length;
        }
    } else if (bytes.length >= 30 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP" && view.getUint32(4, true) + 8 === bytes.length) {
        const kind = new TextDecoder().decode(bytes.slice(12, 16));
        if (kind === "VP8X" && bytes.length >= 30 && !(bytes[20] & 0x02)) {
            width = uint24(bytes, 24) + 1;
            height = uint24(bytes, 27) + 1;
        } else if (kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
            width = view.getUint16(26, true) & 0x3fff;
            height = view.getUint16(28, true) & 0x3fff;
        } else if (kind === "VP8L" && bytes[20] === 0x2f) {
            const bits = view.getUint32(21, true);
            width = (bits & 0x3fff) + 1;
            height = ((bits >>> 14) & 0x3fff) + 1;
        }
        contentType = "image/webp";
    }
    if (!contentType || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16777216) {
        throw new HttpError(400, "INVALID_IMAGE", "Upload a valid JPEG, PNG or non-animated WebP image, at most 16 megapixels and 8192 pixels per side.");
    }
    return { contentType, width, height };
}

export async function ownedMedia(env: AppEnv, productId: string, shopId: string, ids: string[]): Promise<MediaRow[]> {
    if (!ids.length) return [];
    const result = await env.DB.prepare(`SELECT * FROM media WHERE product_id = ? AND shop_id = ? AND retiring = 0 AND id IN (${ids.map(() => "?").join(",")})`).bind(productId, shopId, ...ids).all<MediaRow>();
    if (result.results.length !== ids.length) throw new HttpError(400, "INVALID_MEDIA", "One or more images do not belong to this product.");
    return ids.map((id) => result.results.find((row) => row.id === id)!);
}

export async function publishMedia(env: AppEnv, productId: string, revisionId: string, submissionToken: string, shopId: string, content: ProductInput, regions: Region[]): Promise<void> {
    if (content.r18 && regions.includes("cn")) throw new HttpError(400, "ADULT_CN_FORBIDDEN", "Adult products cannot be published in China mainland.");
    const media = await ownedMedia(env, productId, shopId, content.mediaIds);
    for (const item of media) {
        const object = await env.PRIVATE_MEDIA.get(item.private_key);
        if (!object) throw new HttpError(409, "MEDIA_UNAVAILABLE", "A product image has expired. Upload it again before publishing.");
        if (object.size > 2097152 || object.size !== item.size) throw new HttpError(500, "MEDIA_SIZE_INVALID", "An image could not be safely published.");
        const buffer = await object.arrayBuffer();
        if (buffer.byteLength > 2097152) throw new HttpError(500, "MEDIA_SIZE_INVALID", "An image could not be safely published.");
        for (const region of regions) {
            const key = `${region}/${productId}/${revisionId}/${submissionToken}/${item.id}`;
            await reserveMediaStorage(env, "public", key, buffer.byteLength);
            await env.PUBLIC_MEDIA.put(key, buffer, { httpMetadata: { contentType: item.content_type, cacheControl: "public, max-age=60, s-maxage=60" } });
            await env.DB.prepare("INSERT OR IGNORE INTO public_media (product_id, region, revision_id, media_id, media_token, object_key) VALUES (?, ?, ?, ?, ?, ?)").bind(productId, region, revisionId, item.id, submissionToken, key).run();
        }
    }
}

export async function deletePublicMedia(env: AppEnv, productId: string, region?: Region, onlyRevision?: string, onlyToken?: string): Promise<void> {
    const where = ["product_id = ?"];
    const values: string[] = [productId];
    if (region) { where.push("region = ?"); values.push(region); }
    if (onlyRevision) { where.push("revision_id = ?"); values.push(onlyRevision); }
    if (onlyToken) { where.push("media_token = ?"); values.push(onlyToken); }
    where.push("NOT EXISTS (SELECT 1 FROM publications p WHERE p.product_id = public_media.product_id AND p.region = public_media.region AND p.revision_id = public_media.revision_id AND p.media_token = public_media.media_token AND p.active = 1)");
    const rows = await env.DB.prepare(`SELECT object_key FROM public_media WHERE ${where.join(" AND ")} LIMIT 101`).bind(...values).all<{ object_key: string }>();
    if (rows.results.length > 100) throw new HttpError(503, "MEDIA_CLEANUP_REQUIRED", "Media cleanup is required before this operation can complete.");
    await deleteMediaKeys(env, rows.results.map((row) => row.object_key));
}

export async function deleteMediaKeys(env: AppEnv, keys: string[]): Promise<void> {
    if (keys.length) {
        // Delete only keys captured above; a concurrent publication may add other keys.
        // Recheck each reference immediately before deleting its immutable object key.
        for (const key of keys) {
            const active = await env.DB.prepare("SELECT 1 AS active FROM public_media m JOIN publications p ON p.product_id = m.product_id AND p.region = m.region AND p.revision_id = m.revision_id AND p.media_token = m.media_token AND p.active = 1 WHERE m.object_key = ?").bind(key).first();
            if (active) continue;
            await env.PUBLIC_MEDIA.delete(key);
            await env.DB.prepare("DELETE FROM public_media WHERE object_key = ? AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.product_id = public_media.product_id AND p.region = public_media.region AND p.revision_id = public_media.revision_id AND p.media_token = public_media.media_token AND p.active = 1)").bind(key).run();
            await releaseMediaStorage(env, "public", key);
        }
    }
}
