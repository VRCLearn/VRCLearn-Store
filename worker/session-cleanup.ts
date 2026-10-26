import type { SupportEnv } from "./env";

export async function cleanupExpiredAuth(env: SupportEnv, now = Date.now()): Promise<void> {
    const cutoff = new Date(now).toISOString();
    // Better Auth's SQLite adapter persists dates as ISO strings. Both scans use
    // expiry indexes and bounded batches; user accounts are never removed here.
    await env.DB.batch([
        env.DB.prepare("DELETE FROM auth_verification WHERE id IN (SELECT id FROM auth_verification WHERE expiresAt < ? ORDER BY expiresAt LIMIT 100)").bind(cutoff),
        env.DB.prepare("DELETE FROM auth_session WHERE id IN (SELECT id FROM auth_session WHERE expiresAt < ? ORDER BY expiresAt LIMIT 100)").bind(cutoff),
        env.DB.prepare("DELETE FROM auth_mfa_sessions WHERE session_id IN (SELECT session_id FROM auth_mfa_sessions WHERE expires_at < ? ORDER BY expires_at LIMIT 100)").bind(now),
    ]);
}
