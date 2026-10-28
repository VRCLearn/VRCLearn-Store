import type { AppEnv } from "../../../server/env";
import { allowedHost, secureResponse } from "../../../edge/respond";
import { serviceEnabled } from "../../../edge/budget";
import { authFailure } from "../../../worker/http";

function secureAuthResponse(response: Response): Response {
    const secured = secureResponse(response, response.headers.get("X-Request-ID") ?? crypto.randomUUID());
    secured.headers.set("Cache-Control", "no-store");
    return secured;
}

export const onRequest: PagesFunction<AppEnv> = async ({ request, env }) => {
    if (!allowedHost(request, env)) return secureAuthResponse(authFailure("NOT_FOUND", "Endpoint not found", 404));
    try {
        if (!await serviceEnabled(env)) return secureAuthResponse(authFailure("SERVICE_PAUSED", "Account operations are temporarily paused", 503, 60));
        const response = await env.AUTH.fetch(request);
        return secureAuthResponse(response);
    } catch {
        return secureAuthResponse(authFailure("SERVICE_UNAVAILABLE", "Account service is temporarily unavailable", 503, 60));
    }
};
