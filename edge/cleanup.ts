import type { AppEnv } from "../server/env";
import { releaseMediaStorage } from "../server/media";

type CleanupEnv = Pick<AppEnv, "DB" | "PRIVATE_MEDIA" | "PUBLIC_MEDIA">;

/** Fixed-size maintenance work; never recursively schedules or drains the whole catalog. */
export async function cleanupStaleMedia(env: CleanupEnv, now = Date.now()): Promise<{ privateDeleted: number; publicDeleted: number }> {
    const orphanCutoff = new Date(now - 86_400_000).toISOString();
    const draftCutoff = new Date(now - 30 * 86_400_000).toISOString();
    await env.DB.prepare(`UPDATE product_revisions SET status = 'withdrawn'
        WHERE id IN (SELECT r.id FROM product_revisions r JOIN products p ON p.latest_revision_id = r.id
        WHERE r.status IN ('draft','rejected') AND r.updated_at < ? AND (p.current_revision_id IS NULL OR p.current_revision_id != r.id) LIMIT 25)`).bind(draftCutoff).run();
    const publicRows = await env.DB.prepare(`SELECT pm.object_key FROM public_media pm
        JOIN product_revisions r ON r.id = pm.revision_id WHERE r.updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.product_id = pm.product_id AND p.region = pm.region AND p.revision_id = pm.revision_id AND p.media_token = pm.media_token AND p.active = 1)
        AND r.status != 'pending' ORDER BY pm.object_key LIMIT 25`).bind(orphanCutoff).all<{ object_key: string }>();
    for (const row of publicRows.results) {
        await env.PUBLIC_MEDIA.delete(row.object_key);
        await env.DB.prepare("DELETE FROM public_media WHERE object_key = ?").bind(row.object_key).run();
        await releaseMediaStorage(env, "public", row.object_key);
    }
    const privateRows = await env.DB.prepare(`SELECT m.id, m.private_key FROM media m WHERE m.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM public_media pm WHERE pm.media_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM products p JOIN product_revisions r ON r.product_id = p.id
            WHERE (r.id = p.current_revision_id OR (r.id = p.latest_revision_id AND (r.status != 'withdrawn' OR r.updated_at >= ?)))
            AND EXISTS (SELECT 1 FROM json_each(r.content_json, '$.mediaIds') images WHERE images.value = m.id))
        ORDER BY m.created_at LIMIT 25`).bind(orphanCutoff, draftCutoff).all<{ id: string; private_key: string }>();
    for (const row of privateRows.results) {
        // Claim before the external delete. Draft writes also reject retiring media,
        // so an upload cannot be attached between the orphan check and R2 deletion.
        const claim = await env.DB.prepare(`UPDATE media SET retiring = 1 WHERE id = ?
            AND NOT EXISTS (SELECT 1 FROM public_media pm WHERE pm.media_id = media.id)
            AND NOT EXISTS (SELECT 1 FROM products p JOIN product_revisions r ON r.product_id = p.id
                WHERE (r.id = p.current_revision_id OR (r.id = p.latest_revision_id AND (r.status != 'withdrawn' OR r.updated_at >= ?)))
                AND EXISTS (SELECT 1 FROM json_each(r.content_json, '$.mediaIds') images WHERE images.value = media.id))`).bind(row.id, draftCutoff).run();
        if (!claim.meta.changes) continue;
        await env.PRIVATE_MEDIA.delete(row.private_key);
        await env.DB.prepare("DELETE FROM media WHERE id = ?").bind(row.id).run();
        await releaseMediaStorage(env, "private", row.private_key);
    }
    const reservations = await env.DB.prepare(`SELECT bucket, object_key FROM media_storage_objects ledger WHERE created_at < ?
        AND ((bucket = 'private' AND NOT EXISTS (SELECT 1 FROM media m WHERE m.private_key = ledger.object_key))
          OR (bucket = 'public' AND NOT EXISTS (SELECT 1 FROM public_media pm WHERE pm.object_key = ledger.object_key)))
        ORDER BY created_at LIMIT 25`).bind(orphanCutoff).all<{ bucket: "private" | "public"; object_key: string }>();
    for (const row of reservations.results) {
        await (row.bucket === "private" ? env.PRIVATE_MEDIA : env.PUBLIC_MEDIA).delete(row.object_key);
        await releaseMediaStorage(env, row.bucket, row.object_key);
    }
    return { privateDeleted: privateRows.results.length, publicDeleted: publicRows.results.length };
}
