import type { SupportEnv } from "./env";
import { createAuth, getSessionUser, handleAuth } from "./auth";
import { failure } from "./http";
import { runMonitor } from "./monitor";
import { cleanupStaleMedia } from "../edge/cleanup";
import { cleanupExpiredAuth } from "./session-cleanup";
export { QuotaGate } from "./quota";

export default {
    async fetch(request, env): Promise<Response> {
        try {
            const path = new URL(request.url).pathname;
            if (path === "/internal/session" && request.method === "GET") {
                return Response.json(await getSessionUser(createAuth(env), env, request.headers), { headers: { "Cache-Control": "no-store" } });
            }
            if (path.startsWith("/api/auth/")) return await handleAuth(request, env);
            return failure("NOT_FOUND", "Endpoint not found", 404);
        } catch {
            // No request body, cookies, credentials, email or tokens are logged.
            console.warn(JSON.stringify({ event: "support_request_failed" }));
            return failure("SERVICE_UNAVAILABLE", "Account service is temporarily unavailable", 503);
        }
    },
    async scheduled(_controller, env, ctx): Promise<void> {
        ctx.waitUntil((async () => {
            try { await runMonitor(env); }
            catch { console.warn(JSON.stringify({ event: "budget_check_failed" })); }
            try { await cleanupStaleMedia(env); }
            catch { console.warn(JSON.stringify({ event: "media_cleanup_failed" })); }
            try { await cleanupExpiredAuth(env); }
            catch { console.warn(JSON.stringify({ event: "auth_cleanup_failed" })); }
        })());
    },
} satisfies ExportedHandler<SupportEnv>;
