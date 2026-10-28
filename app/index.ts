import type { AppEnv } from "../server/env";
import { handleApi } from "../server/api";
import { detailPage, sitemapPage } from "../edge/ssr";
import { allowedHost, secureResponse } from "../edge/respond";
import { authFailure } from "../worker/http";
import { authRouteMethod } from "../shared/auth-routes";

function notFound(head: boolean): Response {
    return secureResponse(new Response(head ? null : "Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    }));
}

function authResponse(response: Response, head = false): Response {
    const secured = secureResponse(new Response(head ? null : response.body, response), response.headers.get("X-Request-ID") ?? crypto.randomUUID());
    secured.headers.set("Cache-Control", "no-store");
    return secured;
}

export default {
    async fetch(request, env, ctx): Promise<Response> {
        // Existing assets bypass this entrypoint. Missing assets and unknown paths
        // can still reach it, and must return before any business binding is used.
        const path = new URL(request.url).pathname;
        const detail = /^\/(en|zh-CN|ja)\/(products|shops)\/[^/]+$/.exec(path);
        const api = path === "/api/v1" || path.startsWith("/api/v1/");
        const auth = path.startsWith("/api/auth/");
        const sitemap = path === "/sitemap.xml" || /^\/sitemaps\/(en|zh-CN|ja)\.xml$/.test(path);
        if ((!api && !auth && !detail && !sitemap) || !allowedHost(request, env)) return notFound(request.method === "HEAD");

        if (api) {
            const response = await handleApi(request, env, ctx);
            return secureResponse(new Response(request.method === "HEAD" ? null : response.body, response));
        }
        if (detail) return detailPage({ request, env, ctx }, detail[2] === "products" ? "product" : "shop");
        if (sitemap) return sitemapPage({ request, env, ctx });
        const method = authRouteMethod(path);
        if (!method) return authResponse(authFailure("NOT_FOUND", "Endpoint not found", 404), request.method === "HEAD");
        if (request.method !== method) {
            const response = authFailure("METHOD_NOT_ALLOWED", "Method not allowed", 405);
            response.headers.set("Allow", method);
            return authResponse(response, request.method === "HEAD");
        }
        try {
            return authResponse(await env.AUTH.fetch(request));
        } catch {
            return authResponse(authFailure("SERVICE_UNAVAILABLE", "Account service is temporarily unavailable", 503, 60));
        }
    },
} satisfies ExportedHandler<AppEnv>;
