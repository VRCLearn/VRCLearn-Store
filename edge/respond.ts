import type { AppEnv } from "../server/env";

export function secureResponse(response: Response, requestId = crypto.randomUUID()): Response {
    const secured = new Response(response.body, response);
    secured.headers.set("X-Content-Type-Options", "nosniff");
    secured.headers.set("X-Frame-Options", "DENY");
    secured.headers.set("Referrer-Policy", "no-referrer");
    secured.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    secured.headers.set("X-Request-ID", requestId);
    return secured;
}

export function allowedHost(request: Request, env: AppEnv): boolean {
    const current = new URL(request.url);
    return current.origin === env.ORIGIN;
}

export function unavailable(status = 503): Response {
    return new Response("VRCLearn Store is temporarily unavailable. 商店暂时不可用。", {
        status,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "60", "X-Robots-Tag": "noindex" }
    });
}
